# Open Questions · 待决策 / 待讨论

> 在动手前需要确认或对齐的事。每条都列出了 **默认建议** 与 **何时升级为 ADR**。
>
> 最近更新：
> - ~~通知策略~~ → **确认**：Badge + 页面顶部 Toast（详见 [`../design/page-toast.md`](../design/page-toast.md)）
> - ~~Q1 邮箱协议~~ → **已决定**：MailProvider 适配器 + MVP 实现 IMAP+密码
> - ~~Q2 凭证加密~~ → **已决定**：MVP 明文 + 明示"未加密"，M3+ 再考虑口令保护
> - ~~Q3 AI Provider~~ → **已决定**：多 provider 适配器（镜像 offer-hunter）
> - ~~Q4 流式~~ → **已决定**：非流式
> - ~~Q5 邮件存储~~ → **已决定**：**首次不拉历史**，UID 增量同步；保留数量用户可配 100/200/500/1000/无限
> - ~~Q6 多账号~~ → **已决定**：UI 单账号 + 逻辑多账号
> - ~~Q7 排除邮箱~~ → **已决定**：按账号独立
> - ~~Q11 上架~~ → **已决定**：无时间限制
> - ~~Q12 i18n~~ → **已决定**：MVP 中文 + i18n 钩子
> - ~~Q13 测试~~ → **已决定**：按默认建议
> - ~~Q16 浏览器~~ → **已决定**：Chrome + Firefox，参考 offer-hunter/src/manifest.ts
> - ~~Q17 AI 输出语言~~ → **已决定**：`auto-browser / auto-email` 二选一，默认 `auto-browser`
> - ~~Q18 极简模式~~ → **已决定**：**默认极简模式**；开关切换。极简模式只保留"验证码提取 + 自动复制"

---

## Q1. ~~邮箱接入：IMAP / Gmail OAuth / Outlook Graph？~~

**✅ 已决定（2026-XX-XX）**：
- 建 **`MailProvider` 适配器**，把协议差异压在抽象后面
- MVP 实现 `ImapProvider`（用户名 + 密码）
- 后续按需加 `GmailOAuthProvider` / `OutlookGraphProvider`
- 代码组织镜像 `offer-hunter/adapters/ai/platforms/<id>/index.ts`

> 新增 Provider = 加一个 `src/adapters/mail/providers/<id>/index.ts`，注册表按目录约定 glob。

---

## Q2. ~~凭证存储：明文 vs加密？~~

**✅ 已决定（2026-XX-XX）**：
- **MVP 明文**（IndexedDB 明文），与 offer-hunter 一致
- Settings 页加 "隐私声明" 卡片（明示"凭据未加密，请勿在公共电脑使用"）
- 写 "清空所有数据" 按钮（一键删 IDB）
- **M3+** 升级到可选口令保护（`crypto.subtle` AES-GCM + PBKDF2，从用户口令派生 key）

**评估记录**（不打算走加密的几条路）：

| 方案 | 否决原因 |
|---|---|
| `crypto.subtle` + 随机 key 存 storage | key 也在 disk 上，零额外保护 |
| `crypto.subtle` + 内置 key | 扩展源码可见，等于明文 |
| `crypto.subtle` + 用户口令派生 | 真正安全，但每次启动 / 每次心跳前都问 → 用户必骂 |
| profile 派生 key | 多 profile 切换/清数据就坏 |

> Web Crypto Subtle 在 MV3 SW 里是好用的；缺的是**既方便又安全**的 key 来源。

---

## Q3. ~~AI Provider 范围：OpenAI 兼容 only / 多 provider？~~

**✅ 已决定（2026-XX-XX）**：
- **多 provider**，架构镜像 `offer-hunter/adapters/ai/`：
  - `protocols/openai.ts` — wire 格式（OpenAI 兼容 → DeepSeek / 各类中转）
  - `protocols/anthropic.ts` — wire 格式（Anthropic）
  - `platforms/<id>/index.ts` — 每平台一个目录，导出 `defineAiPlatform({ ... })`
  - `platforms/index.ts` — 注册表（glob + 排序 + 工厂）
- **MVP 至少实现 4 家**：OpenAI、Anthropic、DeepSeek、自定义（Custom）
- 用户在 Options 选平台 + 填 key + 改 baseURL / model

详见 [`../design/ai-provider-adapter.md`](../design/ai-provider-adapter.md)（待写）。

---

## Q4. ~~AI 流式 vs 非流式？~~

**✅ 已决定（2026-XX-XX）**：**非流式**。AI 必须返回固定 JSON；流式拼接容易中途格式错。

---

## Q5. ~~邮件存储：100 封 / 滚动 / IndexedDB / chrome.storage.local？~~

**✅ 已决定（2026-XX-XX）**：

| 项目 | 决定 |
| --- | --- |
| 存储 | **IndexedDB**（不用 `chrome.storage.local`）—— 与 offer-hunter 一致 |
| 历史拉取 | **不拉取任何历史邮件**。首次连上 IMAP 只记录 `UIDNEXT`，之后增量同步 |
| IDB 保留数量 | **用户可配**：默认 100 / 200 / 500 / 1000 / 无限。**滚动淘汰**（超量删最旧） |
| 按时间清理 | 可选（默认关） |

数据模型 Schema 详见 [`../design/storage.md`](../design/storage.md)。

### 字段

```ts
type MailRetention = 100 | 200 | 500 | 1000 | 'unlimited'

interface MailAccount {
  // ... 其它字段
  lastSeenUid: number | null      // null = 从未同步过；首次连上后存当前 UIDNEXT
}

interface AppSettings {
  // ... 其它字段
  mailRetention: MailRetention    // 默认 100
}
```

### 同步策略（增量）

```
首次 sync：
  1. account.lastSeenUid == null
  2. 拿 server UIDNEXT → 存为 account.lastSeenUid
  3. 不拉任何邮件
  4. ✅

后续 sync：
  1. search UID ${lastSeenUid + 1}:*
  2. 只处理 raws；upsertMail 后更新 lastSeenUid
  3. ✅
```

> 邮箱服务器**不会**回收已发邮件的 UID；只要 lastSeenUid 持续推进，就能拿到所有增量。
> 注意：IMAP 服务器**可以**重置 UIDVALIDITY（极少见，发生在邮箱重建时）。生产代码要存 `UIDVALIDITY`，若变化 → 重置 `lastSeenUid` 并**提示"该账号历史可能丢失"**。MVP 可以先只 warning，不做完整恢复。

### UI

Options · 通用设置：

```
邮件保留数量:
  ◉ 100 条  (默认)
  ○ 200 条
  ○ 500 条
  ○ 1000 条
  ○ 无限

存储用量:  23 条 / 100 条上限   |   约 1.2 MB
[清空邮件列表] [立即同步增量]
```

> "立即同步增量"按钮：手动触发心跳；不拉历史、不重新跑 AI（只补漏掉的）。

### 与默认行为的差异

| | 旧文档 | 新文档 |
| --- | --- | --- |
| 首次连上 | 拉最近 100 封 | **不拉任何**，只记 UIDNEXT |
| 后续心跳 | 拉最近 100 封 | 拉 UID > lastSeenUid 的 |
| 保留数量 | 写死 100 | 用户可配：100 / 200 / 500 / 1000 / 无限 |

---

## Q6. ~~多账号 vs 单账号？~~

**✅ 已决定（2026-XX-XX）**：
- **逻辑上多账号**（`accounts` 仓库是数组 / 外键仓库）
- **UI 上单账号**（M1 / M2 不做账号切换；M3+ 视需求再加）

> 即便 UI 单账号，添加第 2 个账号的代码路径必须存在（不能为单账号写特判）。

---

## Q7. ~~排除邮箱：全局 vs per-account？~~

**✅ 已决定（2026-XX-XX）**：**per-account**，字段直接挂 `MailAccount.blockedList`。

详见 [`../features/06-blocked-senders.md`](../features/06-blocked-senders.md)。

---

## Q11. ~~上架时间？~~

**✅ 已决定（2026-XX-XX）**：无时间限制。先在 GitHub 提供开发版安装说明。

---

## Q12. ~~i18n？~~

**✅ 已决定（2026-XX-XX）**：
- MVP 文案集中 `src/logic/strings.ts`（按 key 导出，不在 Vue 模板里写硬编码字符串）
- 一期只交付中文（zh-CN）
- 结构预留 i18n 钩子（`t('key', { ...vars })`），M3+ 再接 vue-i18n / 自研

---

## Q13. ~~测试覆盖目标？~~

**✅ 已决定（2026-XX-XX）**：
- 核心逻辑（mail/ai/rules/idb）单测覆盖 80%
- UI 关键流程 Vitest
- Playwright E2E 配好但不强制

---

## Q16. ~~浏览器目标？~~

**✅ 已决定（2026-XX-XX）**：**Chrome + Firefox**，参考 [`D:\Projects\offer-hunter\src\manifest.ts`](https://github.com/)：

- `browser_specific_settings.gecko` + `strict_min_version: '109.0'`
- `data_collection_permissions: { required: ['none'] }`
- Chrome：`service_worker: 'dist/background/index.mjs'`
- Firefox：`scripts: ['dist/background/index.mjs'], type: 'module'`
- Sidepanel：Chrome `side_panel` / Firefox `sidebar_action`（互斥分支）
- CSP：dev 时放开 Vite 端口，prod 收紧

---

## Q17. ~~AI 输出语言：自动跟随 / 用户可设？~~

**详见上文 Q17**。

---

## Q18. ~~是否需要"极简模式"？~~

**✅ 已决定（2026-XX-XX）**：**默认极简模式**。开关在 Options · 通用设置 顶部。

### 三句话讲清楚

> **极简模式**：用户给一个邮箱 → 我们只做"看到验证码 → 自动复制进剪贴板 → 弹个小 toast 告诉用户"。其它一律不管。
>
> **完整功能**：打开开关后才解锁我们之前设计的所有能力（AI 总结、广告屏蔽、提示词、排除列表……）。

### 字段

```ts
interface AppSettings {
  // ... 其它
  minimalMode: boolean               // 默认 true
  autoCopyCode: boolean             // 默认 true；极简模式下**强制为 true**
  // ...
}
```

### 极简模式下"关掉什么"

| 能力 | 极简 | 完整 |
| --- | --- | --- |
| 邮箱连接 + IMAP 同步（增量） | ✅ | ✅ |
| 验证码识别 + 自动复制 | ✅ | ✅ |
| 页面顶部 Toast 反馈 | ✅ | ✅ |
| **AI 总结 / 广告判定 / 紧急程度** | ❌ | ✅ |
| **多 PromptRule 匹配** | ❌ | ✅ |
| **排除邮箱列表** | ❌ | ✅ |
| **排除广告开关** | ❌ | ✅ |
| **Popup / Sidepanel 邮件流（全部/重要/营销）** | ❌ | ✅ |
| **Popup / Sidepanel 仅验证码列表** | ✅ | ✅ |
| **icon badge 数字提示** | ❌（只 toast） | ✅ |
| **邮件正文 / 摘要 / 原始字节 入库** | ❌（只存 `code` + 关键 header） | ✅ |
| **设置项：AI 配置 / Prompt 规则 / 排除列表** | ❌（隐藏） | ✅ |
| **保留数量：用户可配** | ❌（写死 50 条验证码） | ✅ |

### 极简模式下的存储

`Mail` 记录在极简模式下被**瘦身**——只保留：

```ts
interface MinimalMail {
  id: string                  // 仍 = <accountId>:<messageId>
  accountId: string
  from: { name: string, address: string }[]   // 取第一个即可
  subject: string
  code: string                // 必填（非验证码邮件根本不入库）
  receivedAt: number
  copyStatus: 'copied' | 'failed' | 'none'
  read: boolean
  // 其余字段：null / undefined
}
```

> **实现路径**：用**同一个 `Mail` 表**，未用字段就是 `null` / 空字符串。`purseMail` 在极简模式下：
> - 拉到的 raw 先 regex 预筛（subject 含 "验证码" / "code" / "OTP" 等，或 body 有 `\d{4,8}` 的短数字串）；不命中 → **不存**
> - 命中 → 走极简 AI prompt（"从邮件里只提取验证码字符串，返回 JSON `{ code }`"）；没提到 → 不存
> - 提到 → 写最小记录 + 自动复制
>
> ⚠️ 同一份 `Mail` schema 不动；极简/完整两套只是写入时哪些字段填哪些不填。

### 极简模式下的 AI 调用

> 提示词极简版，1-2 句话就够（不是 for markdown，是够用即可）：

```text
你是验证码提取助手。阅读邮件，从正文/标题中提取一次性验证码 / OTP。
如果邮件中有验证码，返回 JSON: { "code": "<字母数字>" }。
如果没有任何验证码，返回 JSON: { "code": null }。
仅返回 JSON，不要解释。
```

> 节省 token、节省成本、节省时间。

### UI

#### Options · 通用设置（极简模式下）

```
┌─ 通用 ─────────────────────────────────┐
│ 模式:                                  │
│   ◉ 极简模式（仅验证码）              │
│   ○ 完整功能（AI 总结 + 屏蔽 + …）    │
│                                        │
│ [✓] 验证码自动复制                       │
│                                        │
│ ───────────────────                    │
│ 账号 · me@my-domain.com                │
│ 验证码记录: 12 条                       │
│ [清空所有数据]                          │
└────────────────────────────────────────┘
```

> 极简模式下**只显示**这一页；切到"完整功能"后其它 5 个子页才出现（账号 / 提示词 / AI 配置 / 屏蔽列表 / 关于）。

#### Options · 通用设置（完整模式下）

> 之前的 4.6 节（不重复）。

#### Popup · 极简模式

```
┌─ mail-peon · 极简模式 ──────────────┐
│ 验证码记录:                          │
│                                      │
│ GitHub · noreply@github.com  12:34 │
│ 验证码 123456    [已复制 ✓]          │
│                                      │
│ 阿里云 · alert@aliyun.com    10:21 │
│ 验证码 888432    [复制]              │
│                                      │
│         [打开设置]                  │
└──────────────────────────────────────┘
```

> 只显示最近 50 条验证码（按时间倒序）；不显示未含验证码的邮件。

### 模式切换行为

| 切换方向 | 行为 |
| --- | --- |
| 极简 → 完整 | 历史 minimal 记录**保留**（无 body 字段，新视图会显示"该邮件为极简模式捕获，无摘要"）；新邮件走完整流水线 |
| 完整 → 极简 | 历史 full 记录**保留**（仍可见，新视图只挑有 `code` 字段的展示）；新邮件走极简流水线 |
| 任意 | UI 立刻切换；下次心跳时新邮件按新模式处理 |

### 实施清单

- [ ] `AppSettings.minimalMode: boolean` 默认 `true`
- [ ] `MailAccount` / `Mail` schema 不变；写入时按模式决定填哪些字段
- [ ] `summarize()` 在极简模式走"提取 code"提示词；完整模式走原提示词
- [ ] `purseMail` 在极简模式：未含验证码正则 → 跳过（不入库）；未提到 code → 跳过
- [ ] Popup / Sidepanel 渲染：根据 `minimalMode` 切布局
- [ ] Options 路由：根据 `minimalMode` 隐藏子页
- [ ] 切换模式时不需要清数据（保留历史，仅影响未来邮件）

### 备注

- 极简模式下 AI 还是会被调（用于提取验证码）；用户**只需要配一次** AI Key 即可；UI 不暴露 AI 配置
- 极简模式下 AI Key 可以是空（如果用户填了邮箱但没填 AI Key，则提示"完整功能需要先在设置里配 AI Key；当前极简模式无法提取验证码"）
- 极简模式的"小规模"、零噪音定位——是这个工具的**主销卖点**

---

## Q17. ~~AI 输出语言：自动跟随 / 用户可设？~~

**✅ 已决定（2026-XX-XX）**：**全局设置 `settings.ai.outputLanguage`**，**只 2 个选项**：

| 选项 | 行为 |
| --- | --- |
| `auto-browser`（默认） | 读 `navigator.language`，**模板直接喂浏览器语言** |
| `auto-email` | 模板里加一行 `"按邮件本身的语言回答"`，AI 自己看邮件判断 |

> **不做 JS 端邮件语言检测**——AI 自己从邮件内容判断更可靠，少一层逻辑。
> **不做显式语言选择**——MVP 只要这两个，让用户简单选。

### 字段

```ts
type OutputLanguage = 'auto-browser' | 'auto-email'

interface AiSettings {
  // ... 其它字段
  outputLanguage: OutputLanguage  // 默认 'auto-browser'
}
```

### 落地逻辑

```
1. settings.ai.outputLanguage
       │
       ▼
2. buildSystemPrompt(rule, outputLanguage, navigatorLanguage)
       │
       ├─ outputLanguage === 'auto-email'
       │     → 用 EN 模板 + 末尾追加
       │       "Respond in the same language as the email you are summarizing"
       │
       └─ outputLanguage === 'auto-browser'  + navigatorLanguage startsWith('zh')
             → 用 ZH 模板（保留"≤60 字中文"等本地化措辞）
       │
       └─ outputLanguage === 'auto-browser'  + 其它浏览器语言
             → 用 EN 模板 + 末尾追加 "Respond in {navigatorLanguage}"
```

### System Prompt 模板

> MVP 只维护 **中文 + 英文** 两套完整模板。其它浏览器语言 / `auto-email` 都走英文模板 + 一句自适应指令。

- **`ZH_SYSTEM_PROMPT`**：原文（包含"≤60 字中文"）
- **`EN_SYSTEM_PROMPT`**：完全翻译

详见 [`../design/ai-prompt-design.md § 2`](../design/ai-prompt-design.md)。

### MVP 实施清单

- [ ] `AiSettings.outputLanguage: 'auto-browser' | 'auto-email'`，默认 `'auto-browser'`
- [ ] `buildSystemPrompt(rule, outputLanguage, navigatorLanguage)` 拼装（不需要 JS 端邮件检测算法）
- [ ] 单测：两种情况分别生成正确结果
- [ ] Options · AI 配置加单选（"跟随浏览器" / "跟随邮件"）

### 备注

- 邮件**原文**不会被翻译——只翻译**摘要与判定文字**。
- 用户提示词规则的语言应跟随 system prompt 语言（系统中文 → 用户写中文；系统英文 → 用户写英文）。MVP 不强校验。
- 后续 M3+ i18n 工作时如有用户要"强制某语言"，再加显式语言列表。

---

## 仍未关闭的（Q14 / Q15 是 toast 改动带出来的）

### Q14. Toast 位置：顶部居中 / 右下角 / 底部居中？

**默认建议**：**顶部居中堆叠**（用户已认可）。

详见 [`../design/page-toast.md` § 3](../design/page-toast.md)。

### Q15. Toast 注入方式：常驻 Content Script / `chrome.scripting.executeScript` 按需？

**默认建议**：**常驻 Content Script**（模板已配 `<!-- <all_urls> -->`，零额外成本）。

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 常驻 Content Script | 零运行时开销；写起来简单 | 会在所有页面挂 content script |
| `chrome.scripting.executeScript` 按需 | 审查更友好（不申请 `charset`） | 需要 `scripting` 权限；每次注入时机复杂；MVP 阶段开发成本高 |

> **MVP 走常驻**。M3 上架前若 CRX Store 审查要求缩小 host_permissions，再切换到 `scripting`。

---

## 何时升级为 ADR？

满足以下任一即升级到 `decisions/adr-NNNN-title.md`：
- 影响架构（如选择 OAuth、加密策略）
- 一旦做了很难回退（如 schema 选择）
- 影响上架 / 合规

### 候选 ADR（已可写）

- **adr-0001-storage-idb.md** — 存储从 chrome.storage.local 迁到 IndexedDB
- **adr-0002-mail-provider-adapter.md** — 邮箱接入走 MailProvider 抽象
- **adr-0003-ai-provider-adapter.md** — AI 多 provider 适配器（镜像 offer-hunter）
- **adr-0004-credentials-plaintext-mvp.md** — MVP 凭证明文

---

## 后续读什么

- 整体产品：[`../00-overview.md`](../00-overview.md)
- 路线图：[`../03-roadmap.md`](../03-roadmap.md)
- 页面 toast：[`../design/page-toast.md`](../design/page-toast.md)