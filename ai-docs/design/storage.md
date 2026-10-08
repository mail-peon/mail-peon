# Storage · IndexedDB Schema

> 整个插件的所有持久化都走 IndexedDB，参考 [`offer-hunter/src/platform/idb/`](https://github.com/) 与 [`offer-hunter/src/logic/store/`](https://github.com/)。
>
> 本文是 schema 的**唯一真相**。改这里之前必须读完整个文件。

---

## 1. 顶层约定

- **DB 名**：`mail-peon`
- **当前 version**：`1`
- **库名 / version 不可随便改**：库名换 = 丢数据；version 只能往上加，且每次只能在 `upgrade()` 追加分支
- **键约定**：
  - **外部键仓库**（`keyPath: null`）：调用方 put 时**必须**给键；记录本身不含 `key` 字段（被字段白名单归一化清掉）
  - **内部键仓库**（`keyPath: 'id'` / `keyPath: 'key'`）：记录里有键；put 不传键
- **数据迁移**：只在 `upgrade()` 里做**结构性操作**（建库、建索引），数据搬迁交给应用层（`logic/store/migrations.ts`）
- **写入安全**：写事务必须 `await txDone()`；事务里不准 `await` 非 IDB 的 promise

---

## 2. Stores 总览

| 仓库 | keyPath | 索引 | 用途 |
| --- | --- | --- | --- |
| `accounts` | `null`（外部键 `accountId`） | `by-email`, `by-enabled` | 邮箱账号（含 per-account blockedList） |
| `rules` | `null`（外部键 `ruleId`） | `by-enabled`, `by-priority` | PromptRule |
| `mails` | `null`（外部键 `<accountId>:<messageId>`） | `by-accountId`, `by-receivedAt` | 邮件；按 receivedAt 保留最近 100 封 |
| `settings` | `'id'` | — | 单文档：`app` / `ai` |
| `meta` | `'key'` | — | 迁移标记、初始化标记 |

> **仓库形状不可变**：`name` / `keyPath` / 索引名都是契约。

---

## 3. `accounts`

```ts
interface MailAccount {
  id: string // = accountId（外部键）
  label: string
  email: string
  provider: 'imap' // MVP 仅 imap；M3+ 加 'gmail-oauth' / 'outlook-graph'
  config: ProviderConfig // 协议相关配置
  blockedList: BlockedEntry[] // per-account 排除邮箱
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /** 增量同步游标：上次同步过的最高 UID；null = 从未同步过（首次 sync 只记这个，不拉历史） */
  lastSeenUid?: number | null
  /** 该账号上次同步的 UIDVALIDITY（IMAP 邮箱重建时可能变） */
  uidValidity?: number | null
}

interface ProviderConfig {
  // IMAP
  host?: string
  port?: number // 993
  tls?: boolean // true
  user?: string
  pass?: string // ⚠ 明文 MVP（M3+ 加口令保护）
  // OAuth（M3+）
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

type BlockedEntry
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }
```

**索引**：

- `by-email` — `keyPath: 'email'`，精确匹配查账号
- `by-enabled` — `keyPath: 'enabled'`，只拉启用账号参与同步

---

## 4. `rules`

```ts
interface PromptRule {
  id: string // = ruleId（外部键）
  name: string
  enabled: boolean
  matchers: Matcher[]
  prompt: string
  alwaysCopyCode?: boolean
  alwaysSkipAd?: boolean
  priority: number // 用户拖拽 = 改 priority；数字越小越优先
  createdAt: number
  updatedAt: number
}

type Matcher
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }
    | { kind: 'regex', value: string }
```

**索引**：

- `by-enabled` — `keyPath: 'enabled'`
- `by-priority` — `keyPath: 'priority'`，匹配时按 `priority` 升序遍历

> MVP 规则可能很少（< 50），全表扫描也行；索引是为了将来扩展。

---

## 5. `mails`

```ts
interface Mail {
  id: string // = <accountId>:<messageId>（外部键）
  accountId: string
  from: { name: string, address: string }[]
  to: { name: string, address: string }[]
  cc?: { name: string, address: string }[]
  subject: string
  snippet: string // text 前 240 字
  bodyText?: string // 全文（截断 50k 字内）
  bodyHtml?: string // ⚠ MVP 不存 HTML
  receivedAt: number // ts（索引 key 用）
  processing: 'pending' | 'sent' | 'skipped'
  ai?: AiOutput
  copyStatus: 'none' | 'copied' | 'failed'
  read: boolean
  dismissed?: boolean
  messageId?: string
  listUnsubscribe?: string
  ruleId?: string // 命中的规则 id（调试 / 跳转）
}

interface AiOutput {
  minimal: string // ≤60 字
  summary: string // ≤600 字
  isAd: boolean
  code?: string | null
  urgency: 'low' | 'normal' | 'high'
  degraded?: boolean
  error?: string
}
```

**键构造**：

```ts
function mailKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`
}
```

> 如果 server 不带 messageId（少数奇葩邮件），退化为 `nanoid()`，但要确保同封邮件多次拉到时键一致——MVP 直接退化为 `nanoid()`，**接受重复**（用 subject + receivedAt 做去重兜底）。

**索引**：

- `by-accountId` — `keyPath: 'accountId'`
- `by-receivedAt` — `keyPath: 'receivedAt'`（**ISO 字符串字典序 = 时间序**，无需额外转换）

### 5.1 滚动淘汰（数量由用户设置）

> 上限 = `Settings.mailRetention`（默认 100，可选 200 / 500 / 1000 / `'unlimited'`）。详见 [`decisions/open-questions.md` Q5](../decisions/open-questions.md)。

```ts
async function upsertMail(mail: Mail): Promise<void> {
  await runTx(['mails'], 'readwrite', async (ctx) => {
    await put('mails', mail, mailKey(mail.accountId, mail.messageId ?? mail.id), ctx)
    await pruneMails(ctx) // 滚动淘汰（按用户设置）
  })
}

async function pruneMails(ctx: TxContext): Promise<void> {
  const { mailRetention } = await readAppSettings()
  if (mailRetention === 'unlimited')
    return

  const total = await count('mails', ctx)
  const overflow = total - mailRetention
  if (overflow <= 0)
    return

  await iterate<Mail>(
    'mails',
    { index: 'by-receivedAt', direction: 'next', limit: overflow },
    (_value, key) => { void del('mails', key, ctx) },
    ctx,
  )
  console.warn(`[mail-peon] 邮件超过 ${mailRetention} 封，已丢弃最旧的 ${overflow} 封`)
}
```

> ⚠️ `readAppSettings()` 必须**放在事务外**：事务里读 IDB 会自己开一个新事务，外层 readwrite 随即失活（参见 [`platform/idb/database.ts`](https://github.com/) 第 1 条规矩）。
> 调整上限时，**下次写**才会触发淘汰；也可在 Options 页"应用"按钮里手动调一次 `pruneMails(newCtx)`。

### 5.2 存储用量估算（用于 UI 展示）

> Options · 通用设置 显示"X 条 / Y 上限，约 Z MB"。

```ts
interface StorageUsage {
  count: number
  bytesApprox: number // 估算字节数（UTF-16 长度 × 2）
  byAccount: Record<string, { count: number, bytesApprox: number }>
}

async function estimateStorageUsage(): Promise<StorageUsage> {
  const usage: StorageUsage = { count: 0, bytesApprox: 0, byAccount: {} }
  await iterate<Mail>('mails', {}, (mail) => {
    const size = (mail.subject?.length ?? 0) * 2
      + (mail.bodyText?.length ?? 0) * 2
      + (mail.snippet?.length ?? 0) * 2
      + JSON.stringify(mail).length // 其它字段的 rough 估算
    usage.count++
    usage.bytesApprox += size
    usage.byAccount[mail.accountId] ??= { count: 0, bytesApprox: 0 }
    usage.byAccount[mail.accountId].count++
    usage.byAccount[mail.accountId].bytesApprox += size
  })
  return usage
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
```

> **不是真实占用**，但数量级正确；真实值需要 `navigator.storage.estimate()`（见下方）。

### 5.3 真实磁盘占用（可选）

```ts
async function realQuota(): Promise<{ usage: number, quota: number } | null> {
  if (!navigator.storage?.estimate)
    return null
  const est = await navigator.storage.estimate()
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
}
```

> 真实占用比 §5.2 大（IDB 结构化克隆 + 索引开销）；`estimate()` 是 Provider 层估算，不精确。
> MVP 用 §5.2 的估算即可，§5.3 作为 v2 增强。

---

## 6. `settings`

```ts
type SettingId = 'app' | 'ai'

interface SettingDoc<T> {
  id: SettingId
  value: T
  updatedAt: string // ISO
}

interface AppSettings {
  excludeAds: boolean // 默认 true
  autoCopyCode: boolean // 默认 true
  blockedEnabled: boolean // 默认 true（MVP 永远 true；per-account blockedList 在 accounts）
  notifyOnNew: boolean // master switch；默认 true
  popupDefaultTab: 'important' | 'all' | 'code' | 'ad' // 默认 'important'
  mailRetentionDays: number // M3+：默认 0 = 不按时间清理
  /** IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰 */
  mailRetention: 100 | 200 | 500 | 1000 | 'unlimited' // 默认 100
  /** 两套运行模式：极简（只验证码） / 完整（全部功能） */
  minimalMode: boolean // 默认 true
  schemaVersion: number
}

interface AiSettings {
  platform: 'openai' | 'deepseek' | 'anthropic' | 'custom' // 详见 adapters/ai/platforms
  baseUrl?: string // 空 = 用平台默认
  apiKey: string
  model?: string // 空 = 用平台默认
  maxTokens?: number // 默认 2048
  thinking?: boolean // 默认 false
  outputLanguage: 'auto-browser' | 'auto-email' // 默认 'auto-browser'；详见 decisions Q17
}
```

---

## 7. `meta`

```ts
type MetaKey = 'migration' | 'init'

interface MetaDoc<T> {
  key: MetaKey
  value: T
}

interface MigrationMeta {
  state: 'done'
  from: 'chrome.storage.local'
  at: string // ISO
  checksums: Record<string, string> // FNV-1a 摘要，参考 offer-hunter
  fresh?: boolean
  conflictMergedAt?: string
}

interface InitMeta {
  state: 'done'
  version: number
  at: string
}
```

---

## 8. 初始化门闸

参考 [`offer-hunter/src/logic/store/ready.ts`](https://github.com/)：

```ts
let readyPromise: Promise<void> | null = null

export function ensureStoreReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

async function init(): Promise<void> {
  await openDb()
  await requestPersistence() // navigator.storage.persist?.()，防止 IDE 自动写撤销
  const result = await runMigration()
  if (result.status === 'failed')
    throw new Error('存储迁移失败，详见 error 字段')
}
```

**所有读写函数的第一行都必须是 `await ensureStoreReady()`**——杜绝"读到迁移跑了一半"的窗口。

---

## 9. 一次性迁移（chrome.storage.local → IndexedDB）

> MVP 阶段**没有真实迁移数据**（项目还没装过），但**代码搭好**：
> - 旧键集合在 `logic/store/legacy.ts` 的 `STORAGE_KEYS`
> - 迁移是**幂等、原子、可重试**的：
>   1. 读迁移标记：已完成且旧键没有新内容 → 直接返回
>   2. 读旧键：都没有 → 全新安装，只写标记
>   3. `planMigration` 产出计划（**纯函数**，所有可预见的失败都在这一步之前发生）
>   4. 一个事务写入 settings + mails + meta（标记也只在事务里 → 不存在"搬一半却标了完成"）
>   5. 读回来重算摘要对账（FNV-1a，参考 offer-hunter）
>   6. **只有对账通过才删旧键**
> - 任何一步失败都不动旧键

---

## 10. upgrade 模板（`schema.ts`）

```ts
export const DB_NAME = 'mail-peon'
export const DB_VERSION = 1

export type StoreName = 'accounts' | 'rules' | 'mails' | 'settings' | 'meta'

export interface StoreSchema {
  name: StoreName
  keyPath: string | null
  indexes: { name: string, keyPath: string }[]
}

export const STORES: readonly StoreSchema[] = [
  { name: 'accounts', keyPath: null, indexes: [
    { name: 'by-email', keyPath: 'email' },
    { name: 'by-enabled', keyPath: 'enabled' },
  ] },
  { name: 'rules', keyPath: null, indexes: [
    { name: 'by-enabled', keyPath: 'enabled' },
    { name: 'by-priority', keyPath: 'priority' },
  ] },
  { name: 'mails', keyPath: null, indexes: [
    { name: 'by-accountId', keyPath: 'accountId' },
    { name: 'by-receivedAt', keyPath: 'receivedAt' },
  ] },
  { name: 'settings', keyPath: 'id', indexes: [] },
  { name: 'meta', keyPath: 'key', indexes: [] },
]

export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    for (const store of STORES) {
      const created = store.keyPath
        ? db.createObjectStore(store.name, { keyPath: store.keyPath })
        : db.createObjectStore(store.name)
      for (const index of store.indexes)
        created.createIndex(index.name, index.keyPath)
    }
  }

  // 未来追加：
  // if (oldVersion < 2) { tx.objectStore('mails').createIndex('by-accountId', 'accountId') }
}
```

---

## 11. 何时升级为 ADR / 写 changelog

满足以下任一即写 `decisions/adr-NNNN-<title>.md`：
- 增加 / 删除一个仓库
- 改 `keyPath`（外部键 ↔ 内部键）
- 改索引（rename / add / drop）
- 改 `DB_NAME`

---

## 12. 后续读什么

- 字段级定义：[`./data-model.md`](./data-model.md)
- 邮箱连接：[`../features/01-mail-inbox-connect.md`](../features/01-mail-inbox-connect.md)
- 排除邮箱（per-account）：[`../features/06-blocked-senders.md`](../features/06-blocked-senders.md)