# Feature 08 · 邮件类型适配器

> 对应里程碑：M4（在验证码 / 总结之后）。
>
> 目标：把「一封邮件只能是一个 `AiOutput`」改成「一封邮件可以命中多个**类型适配器**」，
> 内置验证码 / 确认邮件 / 总结，支持用户自定义类型，并把「广告 / 紧急」这类**邮件自身状态**
> 从 AI 输出里独立出来，做成位掩码（一个值表达多个状态）。
>
> 相关：[`design/ai-prompt-design.md`](../design/ai-prompt-design.md)、
> [`design/data-model.md`](../design/data-model.md)、
> [`design/ui-flows.md`](../design/ui-flows.md)、
> [`decisions/adr-0006-mail-type-adapters.md`](../decisions/adr-0006-mail-type-adapters.md)。

---

## 0. 一句话

**适配器 = 类型 + 提示词 + 开关 + 优先级。**
AI 一次调用读完整封邮件，按照所有启用的适配器提示词，输出**命中的类型数组**；
每个类型带自己的结构化数据（验证码 / 确认链接 / 一段文本）。
「总结」也变成一个适配器，并且是**兜底**：只有没有任何其它类型命中时才生成。

---

## 1. 目标 / 非目标

### 1.1 目标

| # | 目标 |
| --- | --- |
| G1 | 内置「验证码」「确认邮件」「总结」三个类型；前两个有专属 UI |
| G2 | 一封邮件可以同时命中多个类型（验证码 + 一键确认链接是典型场景） |
| G3 | 用户可以新增 / 编辑 / 删除自定义类型，每个类型一段提示词 |
| G4 | 优先级用「可叠加 / 兜底」表达：验证码命中时不再生成总结 |
| G5 | 极简模式 = 固定启用「验证码 + 确认」；自定义模式 = 用户自己配 |
| G6 | 广告 / 紧急 / 低优先级变成邮件级**位掩码状态**，不再是 AI 输出里的 `isAd` / `urgency` |
| G7 | 确认邮件卡片只保留一个按钮；有明确有效期时显示倒计时 |
| G8 | 列表的筛选标签 = 邮件状态标签 + 适配器标签（内置 + 自定义） |
| G9 | 老数据（只有 `ai.code` / `ai.summary`）继续能读、能渲染 |

### 1.2 非目标

- 不为自定义类型做专属 UI（自定义类型的产出就是一段 AI 文本）。
- 不做「每个适配器单独调用一次 AI」—— 一次邮件只调一次。
- 不做确认邮件的 toast（产品决定：确认只在 Popup / Sidepanel 里操作）。
- 不做自动打开确认链接、不做链接预取。
- 不改账号 / 同步 / 回收站 / 广告过滤的底层语义。

---

## 2. 名词

| 术语 | 含义 |
| --- | --- |
| **适配器 Adapter** | 一个类型的定义：id、名称、提示词、启用状态、优先级、是否兜底 |
| **类型命中 Match** | 某封邮件命中了某个适配器，以及抽出来的数据 |
| **邮件状态 State flags** | 邮件自身的内部标签：广告 / 紧急 / 低优先级。位掩码，一个数字可含多个 |
| **极简模式** | 强制只启用内置「验证码」+「确认邮件」；适配器开关锁定 |
| **自定义模式** | 用户自由启用 / 排序 / 新增 / 编辑适配器 |
| **兜底 fallback** | 仅当没有任何「非兜底」类型命中时才输出；多个兜底只保留优先级最高的一个 |

---

## 3. 数据模型

### 3.1 邮件状态标签（位掩码）

```ts
export const MailStateFlag = {
  None: 0,
  /** 营销 / 推广 / 自动通知（原 AiOutput.isAd） */
  Ad: 1 << 0,
  /** 需要立刻处理（原 urgency = 'high'） */
  Urgent: 1 << 1,
  /** 低优先级（原 urgency = 'low'） */
  LowPriority: 1 << 2,
} as const

export const MAIL_STATE_ALL
  = MailStateFlag.Ad | MailStateFlag.Urgent | MailStateFlag.LowPriority
```

- 存 `Mail.stateFlags: number`，**不再**存 `ai.isAd` / `ai.urgency`。
- `Urgent` 与 `LowPriority` 互斥；两个位同时出现时归一化为只保留 `Urgent`。
- 「重要」筛选是**派生条件**，不是位：
  `!Ad && (!LowPriority || 命中验证码/确认)`，且排除未处理 / 已 dismiss。
- AI 输出用**字符串数组** `states: ["ad", "urgent", "low"]`，由 JS 转成位掩码。
  **不要让模型算位运算**——它只会算错。

### 3.2 适配器

运行时视图（内置定义 + 用户覆盖合并后）：

```ts
interface MailTypeAdapter {
  id: string                 // 'builtin:code' | 'builtin:confirm' | 'builtin:summary' | 'custom:<id>'
  kind: 'builtin' | 'custom'
  ui: 'code' | 'confirm' | 'summary' | null   // null = 自定义，没有专属 UI
  name: string
  description: string
  enabled: boolean           // 极简模式下由模式覆盖，见 § 3.6
  priority: number           // 越小越靠前
  fallback: boolean          // true = 仅当没有非兜底类型命中时才输出
  prompt: string             // 判定 + 抽取规则（内置由代码给，自定义由用户写）
  userPrompt?: string        // 内置类型的「用户补充规则」
}
```

持久化层只存用户改动（内置用 override，自定义整条存）：

```ts
interface MailTypeRecord {
  id: string
  kind: 'builtin' | 'custom'
  enabled?: boolean          // 内置 override / 自定义状态
  userPrompt?: string        // 内置 override
  name?: string              // 自定义
  prompt?: string            // 自定义
  priority?: number          // 自定义
  fallback?: boolean         // 自定义
  createdAt: number
  updatedAt: number
}
```

**内置适配器不落库**（与内置默认规则同一套做法）：代码里是 catalog，用户改动是 override。
好处：新版本加内置类型不用写「播种」；清空数据后内置仍在；坏记录删掉即恢复默认。

### 3.3 类型命中

```ts
interface Expiry {
  /** 绝对失效时刻（epoch ms） */
  at: number
  /** 进度条分母（秒） */
  totalSeconds: number
}

type MailTypeMatch =
  | { kind: 'code', adapterId: string, adapterName: string, code: string, expiry?: Expiry }
  | { kind: 'confirm', adapterId: string, adapterName: string, url: string, host: string, label?: string, expiry?: Expiry }
  | { kind: 'summary', adapterId: string, adapterName: string, minimal: string, text: string }
  | { kind: 'custom', adapterId: string, adapterName: string, text: string }
```

- `adapterName` 冗余存储：适配器后来被改名 / 删除，历史邮件仍能显示当时的名字。
- 匹配按优先级排好序后再入库；UI 按数组顺序渲染。
- 验证码的 `expiry` 与顶层 `Mail.codeExpiresAt` / `codeValidForSeconds` **同源**，两者都写。

### 3.4 AiOutput

```ts
interface AiOutput {
  types: MailTypeMatch[]
  /** 兼容旧 UI 的派生字段（新代码尽量读 types） */
  minimal?: string
  summary?: string
  code?: string | null
  validForSeconds?: number | null
  degraded?: boolean
  error?: string
}
```

- `isAd` / `urgency` 从新 `AiOutput` 移除，迁到 `Mail.stateFlags`。
- 老数据归一化：`ai.isAd` / `ai.urgency` → `stateFlags`；`ai.code` / `ai.summary` → 合成 match。

### 3.5 Mail 新增字段

```ts
interface Mail {
  // ...
  /** 邮件内部状态标签（位掩码），见 § 3.1 */
  stateFlags: number
  /** 从 HTML / 正文抽到的链接（≤10，只留 http/https），给 AI 与确认按钮用 */
  links?: string[]
}
```

`Mail.code` 顶层字段保留（badge / 便宜的判据）；`MAIL_FIELDS` 同步加 `stateFlags` / `links`。

### 3.6 模式与适配器

| 模式 | 生效适配器 | 适配器页 |
| --- | --- | --- |
| **极简模式** | 强制 `builtin:code` + `builtin:confirm` 开启；其余一律关闭（含总结、全部自定义） | 只读：开关禁用、不能编辑 / 新增 / 排序 |
| **自定义模式** | 按用户保存的状态 | 可开关、编辑、新增、删除、排序 |

- 模式切换**不修改**已保存的适配器状态，只是生效层的覆盖（overlay）。
  这样「切到极简看一眼，再切回自定义」不会把用户精心配的开关清掉。
- 极简模式沿用原有瘦身策略：不存正文、保留 50 条、不跑自定义 / 总结。
- 模式字段仍用 `AppSettings.minimalMode: boolean`（`false` = 自定义），
  只改 UI 文案与生效逻辑，避免大范围迁移。

---

## 4. 内置适配器

| id | 名称 | UI | 默认 | 优先级 | 兜底 |
| --- | --- | --- | --- | --- | --- |
| `builtin:code` | 验证码 | 验证码面板 | 开 | 10 | 否 |
| `builtin:confirm` | 确认邮件 | 确认面板 | 开 | 20 | 否 |
| `builtin:summary` | 总结 | 摘要 / 展开区 | 开 | 999 | **是** |

### 4.1 验证码

- 提取一次性验证码 / OTP，只保留 `[A-Za-z0-9]{4,12}`。
- 一封邮件有多个验证码时：优先遵循「用户补充规则」；否则选与登录 / 验证动作最相关的那个，再否则第一个。
- 有效期：邮件明确写了时长 → `validForSeconds`；写了绝对时间 → `expiresAt`；
  两者都没有就不输出，**绝不猜**。
- 用户补充规则的典型用法：「邮件里有 A、B 两个验证码，只用 A」。

### 4.2 确认邮件

- 范围（v1）：注册确认 / 邮箱验证 / 账号激活。
- 只输出**主操作链接**；忽略退订、隐私政策、社交链接。
- URL 必须原样从邮件里抽，**不允许模型拼接 / 猜测**。
- 可选 `label`（按钮文案）与有效期（时长或绝对时间戳）。
- UI 一个按钮 + 目标域名；**不自动打开**；点击后新标签打开并标已读。
- 链接是凭据：只存本地、不写日志、不做预览请求。

### 4.3 总结

- 旧「每封必总结」的能力整体搬进这个适配器。
- 产出 `minimal`（列表一行）与 `text`（展开后的结构化摘要）。
- **兜底**：只有没有任何非兜底类型命中时才生成。所以验证码 / 确认命中时不会再有总结。
- 用户可以在自定义模式下关掉它；关掉后无类型命中的邮件列表回退 `snippet`。

### 4.4 自定义类型

- 用户填：名称、提示词、是否兜底；其余（数量、字数）**不设产品上限**。
- 产出只有 `custom.text`（一段 AI 文本），卡片里以「适配器名 + 文本」展示。
- 自定义类型默认不兜底；勾了「兜底」后与总结竞争，优先级靠前的那一个胜出。
- 不设个数 / 字数硬上限；配置页实时显示提示词总字数与估算 token。
  真正的限制是模型上下文：调用时正文预算会自动压缩，连最小正文都放不下时明确降级并给出原因。

---

## 5. AI 契约（一次调用、多标签）

### 5.1 为什么一次调用

- 成本：一封邮件只发一次正文。
- 一致性：验证码与确认链接来自同一次阅读，不会互相矛盾。
- 简单：不需要「先分类再抽取」的两段式编排。

代价：适配器提示词会随每封邮件一起发送。这是用户自己承担的成本，配置页会提示。

### 5.2 输出 JSON

```json
{
  "types": [
    { "adapterId": "builtin:code", "code": { "value": "123456", "validForSeconds": 300 } },
    { "adapterId": "builtin:confirm", "confirm": {
        "url": "https://example.com/confirm/...",
        "label": "Confirm your email",
        "expiresAt": "2026-10-22T13:16:48Z"
    } },
    { "adapterId": "custom:abc123", "custom": { "text": "..." } },
    { "adapterId": "builtin:summary", "summary": { "minimal": "...", "text": "..." } }
  ],
  "states": ["urgent"]
}
```

规则：

- `types` 只放**命中**的类型，不命中的不要出现。
- 同一个 `adapterId` 最多一次。
- `states` 可多选：`"ad"` / `"urgent"` / `"low"`；`urgent` 与 `low` 互斥。
- 不允许输出上面没列出的字段。

### 5.3 Prompt 结构

```text
[基础：只输出 JSON / 安全规则 / states 规则]
# 邮件类型（按优先级从高到低；可以同时命中多个）
## 1. 验证码（可叠加）
<内置提示词>
用户补充规则（优先遵守）：
<userPrompt>
## 2. 确认邮件（可叠加）
...
## 3. 自定义类型（可叠加 / 可选兜底）
<用户提示词>
## 4. 总结（兜底：上面没有任何类型命中时才输出）
...
[输出语言]
[命中的 PromptRule（最后，场景上下文）]
```

- 基础 schema 与 `states` 定义**不可被覆盖**。
- 用户提示词只能追加，不能改 JSON 结构。
- 邮箱正文截断沿用 `MAX_BODY_CHARS`，但预算要扣掉适配器提示词。

### 5.4 JS 侧二次校验（必须）

模型不可信。解析后必须：

1. 丢掉未启用 / 不存在 / 重复的 `adapterId`。
2. 按 kind 清洗：
   - code：`cleanCode`；有效期 `cleanValidForSeconds`；
   - confirm：`http/https` + 长度上限 + `new URL` 校验；`label` 截断；
   - summary / custom：长度截断，纯文本；
   - expiry：`validForSeconds` 与绝对时间戳二选一，统一成 `Expiry`。
3. 应用兜底：有非兜底命中 ⇒ 丢掉所有兜底；否则只留优先级最高的一个兜底。
4. 按适配器优先级排序。
5. 派生兼容字段 + 写 `Mail.codeExpiresAt` / `codeValidForSeconds`。

### 5.5 降级

AI 失败时：

- 用启发式提取验证码（现有 `heuristicCode`）合成 code match（仅当 code 适配器启用）。
- 总结适配器启用时，用现有 fallback 摘要合成 summary match。
- `stateFlags`：有 `List-Unsubscribe` → `Ad`；其它为 0。
- `degraded: true` + 原因，UI 显示「降级」角标。

极简模式沿用「拿不到验证码/确认就丢弃」的策略，不降级。

---

## 6. 流水线

### 6.1 自定义模式

```text
读 app / ai 设置 + 生效适配器 + 命中 PromptRule
  → 组 prompt
  → 一次 AI 调用
  → 解析 + 二次校验 + 兜底
  → 写 Mail（types / stateFlags / code 派生字段）
  → 有验证码：按 autoCopyCode / rule.alwaysCopyCode 自动复制 + toast
  → badge / mail:updated
```

### 6.2 极简模式

```text
预筛（验证码线索 OR 确认线索）
  → 只带 code + confirm 两个适配器的 AI 调用
  → 有命中才入库（瘦身记录，50 条上限）
  → 有验证码：自动复制 + toast
```

预筛必须扩展：只有 HTML 的确认邮件、`Please confirm your email address` 这类主题
要能通过，否则极简模式永远看不到确认邮件。

### 6.3 链接提取（前置改动）

现有 `htmlToText` 只保留 `<a>` 的文字，丢掉 `href`。只有 HTML 部分的确认邮件因此
拿不到链接。解析阶段需要新增：

- `ParsedMail.links` / `Mail.links`：HTML `href` + 正文裸 URL；
- 只留 `http/https`，去重，最多 10 条，单条 ≤2048；
- prompt 里单独列 `# Links`，并告诉模型「确认链接只能从这里或正文原样取」。

---

## 7. UI

### 7.1 卡片

```text
┌──────────────────────────────────────────┐
│ WakaTime · noreply@wakatime.com   3 分钟前 │
│ Please confirm your email address         │
│ ┌ 验证码 ──────────────────────────────┐ │
│ │ 483 921                       [复制] │ │
│ └──────────────────────────────────────┘ │
│ ┌ 确认邮件 ────────────────────────────┐ │
│ │ 请确认你的邮箱地址                    │ │
│ │ [ 打开确认链接 ]   wakatime.com       │ │
│ └──────────────────────────────────────┘ │
│ ┌ 账单提醒 ────────────────────────────┐ │
│ │ AI 文本…                              │ │
│ └──────────────────────────────────────┘ │
│ 验证码  4:32 有效                         │
│ 确认    23:59:12 有效                     │
└──────────────────────────────────────────┘
```

- 面板共用一套边框 / 圆角 / 内边距 / 字号；不做卡片套卡片。
- 验证码视觉权重最高，确认按钮其次，自定义文本最弱。
- 倒计时统一放卡片底部：
  - `CountdownBar` 单行；
  - `CountdownStrip` 容器，接受多个 `{ label, expiry }`；一个就是今天的样式，多个就叠行。
- 「总结」不渲染成面板：列表第二行 + 展开区复用旧位置。
- 广告弱化 / 紧急顶部色条继续由 `stateFlags` 驱动。

### 7.2 列表筛选

筛选标签 = 三类：

1. **状态标签**：`重要`（派生）、`营销`（Ad 位）。
2. **内置适配器**：`验证码`、`确认邮件`。
3. **自定义适配器**：用户的类型名。

- 动态生成，不再硬编码四个 tab；单选用 `a-tabs`，多了自动折叠。
- `全部` 永远在。
- `总结` 不作为筛选标签（它是兜底内容，不是用户要找的东西）。
- 点击某个适配器标签 = 筛出命中该适配器的邮件（含多类型同时命中的）。
- 极简模式保持平铺列表（验证码 + 确认），不显示筛选 tab。

### 7.3 适配器配置页

导航名：**适配器**。

- 卡片列表：内置（验证码 / 确认 / 总结）+ 自定义。
- 每张卡右上角 `switch`。
- 内置：名称 / 描述 / 基础提示词只读；可编辑「用户补充规则」、可恢复默认；不能删除。
- 自定义：可编辑名称 / 提示词 / 兜底、可删除、可上下移。
- 极简模式：所有开关与编辑操作禁用，顶部提示
  「极简模式固定启用验证码和确认邮件；切到自定义模式后可调整」。
- 底部显示提示词预算：总字数 + 估算 token + 一句「每封邮件都会带上这些提示词」。
  不设硬上限，不拦保存。

### 7.4 模式

- 文案：`极简模式` / `自定义`。
- 说明：
  - 极简：只启用验证码 + 确认，其他类型关闭；适配器配置锁定。
  - 自定义：自由启用 / 编辑 / 新增适配器，包含总结与自定义类型。
- 开关语义仍是「开 = 右侧（自定义）」。

### 7.5 确认按钮

- 文案「打开确认链接」，右侧/下方显示域名。
- 点击：`tabs.create({ url })` → 新标签打开 → 标已读。
- 只接受 `http/https`；存储时已校验，打开前再校验一次（纵深防御）。
- 不做 toast、不自动打开、不做链接预览。

---

## 8. 存储与迁移

- `DB_VERSION` 2 → 3，新增外部键仓库 `mailTypes`（无索引；条数很少）。
- 内置 catalog 在代码里；`mailTypes` 只存 override + 自定义。
- 老邮件归一化：
  - `ai.code` → 合成 `builtin:code` match；
  - `ai.summary` / `ai.minimal` → 合成 `builtin:summary` match；
  - `ai.isAd` / `ai.urgency` → `stateFlags`；
  - `types` 已存在则直接用。
- `popupDefaultTab` 从枚举变成字符串筛选 id：
  - 旧 `'code'` → `'adapter:builtin:code'`；
  - 旧 `'important' | 'all' | 'ad'` 原样；
  - 指向已删除的适配器时，Popup 回退到 `important`。
- 「清空所有数据」走 `deleteDatabase`，新仓库自动重建，不需要额外清理逻辑。
- 导入 / 导出暂不包含适配器（当前设置导出只覆盖账号 / 规则 / 设置；后续要做时单独加一版格式）。

---

## 9. 边界 / 安全 / 成本

| 场景 | 处理 |
| --- | --- |
| AI 输出未启用的适配器 | 丢弃（防止幻觉） |
| AI 输出两个验证码适配器命中 | 只留第一个，按优先级 |
| 确认链接是 `javascript:` / `data:` | 丢弃该 match |
| 确认链接超过 2048 字 | 丢弃该 match |
| 确认链接已过期 | 仍显示按钮 + 失效倒计时（用户可能还来得及） |
| 适配器提示词过长 | 不拦保存；调用时压缩正文，放不下则降级并说明原因 |
| 适配器被删除 | 历史 match 仍用存储时的 `adapterName` 渲染 |
| 极简模式切换 | 不修改保存的适配器状态，只覆盖生效层 |
| 多标签同时命中 | 面板按优先级堆叠；倒计时按优先级排 |
| 自定义类型数量很多 | 不设上限；筛选 tab 自动折叠；提示词预算提示 |

---

## 10. 验收清单

- [ ] 一封 WakaTime 确认邮件 → 命中「确认邮件」，卡片显示一个按钮 + 域名，不显示总结
- [ ] 一封同时含验证码和确认链接的邮件 → 两个面板同时出现在同一张卡片里
- [ ] 验证码命中时，总结适配器即使启用也不产出内容
- [ ] 用户关掉「总结」后，无类型命中的邮件列表回退 snippet
- [ ] 自定义类型命中 → 卡片显示「类型名 + AI 文本」
- [ ] 极简模式：只有验证码 / 确认两类；适配器页开关全部禁用；切到自定义后恢复用户配置
- [ ] 列表筛选出现「重要 / 全部 / 验证码 / 确认 / 自定义标签 / 营销」
- [ ] 确认按钮新标签打开、只接受 http/https、点击后邮件标已读
- [ ] 老邮件（只有 `ai.code`）仍显示验证码面板和复制按钮
- [ ] AI 失败时仍能拿到启发式验证码，且卡片显示「降级」
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

---

## 11. 决策记录

| 问题 | 决定 |
| --- | --- |
| 总结去留 | 变成内置适配器「总结」，默认兜底；`isAd` / `urgency` 独立成状态标签 |
| 优先级 | 内置固定顺序；自定义可上下移；语义是「可叠加 / 兜底」，不暴露数字 |
| 极简模式 | 保留；固定验证码 + 确认；开关锁定；切换不破坏自定义配置 |
| PromptRule | 保留；顺序 base → 适配器 → 命中规则 |
| 确认动作 | 一个按钮；新标签打开；显示域名；不自动打开；只做注册/验证/激活 |
| 确认 toast | 不做 |
| 确认有效期 | AI 从邮件内容（含链接）梳理；存绝对时刻 + 总时长 |
| 自定义限制 | 不限制个数；不设硬字数上限；只提示成本，调用时按上下文压缩 |
| 列表 | 状态标签 + 适配器标签 + 自定义标签，动态筛选 |
