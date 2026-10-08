# Data Model · 字段定义

> 所有 IndexedDB 仓库中的字段、跨上下文消息体都集中定义，避免在 UI 写"魔法字符串"。
>
> **存储层 schema（仓库 / 键 / 索引 / 迁移）见 [`./storage.md`](./storage.md)；本文讲字段。**

---

## 0. 总览

```
DB: mail-peon (v1)
├─ accounts (外键 accountId)            → MailAccount[]
├─ rules    (外键 ruleId)               → PromptRule[]
├─ mails    (外键 <accountId>:<messageId>) → Mail[]
├─ settings (内键 id: 'app' | 'ai')     → 单文档
└─ meta     (内键 key)                  → 迁移标记
```

> **MVP 不再使用 `chrome.storage.local`**。仅作为"一次性迁移的来源"出现在 `logic/store/legacy.ts`。

---

## 1. MailAccount

```ts
interface MailAccount {
  id: string                          // = accountId（外键）
  label: string
  email: string
  provider: 'imap'                    // MVP 仅 imap；M3+ 加 'gmail-oauth' / 'outlook-graph'
  config: ProviderConfig
  blockedList: BlockedEntry[]         // per-account 排除邮箱
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /** 增量同步游标：上次同步过的最高 UID；null = 从未同步过（首次 sync 只记这个，不拉历史） */
  lastSeenUid?: number | null
  /** IMAP UIDVALIDITY：邮箱重建时服务器会让它变，变化时需要清零 lastSeenUid 并提示 */
  uidValidity?: number | null
}

interface ProviderConfig {
  // IMAP（MVP）
  host?: string
  port?: number                       // 993
  tls?: boolean                       // true
  user?: string
  pass?: string                       // ⚠ 明文 MVP（M3+ 加口令保护）

  // OAuth（M3+）
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

type BlockedEntry =
  | { kind: 'email',  value: string }
  | { kind: 'domain', value: string }
```

> blockedList 设计详见 [`../features/06-blocked-senders.md`](../features/06-blocked-senders.md)。
> 字段级细节（匹配行为、level 函数、全局 vs per-account）见那篇。

---

## 2. PromptRule

```ts
interface PromptRule {
  id: string                          // = ruleId（外键）
  name: string
  enabled: boolean
  priority: number                    // 用户拖拽 = 改 priority；数字越小越优先
  matchers: Matcher[]
  prompt: string
  alwaysCopyCode?: boolean
  alwaysSkipAd?: boolean
  createdAt: number
  updatedAt: number
}

type Matcher =
  | { kind: 'email',  value: string }
  | { kind: 'domain', value: string }
  | { kind: 'regex',  value: string }
```

---

## 3. Mail

```ts
interface Mail {
  id: string                          // = `<accountId>:<messageId>` 或 nanoid 兜底
  accountId: string

  // 头部
  from: { name: string, address: string }[]
  to:   { name: string, address: string }[]
  cc?:  { name: string, address: string }[]
  subject: string

  // 内容
  snippet: string                   // text 前 240 字
  bodyText?: string                  // 全文（避免 HTML 全部入库）
  bodyHtml?: string                  // 仅在用户点开时按 messageId 重拉（可选）

  // 时间
  receivedAt: number                 // ts

  // 状态
  processing: 'pending' | 'sent' | 'skipped'
  ai?: AiOutput
  copyStatus: 'none' | 'copied' | 'failed'
  read: boolean
  dismissed?: boolean                // 用户标记不再显示

  // 原始（可丢弃）
  messageId?: string
  listUnsubscribe?: string
}
```

`useWebExtensionStorage('mail-peon:mails', [])`，**只保留最近 100 封**。

### AiOutput

```ts
interface AiOutput {
  minimal: string                   // ≤60 字
  summary: string                   // ≤600 字
  isAd: boolean
  code?: string | null
  urgency: 'low' | 'normal' | 'high'
  degraded?: boolean                // AI 失败走降级时为 true
  error?: string                    // 降级原因
}
```

> AI 输出 zod schema 校验（见 [`ai-prompt-design.md`](./ai-prompt-design.md)）。

---

## 4. Settings

> 不再是单文档 `Settings`，拆成两份（`app` / `ai`），便于单独读写。

```ts
interface AppSettings {
  /** 两套运行模式：极简（只验证码） / 完整（全部功能） */
  minimalMode: boolean               // 默认 true
  excludeAds: boolean                // 默认 true（仅完整模式生效）
  autoCopyCode: boolean              // 默认 true；极简模式强制为 true
  blockedEnabled: boolean            // 默认 true（仅完整模式生效）
  notifyOnNew: boolean               // master switch；默认 true
  popupDefaultTab: 'important' | 'all' | 'code' | 'ad'   // 默认 'important'（仅完整模式生效）
  /** IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰（仅完整模式生效；极简模式写死 50） */
  mailRetention: 100 | 200 | 500 | 1000 | 'unlimited'   // 默认 100
  mailRetentionDays?: number         // M3+：默认 0 = 不按时间清理
  schemaVersion: number              // 1
}

type OutputLanguage =
  | 'auto-browser'                   // 默认；跟 navigator.language
  | 'auto-email'                     // 跟邮件本身（prompt 注入"按邮件语言"）

interface AiSettings {
  platform: 'openai' | 'deepseek' | 'anthropic' | 'custom'
  baseUrl?: string                   // 空 = 用平台默认
  apiKey: string
  model?: string                     // 空 = 用平台默认
  maxTokens?: number                 // 默认 2048
  thinking?: boolean                 // 默认 false（DeepSeek 等开思考会出事）
  outputLanguage: OutputLanguage     // 默认 'auto-browser'；详见 Q17
}
```

> 详见 [`./storage.md § 6`](./storage.md) 与 [`../features/02-ai-summary.md`](../features/02-ai-summary.md)。

---

## 5. 默认值

```ts
// src/logic/store/settings-defaults.ts
export const defaultAppSettings: AppSettings = {
  minimalMode: true,                // 默认极简
  excludeAds: true,
  autoCopyCode: true,
  blockedEnabled: true,
  notifyOnNew: true,
  popupDefaultTab: 'important',
  mailRetention: 100,
  mailRetentionDays: 0,
  schemaVersion: 1,
}

export const defaultAiSettings: AiSettings = {
  platform: 'openai',
  apiKey: '',
  outputLanguage: 'auto-browser',
}
```

> AI 各平台的默认值在 `src/adapters/ai/platforms/<id>/index.ts` 的 `defaultBaseUrl` / `defaultModel` 字段。

---

## 6. 派生 UI 字段（不存储，按需计算）

| 字段 | 计算 |
| --- | --- |
| `_visibility: 'normal' \| 'ad' \| 'code' \| 'pending' \| 'blocked'` | 见各 features 文档 |
| `_urgencyRank` | `high=2, normal=1, low=0` |
| `_isFromRule(rule)` | `pickRule(mail, rules) === rule` |

---

## 7. 消息体（`webext-bridge`）

| Channel | Request | Response |
| --- | --- | --- |
| `mail:list` | `void` | `{ mails: Mail[] }` |
| `mail:get` | `{ mailId }` | `{ mail: Mail \| null }` |
| `mail:dismiss` | `{ mailId }` | `{ ok: true }` |
| `mail:copy-code` | `{ mailId, code }` | `{ ok: boolean }` |
| `mail:focus` | `{ mailId }` | (broadcasting) |
| `mail:updated` | `{ mailId }` | (broadcasting) |
| `accounts:list` | `void` | `{ accounts: MailAccount[] }` |
| `accounts:upsert` | `{ account: MailAccount }` | `{ ok: true }` |
| `accounts:delete` | `{ id }` | `{ ok: true }` |
| `accounts:test` | `{ account: MailAccount }` | `{ ok: boolean, error?: string }` |
| `rules:list` | `void` | `{ rules: PromptRule[] }` |
| `rules:upsert` | `{ rule: PromptRule }` | `{ ok: true }` |
| `rules:delete` | `{ id }` | `{ ok: true }` |
| `settings:get` | `void` | `{ settings: Settings }` |
| `settings:set` | `{ patch: Partial<Settings> }` | `{ ok: true }` |
| `ai:test` | `{ ai: AiConfig }` | `{ ok: boolean, error?: string }` |

> 在 `shim.d.ts` 里给 `EventNameMap` 加签名，避免拼写错。

---

## 8. 升级与迁移

> **IDB schema 升级** 见 [`./storage.md § 10`](./storage.md)。
> **chrome.storage.local → IndexedDB 一次性迁移** 见 [`./storage.md § 9`](./storage.md) 与 `src/logic/store/legacy.ts`（参考 offer-hunter）。

---

## 9. 导入 / 导出（用户体验向）

- 全部账号 + 规则 + 设置 → JSON 文件
- 不导出邮件正文（隐私）
- 不导出密码 / OAuth token / AI Key（隐私）
- 导入时**追加**账号 / 规则，**覆盖**除凭据外的设置

---

## 10. i18n

> 所有 UI 文案集中在 `src/logic/strings.ts`（不在 `.vue` 里硬编码中文字符串）。MVP 只交付 `zh-CN`，但**调用方式**已经是 i18n-ready：

```ts
// src/logic/strings.ts（MVP）
export function t(key: string, vars?: Record<string, unknown>): string {
  return format(zhCN[key] ?? key, vars)
}
```

未来接 vue-i18n / 自研时，**只换实现，不动调用方**。

---

---

## 11. 后续读什么

- AI 提示词组装：[`./ai-prompt-design.md`](./ai-prompt-design.md)
- 跨上下文消息拓扑：[`../01-architecture.md`](../01-architecture.md)
- IDB schema：[`./storage.md`](./storage.md)