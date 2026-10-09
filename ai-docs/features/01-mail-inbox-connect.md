# Feature 01 · 邮箱连接 & 新邮件监听

> 对应里程碑：**MVP**。目标：接入邮箱账号（通过 MailProvider 适配器），拉取并解析新邮件，把 Mail 落到 IndexedDB。
>
> **极简 + 完整两种模式都共用此层**——区别在拿到邮件后走哪个分支（`processMinimal` vs `processFull`），详见 [`02-ai-summary.md`](./02-ai-summary.md) 与 [`../design/minimal-mode.md`](../design/minimal-mode.md)。
>
> 架构完全镜像 `offer-hunter/src/adapters/sites/` 与 `offer-hunter/src/logic/store/`。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 用户在 Options 里能"新增 / 修改 / 删除"邮箱账号 |
| G2 | 后台周期性**增量**拉取新邮件（**首次不拉历史**），并解析出结构化 Mail |
| G3 | UIDVALIDITY 变化检测：邮箱重建时清零游标并提示 |
| G4 | 拉到的邮件经过「per-account 排除邮箱」过滤（仅完整模式）后入库 |
| G5 | UI 上**单账号视图**，但数据层支持多账号（M3+ UI 才会做账号切换） |
| G6 | MailProvider 注册表按目录聚合（新增 provider 不改注册表） |

---

## 2. 账号模型

```ts
interface MailAccount {
  id: string // = accountId（外键）
  label: string
  email: string
  provider: 'imap' // MVP 仅 imap
  config: ProviderConfig // IMAP { host, port, user, pass } 或 OAuth { ... }
  blockedList: BlockedEntry[] // per-account 排除邮箱
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string
}
```

详细见 [`../design/data-model.md` § 1](../design/data-model.md) 与 [`../design/storage.md`](../design/storage.md)。

---

## 3. MailProvider 适配器

> **架构同构**：`offer-hunter/src/adapters/sites/<id>/` 与 `offer-hunter/src/adapters/sites/registry.ts`。

### 3.1 抽象（`src/adapters/mail/types.ts`）

```ts
import type { MailAccount } from '~/logic/types'

export interface MailProviderDefinition {
  /** 协议 id，必须等于 `src/adapters/mail/providers/<id>/index.ts` 目录名 */
  id: string                          // ⚠ 开放字符串；已实现 'imap' / 'gmail'
  /** 用户在 Options 看到的名字 */
  label: string
  hint: string
  /** 表单字段定义（不是 `needsPassword` 布尔量 —— 各 provider 字段完全不同） */
  fields: MailProviderField[]
  /** 能否直接用：'ready' = 现在就能连 */
  availability: 'ready' | 'needs-relay' | 'planned'
  availabilityNote?: string
}

export interface MailProvider {
  /** 连接一个账号，返回可用的 MailConnection */
  connect: (account: MailAccount, hooks?: MailConnectionHooks) => Promise<MailConnection>
  /** 「测试连接」用它 —— 与 connect 分开，因为测试不需要留着连接 */
  testConnection: (account: MailAccount) => Promise<TestResult>
}

/**
 * ⚠️ 游标是**不透明**的（`SyncCursor`），不是「一个 UID 数字」。
 *   IMAP 放 `{ uid, uidValidity }`，Gmail 放 `{ historyId }` ——
 *   把 UID 概念写死进接口，加第二个 provider 时就得改编排层。
 */
export interface MailConnection {
  /**
   * 首次同步用：拿「现在的游标」，**不拉任何邮件**。
   * IMAP 实现是 `UIDNEXT - 1`（不是 `UIDNEXT` —— 否则会漏掉最后一封）。
   */
  getInitialCursor: () => Promise<SyncCursor>
  /**
   * 从 `cursor` 之后拉**一批**（≤ `MAX_MESSAGES_PER_SYNC = 50`）。
   *
   * ⚠️ 一轮只调一次，不做轮内循环 —— 积压由后续心跳一轮轮吃完
   *   （见 `design/sync-flow.md § 6`）。
   */
  fetchSince: (cursor?: SyncCursor) => Promise<FetchResult>
  logout: () => Promise<void>
}

export interface FetchResult {
  mails: RawMail[]
  /**
   * ⚠️ `nextCursor` 与 `mails` **一起**返回，而不是让编排层自己从 mails 里取 max：
   *   它只能推进到**本批确实处理过的**位置 —— 否则中途失败会丢件。
   */
  nextCursor: SyncCursor
  /** 邮箱被重建（UIDVALIDITY 变了）时为 true —— 此时游标作废，不清零会拉不到任何东西 */
  uidValidityChanged?: boolean
}

export interface RawMail {
  /** RFC822 原始字节流（来自 IMAP `BODY.PEEK[]`） */
  source: Uint8Array
  /** 服务器给的 messageId（用于去重） */
  messageId?: string
  /** 该邮件的 IMAP UID（IMAP provider 用它推进游标） */
  uid: number
}
```

### 3.2 注册表（`src/adapters/mail/registry.ts`）

参考 `offer-hunter/adapters/collect.ts` 的同构 collectAdapters：

```ts
import type { MailProvider, MailProviderDefinition } from './types'
import { collectAdapters } from '../collect'

export const MAIL_PROVIDERS: MailProviderDefinition[] = collectAdapters(
  import.meta.glob<{ default: { definition: MailProviderDefinition, create: () => MailProvider } }>(
    './providers/*/index.ts',
    { eager: true },
  ),
).map(mod => mod.default.definition)

/** 按 id 取 provider factory */
export function createMailProvider(id: MailProviderDefinition['id']): MailProvider {
  const factory = collectAdapters(
    import.meta.glob<{ default: { definition: MailProviderDefinition, create: () => MailProvider } }>(
      './providers/*/index.ts',
      { eager: true },
    ),
  ).find(mod => mod.default.definition.id === id)
  if (!factory)
    throw new Error(`Unknown mail provider: ${id}`)
  return factory.default.create()
}
```

> **新增 Provider = 加一个 `src/adapters/mail/providers/<id>/index.ts`**。注册表自动发现，**不需改** `registry.ts`。

### 3.3 实现：IMAP（自研客户端）

**不是用现成库** —— `imapflow` / `emailjs-imap-client` / `node-imap` 都绑死 Node 的
`net`，而 MV3 的 Service Worker 里**没有裸 TCP**（见
[`adr-0005`](../decisions/adr-0005-imap-needs-relay.md)）。所以：

```
src/adapters/mail/providers/imap/
├── client.ts   ← 自研 IMAP4 客户端（LOGIN / SELECT / UID SEARCH / UID FETCH / IDLE）
├── socket.ts   ← MailSocket 抽象：同一份客户端既能走中继，也能在 Node 里直连
└── index.ts    ← 实现 MailProvider（getInitialCursor / fetchSince）
```

只做需要的命令与解析，不做语法树：**字面量**（`{N}` 后的精确 N 字节）+ 行内扫描。
MIME 解析交给 `postal-mime`（零依赖、纯浏览器），**不是** `mailparser`
（它基于 Node `stream`，浏览器里要一堆 polyfill）。

取「最近 N 封」的实际做法（`getInitialCursor` 的兄弟路径）：

```
UID SEARCH ALL            → 得到全部 UID
slice(0, 50)              → 取**最旧的** 50 封（不是最新的！）
UID FETCH <首>:<尾>       → 只传这一批的正文
游标推进到本批最大 UID
```

> ⚠️「取最旧的 50 封」是个真机修出来的结论：最初取「最新 50 封」并把游标
> 直接跳到 `UIDNEXT - 1`，于是**中间几万封被静默跳过** ——
> 用户邮箱有 3.5 万封时表现为「同步很快完成，但老邮件全没了」。
> 正确做法是**按顺序一批批吃完**，游标只推进到确实处理过的地方。

### 3.4 后续 Provider

| `id` | 来源 | 状态 |
| --- | --- | --- |
| `imap` | 用户名密码 + 本机中继 | ✅ 已实现 |
| `gmail` | Gmail REST API + OAuth | ✅ 已实现（不需要中继） |
| `outlook` | Microsoft Graph | ⬜ 待实现 |
| `gmail-oauth` | Gmail API | M3+ |
| `outlook-graph` | Microsoft Graph | M3+ |

---

## 4. Mailbox 编排（`src/adapters/mail/mailbox.ts`）

```
触发者（三者走同一条路）
  • 中继推送「有新邮件」
  • 兜底定时器（chrome.alarms，10 分钟）
  • 用户点「立即同步增量」
        │
        ▼
syncAccount(account, pipeline, options)          ← 签名见 mailbox.ts
        │
        ├─ 1. provider = createMailProvider(account.provider)
        ├─ 2. connection = provider.connect(account, hooks)
        │
        ├─ 3. 拉增量（**一轮只一批**）：
        │     if account.cursor == null                 ← 首次同步
        │         account.cursor = await connection.getInitialCursor()
        │         return                                ← 只记游标，不拉任何邮件
        │
        │     result = await connection.fetchSince(account.cursor)
        │     if result.uidValidityChanged → 游标重置到最新（详见 §4.2）
        │
        ├─ 4. for each raw in result.mails:
        │     parsed = await parseMail(raw.source)      ← postal-mime
        │
        │     if appSettings.minimalMode:
        │         await pipeline.processMinimal(mail)   ← §4.1 极简分支
        │     else:
        │         mail = normalize(parsed, account.id)  ← §5
        │         if isBlocked(mail, account.blockedList): continue   ← §6
        │         await pipeline.process(mail)          ← AI + 入库 + 滚动淘汰
        │
        ├─ 5. account.cursor = result.nextCursor        ← **本批**的最大位置
        ├─ 6. account.lastSyncedAt = Date.now(); account.lastError = undefined
        └─ 7. connection.logout()
```

> ⚠️ 与早期流程图的差别（都是改过的）：
> - 签名是 `syncAccount(account, pipeline, options)`，不是 `(account, appSettings)`；
> - **没有 `enqueueAi`** —— AI 调用在 `pipeline.process()` 里；
> - 游标是 `account.cursor`（不透明对象），不是 `lastSeenUid`；
> - 第 5 步只在**整批成功**后才推进；中途抛错就写 `lastError` 且**不动游标**。

### 4.1 极简模式分支

**极简模式 = 含验证码的邮件保留（瘦身），其余根本不入库**。

实现是 `logic/ai/pipeline.ts` 的 `processMinimal(mail)` ——
**函数体不在这里重复**（早期两处各写一份，改了这边忘了那边）。
看 [`../design/minimal-mode.md § 3.2`](../design/minimal-mode.md)，
那里有一份与代码同步的版本。

三点这里要记住的：

1. 它按**同一张 `Mail` 表**写记录（未用字段留空），不是第二套 schema；
2. 保留数量**写死 50**（`MINIMAL_RETENTION`），不读用户的 `mailRetention`；
3. **没有降级**：AI 没提取到验证码就丢弃该邮件，不入库、不弹 toast。
### 4.2 UIDVALIDITY 处理

> IMAP 邮箱在某些情况下（重建、迁移、磁盘故障恢复）会让 `UIDVALIDITY` 改变；
> 这意味着之前记录的游标 **不再有意义**。

游标是 `{ uid, uidValidity }` 一起存的，所以检测就是比一下：

```ts
const connection = await provider.connect(account)

// fetchSince 内部读到 UIDVALIDITY 与游标里的不一致 → 置 uidValidityChanged
const result = await connection.fetchSince(account.cursor)

if (result.uidValidityChanged) {
  /*
   * ⚠️ 做法是**把游标换成「现在」**（UIDNEXT - 1），不是清零成 undefined。
   *   清零的话下一轮会走「首次同步」分支，也就是**只记游标不拉邮件** ——
   *   结果一样，但要多一轮心跳才追平。
   *
   * ⚠️ 刻意**不做恢复**：UID 已经全部重新分配，没有可靠的映射能把旧 UID
   *   对应到新 UID。试图「恢复」只会拉到一堆无关邮件。
   */
  console.warn(`[mail-peon] ${account.label} 的 UIDVALIDITY 变了 → 游标重置到最新`)
  account.cursor = await connection.getInitialCursor()
  account.lastError = '邮箱 UIDVALIDITY 变化；已从最新邮件重新开始'
  await upsertAccount(account)
}
```

---

## 5. Normalize（`src/adapters/mail/parser.ts`）

`postal-mime` 解析结果 → `Mail`：

| 字段 | 来源 |
| --- | --- |
| `id` | `<accountId>:<messageId>`，**键**为 messageId 缺失时退化为 `nanoid()` |
| `accountId` | 当前 account |
| `from` / `to` / `cc` | `{ name, address }[]` |
| `subject` | text |
| `snippet` | `text.slice(0, 240)` |
| `bodyText` | `text` |
| `bodyHtml` | ⚠ **MVP 不存**（隐私 + 体积） |
| `receivedAt` | `internalDate` 或 `date` → ts |
| `messageId` | 来自 server |
| `listUnsubscribe` | header |

完整字段见 [`../design/data-model.md` § 3](../design/data-model.md)。

---

## 6. 排除邮箱（per-account）

详见 [`./06-blocked-senders.md`](./06-blocked-senders.md)。匹配发生在 normalize 之后、upsertMail 之前；**过滤掉的邮件不入库、不调 AI、不计 badge、不弹 toast**。

---

## 7. 持久化（IndexedDB）

> 详见 [`../design/storage.md § 5`](../design/storage.md)。这里只列 M1 涉及的函数。

```ts
// src/logic/store/mails.ts
export async function upsertMail(mail: Mail): Promise<void> {
  await runTx(['mails'], 'readwrite', async (ctx) => {
    await put('mails', mail, mailKey(mail.accountId, mail.messageId ?? mail.id), ctx)
    await pruneMails(ctx) // 滚动 100 封
  })
}

export async function readRecentMails(limit: number): Promise<Mail[]> {
  // 用 `iterate()` + `by-receivedAt` 索引倒序，limit 默认 200
  const out: Mail[] = []
  await iterate<Mail>(
    'mails',
    { index: 'by-receivedAt', direction: 'prev', limit },
    value => out.push(value),
  )
  return out
}
```

---

## 8. 跨上下文消息

| Channel | Payload |
| --- | --- |
| `mail:list` | `void` → `{ mails: Mail[] }` |
| `accounts:list` / `upsert` / `delete` / `test` | options ↔ bg |
| `mail:updated` | bg → popup/sidepanel：某封 AI 处理完成（M2） |

详见 [`../01-architecture.md § 3`](../01-architecture.md)。

---

## 9. 触发收信的三种方式

三者**共用同一条** `runSyncCycle` 路径 —— 分成多条的话，差别会表现为
「手动能拉到、自动拉不到」，而这种 bug 在真机上极难排查（两边看起来都「成功」了）。

| 触发者 | 时机 | 作用 |
| --- | --- | --- |
| **中继推送** | 新邮件到达时（中继常驻 `IDLE`） | 主要手段。见 [`../design/sync-flow.md`](../design/sync-flow.md) |

```ts
// src/background/main.ts
// 兜底定时器：推送失效时的保险丝（中继没起 / 连接没恢复）
chrome.alarms.create('mail-peon:sync', { periodInMinutes: 10 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mail-peon:sync')
    return
  await ensureStoreReady()
  const accounts = await listEnabledAccounts()
  for (const acc of accounts) {
    try {
      await syncAccount(acc)
    }
    catch (e) {
      await markAccountError(acc.id, errorText(e))
    }
  }
})
```

> **为什么兜底也要用 alarms**：MV3 Service Worker 空闲约 30 秒被回收，
> `setInterval` 不靠谱。`alarms` 是 Chrome 提供的定时机制（最小间隔由 Chrome 限制，
> 约 30 秒 / 1 分钟）。
>
> **为什么周期给到 10 分钟**：正常情况推送会立刻触发，这个定时器每次都拉 0 封 ——
> 给短了只是白白打扰邮箱。它的职责是「保证最终一定会收到」，不是「保证及时」。

---

## 10. 错误分类与处理

| 错误 | 现象 | 处理 |
| --- | --- | --- |
| 账号 / 密码错 | `LOGIN Failed` | 写 `account.lastError` 并在 Options 展示。**不做跳过** —— 下一轮仍会重试同一段游标（用户改对密码后自动恢复） |
| TLS 失败 | `ECONNRESET` | 同上 |
| 解析某封失败 | `postal-mime` throw | 跳过该封并计入 `failed`，继续处理其余 |
| 网络抖动 | `ETIMEDOUT` | 账号级失败立即写 `account.lastError`（**没有** 3 次阈值）；单封失败只计入 `failed` |
| IDB 事务回滚 | `TransactionInactiveError` | 调整 IDB 调用模式（参见 `design/storage.md` 头部规矩） |

---

## 11. 验收清单

- [ ] 新增 IMAP 账号 → "测试通过"
- [ ] 中继推送 → 插件几秒内拉到新邮件（不依赖定时器）
- [ ] 拉取的邮件能在 Popup 显示（至少 20 封）
- [ ] `lastError` 正确写入并展示在 Options
- [ ] 重启浏览器后 accounts / mails 都还在（IndexedDB 持久化 OK）
- [ ] 该账号的 `blockedList` 中的发件人完全没出现
- [ ] MailProvider 注册表按目录聚合：`registry.test.ts` 写死"加 provider 不需改注册表"
- [ ] IDB 单测 80% 覆盖（`upsertMail` / `pruneMails` / `readRecentMails`）

---

## 12. 后续读什么

- AI 处理（多 provider）：[`02-ai-summary.md`](./02-ai-summary.md)
- 排除邮箱（per-account）：[`06-blocked-senders.md`](./06-blocked-senders.md)
- 存储 schema：[`../design/storage.md`](../design/storage.md)