# Data Model · 字段定义

> 所有 IndexedDB 仓库中的字段、跨上下文消息体都集中定义，避免在 UI 写"魔法字符串"。
>
> **存储层 schema（仓库 / 键 / 索引 / 迁移）见 [`./storage.md`](./storage.md)；本文讲字段。**

---

## 0. 总览

```
DB: mail-peon (v3)
├─ accounts (外键 accountId)            → MailAccount[]
├─ rules    (外键 ruleId)               → PromptRule[]
├─ mails    (外键 <accountId>:<messageId>) → Mail[]   索引含 by-trashedAt（v2）
├─ mailTypes(外键 id)                   → MailTypeRecord[]（v3：内置 override + 自定义）
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

  /**
   * 邮件内部状态标签（位掩码，`MailStateFlag`）。
   * Ad = 1<<0 / Urgent = 1<<1 / LowPriority = 1<<2。
   * ⚠ `isAd` / `urgency` 不再放在 `ai` 里；老数据归一化时迁移到这里。
   */
  stateFlags: number
  /** HTML href + 正文裸 URL（≤10，仅 http/https）；确认链接 / AI prompt 用 */
  links?: string[]

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
  /** 命中的类型（已按优先级排序、已应用兜底）—— 唯一真相 */
  types: MailTypeMatch[]
  /**
   * 兼容旧 UI 的派生字段（新代码尽量读 types）。
   * 新邮件由 pipeline 从 types 派生；老数据没有 types 时由归一化合成。
   */
  minimal?: string
  summary?: string
  code?: string | null
  validForSeconds?: number | null
  degraded?: boolean                // AI 失败走降级时为 true
  error?: string                    // 降级原因
}
```

> `isAd` / `urgency` 已迁到 `Mail.stateFlags`（位掩码）。
> AI 输出 zod schema 校验（见 [`ai-prompt-design.md`](./ai-prompt-design.md)）。

### 邮件类型适配器（Feature 08）

```ts
const MailStateFlag = {
  None: 0,
  Ad: 1 << 0,           // 营销 / 推广 / 自动通知
  Urgent: 1 << 1,       // 需要立刻处理
  LowPriority: 1 << 2,  // 低优先级（与 Urgent 互斥）
} as const

interface MailTypeAdapter {          // 运行时视图（catalog + override 合并）
  id: string                         // 'builtin:code' | 'custom:<id>'
  kind: 'builtin' | 'custom'
  ui: 'code' | 'confirm' | 'summary' | null
  name: string
  description: string
  enabled: boolean                   // 极简模式下由模式覆盖
  priority: number                   // 越小越靠前
  fallback: boolean                  // true = 仅当没有非兜底类型命中
  prompt: string
  userPrompt?: string
  /** 适配器自己的参数；当前验证码用 `autoCopyCode`，自定义不展示 */
  params?: Record<string, unknown>
}

interface MailTypeRecord {           // IDB `mailTypes`（外部键 id）
  id: string
  kind: 'builtin' | 'custom'
  enabled?: boolean
  userPrompt?: string                // 内置 override
  params?: Record<string, unknown>   // 内置 / 自定义均可选；自定义暂不展示
  name?: string                      // 自定义
  prompt?: string                    // 自定义
  priority?: number                  // 自定义
  fallback?: boolean                 // 自定义
  createdAt: number
  updatedAt: number
}

type MailTypeMatch =
  | { kind: 'code',    adapterId: string, adapterName: string, code: string, expiry?: Expiry }
  | { kind: 'confirm', adapterId: string, adapterName: string, url: string, host: string, label?: string, expiry?: Expiry }
  | { kind: 'summary', adapterId: string, adapterName: string, minimal: string, text: string }
  | { kind: 'custom',  adapterId: string, adapterName: string, text: string }

interface Expiry {
  at: number                         // 绝对失效时刻（epoch ms）
  totalSeconds: number               // 进度条分母
}
```

- 内置适配器**不落库**：catalog 在代码里，`mailTypes` 只存 override 与自定义。
- 详细规则见 [`../features/08-mail-types.md`](../features/08-mail-types.md)。

---

## 4. Settings

> 不再是单文档 `Settings`，拆成两份（`app` / `ai`），便于单独读写。

```ts
interface AppSettings {
  /** 两套运行模式：极简（只验证码） / 完整（全部功能） */
  minimalMode: boolean               // 默认 true
  excludeAds: boolean                // 默认 true（仅完整模式生效）
  /** @deprecated 已迁到验证码适配器的 `params.autoCopyCode`；仅作旧数据回退 */
  autoCopyCode?: boolean
  blockedEnabled: boolean            // 默认 true（仅完整模式生效）
  notifyOnNew: boolean               // master switch；默认 true
  /** 后台自动检查新邮件的间隔（分钟）；默认 5，范围 1–60 */
  checkIntervalMinutes: number
  popupDefaultTab: string            // 筛选 id：'important' | 'all' | 'ad' | 'adapter:<id>'
  /** IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰（仅完整模式生效；极简模式写死 50） */
  mailRetention: 100 | 200 | 500 | 1000 | 'unlimited'   // 默认 100
  mailRetentionDays?: number         // M3+：默认 0 = 不按时间清理
  /** @deprecated 已迁到验证码适配器的 `params.autoDeleteExpiredCode`；仅旧数据回退 */
  autoDeleteExpiredCode?: boolean
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
  blockedEnabled: true,
  notifyOnNew: true,
  checkIntervalMinutes: 5,
  popupDefaultTab: 'important',     // 旧值 'code' 会映射到 'adapter:builtin:code'  mailRetention: 100,
  mailRetentionDays: 0,
  autoDeleteExpiredCode: true,      // @deprecated：仅旧数据回退，界面已移到验证码适配器
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
| `_visibility: 'normal' \| 'ad' \| 'code' \| 'pending'` | `mailVisibility()`（见 `popup/list-filter.ts`）。⚠ 被屏蔽的邮件**根本不入库**，所以没有 `'blocked'` 这一档；`ad` 现在由 `stateFlags & Ad` 判断 |
| `_isImportant` | `!Ad && (!LowPriority \|\| 命中验证码/确认)`，再排除 pending / dismissed（见 `popup/list-filter.ts`） |
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