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
| `mails` | `null`（外部键 `<accountId>:<messageId>`） | `by-accountId`, `by-receivedAt`, `by-trashedAt` | 邮件；按 receivedAt 保留最近 N 封（回收站里的不占名额） |
| `settings` | `'id'` | — | 单文档：`app` / `ai` |
| `meta` | `'key'` | — | 迁移标记、初始化标记 |

> **仓库形状不可变**：`name` / `keyPath` / 索引名都是契约。

### `by-trashedAt`（v2 新增）

`trashedAt` 只在邮件**进了回收站之后**才有值，而 IndexedDB 的索引
**不收录字段缺失的记录** —— 所以这个索引天然只包含「在回收站里」的邮件，
拿它的游标倒序遍历就是回收站列表（最近删的在最前），不需要全表扫再过滤。

```
⚠ 这正是用**时间戳**而不是布尔量 `trashed: true` 的收益：
  布尔量要么建不出「只有 true」的索引（IndexedDB 不支持部分索引），
  要么得把整表都收进索引再过滤。
```

`upgrade()` 里它必须是 **`else if (oldVersion < 2)`**，不是独立的 `if (oldVersion < 2)`：
全新安装时 `oldVersion === 0`，第一个分支已经按 `STORES` 建好了**全部**索引
（`STORES` 是当前结构的唯一真相，已含 `by-trashedAt`），
再 `createIndex` 一次会抛 `ConstraintError`，而 `onupgradeneeded` 里的异常会让
**整个升级事务 abort** —— 表现是 `AbortError`、库根本打不开，
错误信息完全不提索引重名。（实测踩过：全套 store 测试挂掉 27 条。）

---

## 3. `accounts`

```ts
interface MailAccount {
  id: string // = accountId（外部键）
  label: string
  email: string
  provider: string // 'imap' | 'gmail' | …（开放字符串，加 provider 不用改类型）
  config: ProviderConfig // 协议相关配置
  blockedList: BlockedEntry[] // per-account 排除邮箱
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /**
   * 增量同步游标：形状由 **provider 自己定**。
   *
   * ⚠ 早期文档把它写死成 IMAP 的 `lastSeenUid` —— 那是个**必要推广**：
   *   Gmail 用的是 `historyId` 而不是 UID，把 UID 概念硬编码进同步编排
   *   会让加第二个 provider 时改不动。所以编排层只传一个不透明的 `cursor`。
   *
   *   - IMAP：`{ uid, uidValidity }`（UIDVALIDITY 变了说明邮箱重建，游标失效）
   *   - Gmail：`{ historyId }`
   *
   * `undefined` = 从未同步过（首次同步**只记游标、不拉历史**）。
   */
  cursor?: SyncCursor
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
  /**
   * 用户标记「不再显示」。
   * 入口：卡片展开后的操作行里那个「不再显示」按钮（`MailListItem` 的
   * `dismiss` 事件 → Popup / Sidepanel → `mail:dismiss`）。
   * 所有 tab 与 badge 都会跳过它（`list-filter.ts` 的 `filterMails`）。
   */
  dismissed?: boolean
  /** 验证码失效时刻（epoch ms）；AI 读出 `validForSeconds` 后由 pipeline 推算 */
  codeExpiresAt?: number
  /**
   * 验证码的**总有效期秒数**（进度条的分母）。
   *
   * ⚠ 与 `codeExpiresAt` **同生同灭**（见 `deriveCodeExpiry`）。
   *   只存失效时刻的话前端算不出比例 —— 那会让进度条每次打开弹窗都从 100%
   *   重新往下走（真机 bug：分母错用了「挂载那一刻的剩余量」）。
   */
  codeValidForSeconds?: number
  /** 进入回收站的时刻；有值 = 在回收站里（不进主列表、不占保留名额） */
  trashedAt?: number
  messageId?: string
  listUnsubscribe?: string
  ruleId?: string // 命中的规则 id（调试 / 跳转）
}

interface AiOutput {
  minimal: string // ≤60 字
  summary: string // ≤600 字
  isAd: boolean
  code?: string | null
  /**
   * AI 从邮件里读到的有效期（**秒**）。
   * ⚠ 模型看不到当前时间，所以只能给相对时长；换算成绝对时刻是 pipeline 的事。
   */
  validForSeconds?: number | null
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
  /**
   * 排除邮箱总开关；默认 true。
   * 完整模式「通用」页可关（关掉后 `isBlocked` 短路，per-account 的
   * `blockedList` 仍在 `accounts` 里）。
   */
  blockedEnabled: boolean
  notifyOnNew: boolean // master switch；默认 true
  popupDefaultTab: 'important' | 'all' | 'code' | 'ad' // 默认 'important'
  mailRetentionDays: number // M3+：默认 0 = 不按时间清理
  /** IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰。回收站里的不占名额 */
  mailRetention: 100 | 200 | 500 | 1000 | 'unlimited' // 默认 100
  /**
   * 失效验证码自动删除；**默认 true**。
   * 到了失效时刻**再等 30 秒**才移入回收站 —— 30 秒是给推算误差留的宽限，
   * 免得误删其实还有效的验证码（详见 features/07-trash.md § 4）。
   */
  autoDeleteExpiredCode: boolean // 默认 true
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
/** ⚠️ 实际只写过 'migration' 一个键 —— 没有 'init' */
type MetaKey = 'migration'

interface MetaDoc<T> {
  key: MetaKey
  value: T
}

interface MigrationMeta {
  state: 'done'
  from: 'chrome.storage.local'
  at: string // ISO
  checksums: Record<string, string> // FNV-1a 摘要，参考 offer-hunter
  /** 迁移过来的条数（目前只有 settings 这一路） */
  counts: { settings: number }
  /** 首次运行时为 true（没有旧数据可迁） */
  fresh?: boolean
}
```

> ⚠️ 早期文档里还有 `MetaKey = 'migration' | 'init'` 与一个 `InitMeta`，
> 以及 `conflictMergedAt` 字段 —— **代码里都不存在**（grep 不到）。
> 初始化状态不存在 `meta` 里，它只活在 `ready.ts` 那个模块级 promise 里。

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
export const DB_VERSION = 2

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
    { name: 'by-trashedAt', keyPath: 'trashedAt' }, // v2：回收站
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

  /*
   * v2：回收站。
   *
   * ⚠⚠ 必须是 `else if`，不是独立的 `if (oldVersion < 2)` ——
   *   全新安装时 oldVersion === 0，上面那个分支已经按 STORES 建好了全部索引
   *   （STORES 含 by-trashedAt），再 createIndex 会抛 ConstraintError，
   *   而 onupgradeneeded 里的异常让**整个升级事务 abort** ⇒ 库打不开。
   */
  else if (oldVersion < 2) {
    const mails = tx.objectStore('mails')
    if (!mails.indexNames.contains('by-trashedAt'))
      mails.createIndex('by-trashedAt', 'trashedAt')
  }
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