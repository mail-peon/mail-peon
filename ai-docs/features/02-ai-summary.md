# Feature 02 · AI 总结 + 通知反馈

> 对应里程碑：**MVP**。两种模式共用 AI 层，但走不同的 prompt / 路径：
> - **完整模式**：每封新邮件经 AI 处理，输出"最简（minimal）"与"总结（summary）"；**不调系统通知**——只更新 icon badge + Popup / Sidepanel 展示
> - **极简模式**：AI 只用来提取验证码（极简 prompt），输出 `{ code }`；不命中 → 邮件丢弃
>
> 完整模式的通知细节详见 [`../design/page-toast.md`](../design/page-toast.md)；极简模式的简化提示词详见 [`../design/minimal-mode.md` § 3.4](../design/minimal-mode.md)。
>
> **AI 层采用多 Provider 适配器**，完全镜像 `offer-hunter/src/adapters/ai/`。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | **完整模式**：邮件入库后自动异步 AI 处理，结果落库 |
| G2 | **完整模式**：icon 右上角 badge 数字随新邮件 +1；点 icon = 看 Popup |
| G3 | **完整模式**：Popup / Sidepanel 卡片展示 summary（多段） |
| G4 | **完整模式**：AI 失败时**降级**展示邮件基础信息 |
| G5 | **两种模式**：用户可在 Options 配置 AI Platform / Key / Model（**OpenAI / DeepSeek / Anthropic / Custom**）——极简模式 UI 隐藏但 Key 必填 |
| G6 | **极简模式**：AI 仍会被调，但只用极简 prompt（提取验证码） |
| G7 | **两种模式**：AI 输出语言按 `outputLanguage`（auto-browser / auto-email）切换 |

---

## 2. AI Provider 配置

> 数据存储在 `settings.ai`（internal key，详见 [`../design/storage.md § 6`](../design/storage.md)）：

```ts
interface AiSettings {
  platform: 'openai' | 'deepseek' | 'anthropic' | 'custom'
  baseUrl?: string // 空 = 用平台默认
  apiKey: string
  model?: string // 空 = 用平台默认
  maxTokens?: number // 默认 2048
  thinking?: boolean // 默认 false
  outputLanguage: 'auto-browser' | 'auto-email' // 默认 'auto-browser'；详见 Q17
}
```

### 2.1 平台列表（MVP 至少 4 家）

| `platform` | 默认 baseUrl | 默认 model | 备注 |
| --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | 原生 JSON（`response_format`） |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-flash` | OpenAI 兼容；**必须关闭思考模式**否则 token 全耗 |
| `anthropic` | `https://api.anthropic.com` | `claude-3-5-haiku-latest` | 不支持原生 JSON（prompt 约束） |
| `custom` | （用户填） | （用户填） | 任何 OpenAI 兼容的中转 |

### 2.2 注册表与工厂（`src/adapters/ai/platforms/index.ts`）

```ts
import type { AiProvider, AiSettings } from '../types'
import { collectAdapters } from '../../collect'

export const AI_PLATFORMS = collectAdapters(
  import.meta.glob<{ default: AiPlatformDefinition }>('./*/index.ts', { eager: true }),
)

export function createAiProvider(settings: AiSettings): AiProvider {
  const platform = AI_PLATFORMS.find(p => p.id === settings.platform)
  if (!platform)
    throw new Error(`Unknown AI platform: ${settings.platform}`)
  return platform.factory({
    baseUrl: settings.baseUrl || platform.defaultBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model || platform.defaultModel,
    maxTokens: settings.maxTokens ?? 2048,
    thinking: settings.thinking ?? false,
  })
}
```

**新增平台 = 加一个 `src/adapters/ai/platforms/<id>/index.ts`**，默认导出 `defineAiPlatform({ ... })`。注册表按目录约定 glob 自动发现，**不需改 `index.ts`**。

> 详细架构（protocol / platform 分离）见 `offer-hunter/src/adapters/ai/platforms/types.ts` 与 `offer-hunter/src/adapters/ai/protocols/`。

---

## 3. AI 输出 Schema（固定）

> AI 必须返回**严格 JSON**，由 `zod` 校验后才能落库：

```ts
const AiOutputSchema = z.object({
  minimal: z.string(), // 一行，<= 60 字，用于通知
  summary: z.string(), // 多段 markdown，<= 600 字
  isAd: z.boolean(), // 营销 / 推广 / 通知无意义？
  code: z.string().optional(), // 若邮件中有验证码，提取
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
})

type AiOutput = z.infer<typeof AiOutputSchema>
```

字段含义详见 [`design/ai-prompt-design.md`](../design/ai-prompt-design.md)。

---

## 4. 处理流水线

```
mailbox.syncAccount 拿到新 Mail
        │
        ▼
ai.queue(mail)             ← 入队，控制并发（默认 3）
        │
        ▼
summarize(mail, rule, aiSettings)
        │
        ├─ 1. provider = createAiProvider(aiSettings)
        ├─ 2. 预处理
        │     - 截断 bodyText 到 N token（粗略按 1.5 字 / token）
        │     - 抽 header 关键字段（subject/from/date）
        ├─ 3. 选 system prompt 模板 + 注入语言（详见 § 4.1）
        │
        ├─ 4. 组装 messages
        │     [
        │       { role: 'system', content: systemPrompt },
        │       { role: 'user',   content: userContent(mail, rule) },
        │     ]
        │
        ├─ 5. provider.chat({ system, messages, json: true })
        │       ├─ OpenAI 协议：发 { response_format: { type: 'json_object' } }
        │       └─ Anthropic 协议：纯 prompt 约束（不支持原生）
        │
        ├─ 6. JSON.parse → zod.safeParse → 失败则重试 1 次
        │
        ├─ 7. 落库：mail.ai = result；status='sent'
        │
        └─ 8. 触发 badge / toast 反馈（见 § 6 / page-toast.md）
```

并发控制：在 background 用一个简单的 in-memory 队列（`p-limit` 思想），**默认 3 并发**。

### 4.1 System Prompt 模板与语言注入

> **只维护 2 套模板**（中文 + 英文）；其它语言 / `auto-email` 都走英文模板 + 一句指令自适应。

```ts
function buildSystemPrompt(
  rule: PromptRule,
  aiSettings: AiSettings,
  browserLang: string, // = navigator.language
): string {
  let tpl: string
  let langDirective = ''

  if (aiSettings.outputLanguage === 'auto-email') {
    tpl = EN_SYSTEM_PROMPT
    langDirective = '\n\n# Output Language\nRespond in the **same language as the email** you are summarizing.'
  }
  else if (browserLang.startsWith('zh')) {
    tpl = ZH_SYSTEM_PROMPT // 保留"≤60 字中文"等本地化措辞
  }
  else {
    tpl = EN_SYSTEM_PROMPT
    langDirective = `\n\n# Output Language\nRespond in ${browserLang}.`
  }

  return `${tpl}\n\n# Current Rule: ${rule.name}\n\n${rule.prompt}${langDirective}`
}
```

详见 [`../design/ai-prompt-design.md § 2`](../design/ai-prompt-design.md)。

---

## 5. 降级策略

AI 调用失败（网络 / 4xx / zod 校验失败 / 超时）时：

| 字段 | 兜底 |
| --- | --- |
| `minimal` | `from.address` + `subject.slice(0, 30)` |
| `summary` | `snippet`（已存） |
| `isAd` | 走启发式（header 含 `List-Unsubscribe` 且非用户联系人？→ true） |
| `code` | 走启发式（正则） |
| `urgency` | `normal` |

降级落 `mail.ai = { degraded: true, error }`，UI 上有"⚠️ 降级"角标。

---

## 6. 通知反馈

> **不再使用 `chrome.notifications`**——只在 icon 上加 badge + Popup / Sidepanel 里展示。

### 6.1 Badge（icon 右上角数字）

```ts
// 计数规则见 §6.2
await chrome.action.setBadgeText({ tabId, text: String(badgeCount) })
await chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' })
```

- badge **仅展示在 icon 上**（不依赖 chrome.notifications）
- 数字 = 当前窗口里"未读且未屏蔽"邮件数
- 用户**点击 icon = 看 Popup**（Chrome 默认行为）
- Popup 打开时，清零当前 tab 的 badge；用户主动"标记已读"也算清零

### 6.2 Badge 计数规则

```ts
function badgeCount(mails: Mail[]): number {
  return mails.filter(m => {
    return !m.read
      && m.processing !== 'pending'
      && !(m.ai?.isAd && settings.excludeAds)
      && !m.ai?.code
  }).length
}

- **不计入**：未处理 pending、广告（开启排除时）、验证码（自动复制成功时）
- **计入**：普通邮件 + 验证码（自动复制失败时）
- badge 上限 99，超过显示 "99+"

### 6.3 Popup 跳转（点击 icon）

Chrome 默认行为就是"打开 popup"；我们**不需要**额外监听 `onClicked`。

如果未来需要 Sidepanel 自动打开：

```ts
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})
```

### 6.4 何时**不**更新 badge

- 邮件被判为广告（`isAd === true` && `settings.excludeAds`） → 不 +1（详见 [`04-exclude-ads.md`](./04-exclude-ads.md)）
- 邮件含验证码且自动复制成功 → 不 +1（详见 [`05-verification-code.md`](./05-verification-code.md)）
- 邮件在「排除邮箱」列表 → 完全不入库，不参与计数（详见 [`06-blocked-senders.md`](./06-blocked-senders.md)）

---

## 7. 存储

`Mail.ai: AiOutput | null`，`Mail.processing: 'pending' | 'sent' | 'skipped'`。

| 状态 | 含义 |
| --- | --- |
| `pending` | 入库但 AI 还在处理 |
| `sent` | AI 完成（成功或降级都算 sent） |
| `skipped` | 被规则跳过（如广告 / 验证码 / 排除） |

UI 上"PENDING"徽章用于"AI 还没回"的情况。

---

## 8. 跨上下文消息

| Channel | Payload | 含义 |
| --- | --- | --- |
| `mail:updated` | `{ mailId }` | bg → popup/sidepanel：某封 AI 处理完成 |
| `mail:focus` | `{ mailId }` | toast click → popup：滚到该封 |
| `mail:toast` | `ToastPayload` | bg → content_script：在当前页面顶部弹 toast（详见 [`../design/page-toast.md`](../design/page-toast.md)） |
| `ai:test` | `{ aiConfig }` | options → bg：跑一次最小调用测试连通性 |

---

## 9. 验收清单

- [ ] Options 配置 AI Key → "测试连通"成功
- [ ] 拉到新邮件 → Popup 出现"PENDING" → 几秒后变成 summary
- [ ] 新邮件到达 → icon 右上角 badge 数字 +1
- [ ] 点击 icon → Popup 打开，能看到该邮件；badge 归零
- [ ] 广告邮件 → 不增加 badge
- [ ] 验证码自动复制成功 → 不增加 badge（详见 [`05-verification-code.md`](./05-verification-code.md)）
- [ ] 关闭 AI Key（故意改坏）→ 邮件仍入库但显示"⚠️ 降级"
- [ ] 并发 3 时不会出现"卡死"或内存爆炸
- [ ] 单封超大（>50k 字）邮件 → 截断后调用，不超 token 限制

---

## 10. 后续读什么

- 提示词：[`03-prompt-rules.md`](./03-prompt-rules.md)
- 广告判定：[`04-exclude-ads.md`](./04-exclude-ads.md)
- 验证码：[`05-verification-code.md`](./05-verification-code.md)
- 页面顶部 toast：[`../design/page-toast.md`](../design/page-toast.md)