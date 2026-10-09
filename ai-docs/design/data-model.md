# Data Model · 字段定义

> 所有 IndexedDB 仓库中的字段、跨上下文消息体都集中定义，避免在 UI 写"魔法字符串"。
>
> **存储层 schema（仓库 / 键 / 索引 / 迁移）见 [`./storage.md`](./storage.md)；本文讲字段。**

---

## 0. 总览

```
DB: mail-peon (v2)
├─ accounts (外键 accountId)            → MailAccount[]
├─ rules    (外键 ruleId)               → PromptRule[]
├─ mails    (外键 <accountId>:<messageId>) → Mail[]   索引含 by-trashedAt（v2）
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
  provider: MailProviderId            // 开放字符串；已实现 'imap' / 'gmail'
  config: ProviderConfig
  blockedList: BlockedEntry[]         // per-account 排除邮箱
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /**
   * 增量同步游标，**形状由 provider 自己定**（`SyncCursor`）。
   *
   * ⚠ 早期文档把它写成 `lastSeenUid` + `uidValidity` 两个顶层字段 ——
   *   那对 Gmail 不成立（它用 `historyId`），所以提到了一个不透明的 `cursor` 里：
   *   IMAP 放 `{ uid, uidValidity }`，Gmail 放 `{ historyId }`。
   *
   * `undefined` = 从未同步过（首次同步**只记游标、不拉历史**）。
   */
  cursor?: SyncCursor
}

interface ProviderConfig {
  // IMAP
  host?: string
  port?: number                       // 993
  tls?: boolean                       // true
  user?: string
  pass?: string                       // ⚠ 明文存 IndexedDB
  /** ⚠ IMAP 的**必需**项：浏览器没有裸 TCP，要经本机中继，见 adr-0005 */
  relayUrl?: string

  // OAuth（Gmail 已实现）
  clientId?: string
  tenantId?: string
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
  bodyHtml?: string                  // ⚠ 实际不存：归一化时被置为 undefined（MVP 不存 HTML）

  // 时间
  receivedAt: number                 // ts（数字；by-receivedAt 索引的升序游标即时间序）

  // 状态
  processing: 'pending' | 'sent' | 'skipped'
  ai?: AiOutput
  copyStatus: 'none' | 'copied' | 'failed'
  read: boolean
  dismissed?: boolean                // 用户标记不再显示（卡片展开后的「不再显示」按钮）

  // 验证码（极简模式的核心产出）
  /** 顶层 `code`：UI 与 badge 用的便宜判据，避免每处都去翻 `ai` */
  code?: string | null
  /** 失效时刻（epoch ms）；由 AI 读到的时长 + 入库时刻推算 */
  codeExpiresAt?: number
  /** 总有效期秒数 —— 进度条的**分母**（与 codeExpiresAt 同生同灭） */
  codeValidForSeconds?: number

  // 回收站
  /** 有值 = 在回收站里（不进主列表、不占保留名额）。状态变更，不是软删除 */
  trashedAt?: number

  // 原始（可丢弃）
  messageId?: string
  listUnsubscribe?: string
  ruleId?: string                    // 命中的规则 id（调试 / 跳转）
}
```

**存储**：IndexedDB 的 `mails` 仓库（不是 `chrome.storage`）。
保留数量由 `AppSettings.mailRetention` 决定（`{100, 200, 500, 1000, 'unlimited'}`，默认 100），
**极简模式写死 50**（`MINIMAL_RETENTION`）；**回收站里的不占名额、也不被淘汰**。

### AiOutput

```ts
interface AiOutput {
  minimal: string                   // ≤60 字
  summary: string                   // ≤600 字
  isAd: boolean
  code?: string | null
  /**
   * AI 从邮件里读到的有效期（**秒**）。
   * ⚠ 模型看不到当前时间，所以只能给相对时长；换算成绝对时刻是 pipeline 的事。
   * ⚠ 只在邮件**明确写了**有效期时才给值 —— 不许猜一个「常见值」。
   */
  validForSeconds?: number | null
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
  autoCopyCode: boolean              // 默认 true；两种模式都尊重它（极简模式不再强制 true）
  blockedEnabled: boolean            // 默认 true（仅完整模式生效）
  notifyOnNew: boolean               // master switch；默认 true
  popupDefaultTab: 'important' | 'all' | 'code' | 'ad'   // 默认 'important'（仅完整模式生效）
  /** IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰（仅完整模式生效；极简模式写死 50） */
  mailRetention: 100 | 200 | 500 | 1000 | 'unlimited'   // 默认 100
  mailRetentionDays?: number         // M3+：默认 0 = 不按时间清理
  /** 失效验证码自动删除（默认 true）：失效后 30 秒移入回收站 */
  autoDeleteExpiredCode: boolean
  schemaVersion: number              // 1
}

type OutputLanguage =
  | 'auto-browser'                   // 默认；跟 navigator.language
  | 'auto-email'                     // 跟邮件本身（prompt 注入"按邮件语言"）

interface AiSettings {
  platform: AiPlatformName            // 开放字符串；已实现 openai / deepseek / anthropic
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
// src/logic/types.ts —— createDefaultAppSettings() / createDefaultAiSettings()
export const defaultAppSettings: AppSettings = {
  minimalMode: true,                // 默认极简
  excludeAds: true,
  autoCopyCode: true,
  blockedEnabled: true,
  notifyOnNew: true,
  popupDefaultTab: 'important',
  mailRetention: 100,
  mailRetentionDays: 0,
  autoDeleteExpiredCode: true,      // 失效验证码自动清走
  schemaVersion: 1,
}

export const defaultAiSettings: AiSettings = {
  platform: 'deepseek',             // ⚠ 默认平台是 deepseek，不是 openai
  apiKey: '',
  outputLanguage: 'auto-browser',
}
```

> AI 各平台的默认值在 `src/adapters/ai/platforms/<id>/index.ts` 的 `defaultBaseUrl` / `defaultModel` 字段。

---

## 6. 派生 UI 字段（不存储，按需计算）

| 字段 | 计算 |
| --- | --- |
| `_visibility: 'normal' \| 'ad' \| 'code' \| 'pending'` | `mailVisibility()`（见 `popup/list-filter.ts`）。⚠ 被屏蔽的邮件**根本不入库**，所以没有 `'blocked'` 这一档 |
| `_urgencyRank` | `urgencyRank()`：`high=2, normal=1, low=0` |
| `_isFromRule(rule)` | `pickRule(mail, rules) === rule` |

---

## 7. 消息体（`webext-bridge`）

> **单一真相是 [`shim.d.ts`](../../shim.d.ts) 里的 `ProtocolMap`** ——
> 通道名、请求 / 响应形状都由它声明，`send` / `onMessage` 靠类型检查保证拼写正确。
>
> 这里**不再维护一份副本**：早期那张表只有十几个通道，而实际有 40 多个
> （`trash:*` 5 个、`accounts:sync-now` / `sync-status`、`data:changed`、
> `sync:done`、`settings:set-app` / `set-ai`、`rules:move`…），
> 而且 `settings:set` 这种**已经不存在**的通道还留在表里 ——
> 复制一份必然会分叉，所以直接看那份声明。

几个容易记错的点：

- 设置是**两个**通道：`settings:set-app` 与 `settings:set-ai`（没有 `settings:set`）；
- `settings:get` 返回 `{ app, ai }` 两份设置；
- `mail:list` 的请求是 `{ limit? }`，不是 `void`；
- 广播类（没有返回值）用 `broadcastToExtension` 发，见 `logic/messaging.ts`。

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