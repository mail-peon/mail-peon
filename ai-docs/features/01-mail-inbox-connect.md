# Feature 01 · 邮箱连接 & 新邮件监听

> 对应里程碑：**MVP**。目标：接入邮箱账号（通过 MailProvider 适配器），拉取并解析新邮件，把 Mail 落到 IndexedDB。
>
> **极简 + 完整两种模式都共用此层**——区别在拿到 Mail 后走哪个分支（`purseMinimal` vs `summarize`），详见 [`02-ai-summary.md`](./02-ai-summary.md) 与 [`../design/minimal-mode.md`](../design/minimal-mode.md)。
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
  id: 'imap' | 'gmail-oauth' | 'outlook-graph'
  /** 用户在 Options 看到的名字 */
  label: string
  hint: string
  /** 这家协议是否需要密码字段 */
  needsPassword: boolean
}

export interface MailProvider {
  /** 连接一个账号，返回可用的 MailConnection */
  connect: (account: MailAccount) => Promise<MailConnection>
}

export interface MailConnection {
  /**
   * 拿服务器当前的 UIDNEXT（即将被分配的下一个 UID）。
   * 首次同步：拿这个值后存到 `account.lastSeenUid`，**不拉任何邮件**。
   */
  getNextUid: () => Promise<number>
  /**
   * 拉 UID 大于 sinceUid 的所有新邮件。
   * 后续同步：传 account.lastSeenUid，拿到增量。
   */
  listSince: (sinceUid: number) => Promise<RawMail[]>
  /** 当前邮箱的 UIDVALIDITY（用于检测邮箱是否重建） */
  getUidValidity: () => Promise<number>
  logout: () => Promise<void>
}

export interface RawMail {
  /** RFC822 原始字节流（来自 IMAP `BODY.PEEK[]`） */
  source: Uint8Array
  /** 服务器给的 messageId（用于去重） */
  messageId?: string
  /** 该邮件的 IMAP UID（用来推进 lastSeenUid） */
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

### 3.3 MVP 实现：IMAP

`src/adapters/mail/providers/imap/index.ts`：

```ts
import type { MailProvider, MailProviderDefinition } from '../../types'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

export default {
  definition: {
    id: 'imap',
    label: 'IMAP（用户名密码）',
    hint: '通用；M3+ 再补 OAuth',
    needsPassword: true,
  } as MailProviderDefinition,

  create(): MailProvider {
    return {
      async connect(account) {
        const client = new ImapFlow({
          host: account.config.host!,
          port: account.config.port ?? 993,
          secure: account.config.tls ?? true,
          auth: { user: account.config.user!, pass: account.config.pass! },
          logger: false,
        })
        await client.connect()
        return {
          async listRecent(limit) {
            const lock = await client.getMailboxLock('INBOX')
            try {
              // 取最近 limit 封（按 UID 降序）
              const uids = await client.search({ all: true }, { uid: true })
              const recent = uids.slice(-limit).reverse()
              const out: RawMail[] = []
              for (const uid of recent) {
                const msg = await client.fetchOne(
                  String(uid),
                  { source: true, envelope: true, internalDate: true },
                  { uid: true },
                )
                if (!msg?.source)
                  continue
                out.push({
                  source: msg.source,
                  messageId: msg.envelope?.messageId ?? undefined,
                  uid,
                })
              }
              return out
            }
            finally { lock.release() }
          },
          async logout() { await client.logout() },
        }
      },
    }
  },
}
```

> **注意**：`emailjs-imap-client` 较老，新代码建议直接用 [`imapflow`](https://github.com/postalsys/imapflow)（虽然在 Node-only，但 MV3 SW 也能跑——SW 实际是 Node-like 环境）。实际选型时再 PoC；如果跑不通再退回 `emailjs-imap-client`。

### 3.4 后续 Provider（占位）

| `id` | 来源 | 状态 |
| --- | --- | --- |
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
syncAccount(account, appSettings)
        │
        ├─ 1. provider = createMailProvider(account.provider)
        ├─ 2. connection = provider.connect(account)
        │
        ├─ 3. 检查 UIDVALIDITY
        │     如果变了 → 警告 + 清零 account.lastSeenUid（详见 §4.2）
        │
        ├─ 4. 拉增量：
        │     if account.lastSeenUid == null
        │         account.lastSeenUid = connection.getNextUid() - 1   ← 不拉任何邮件
        │         return                                              ← 首次只记游标
        │     else
        │         raws = connection.listSince(account.lastSeenUid)
        │
        ├─ 5. for each raw:
        │     parsed = simpleParser(raw.source)
        │
        │     if appSettings.minimalMode:
        │         await purseMinimal(raw, parsed, account)        ← §4.1 极简分支
        │     else:
        │         mail = normalize(parsed, account.id)            ← §5
        │         if isBlocked(mail, account.blockedList): continue   ← §6
        │         await upsertMail(mail)                           ← §7 (含滚动)
        │         await enqueueAi(mail)
        │
        ├─ 6. account.lastSeenUid = max(old, max raws.uid)
        ├─ 7. account.lastSyncedAt = Date.now(); account.lastError = undefined; await put(...)
        └─ 8. connection.logout()
```

### 4.1 极简模式分支（`purseMinimal`）

> **极简模式 = 邮件根本不存，仅保留含验证码的邮件 + 头部信息**。详见 [`../design/minimal-mode.md` § 3](../design/minimal-mode.md)。

```ts
async function purseMinimal(raw: RawMail, parsed: ParsedMail, account: MailAccount) {
  // 预筛：不像有验证码 → 丢弃
  if (!looksLikeCodeEmail(parsed))
    return

  // 极简 AI：只取 code
  const { code } = await extractCodeOnly(parsed, account)

  // 没提到 → 丢弃
  if (!code)
    return

  // 自动复制
  const copied = await copyToClipboard(code)

  // 写最小记录
  await upsertMinimalMail({
    id: mailKey(account.id, raw.messageId ?? nanoid()),
    accountId: account.id,
    from: parsed.from?.value ?? [],
    subject: parsed.subject ?? '',
    code,
    receivedAt: (parsed.date as Date)?.getTime() ?? Date.now(),
    copyStatus: copied ? 'copied' : 'failed',
  })

  // 顶部 toast
  await sendMessage('mail:toast', {
    kind: 'code',
    mailId: minimalMail.id,
    from: parsed.from?.value?.[0]?.address ?? '',
    code,
    status: copied ? 'copied' : 'failed',
  }, { context: 'content-script', tabId: await getActiveTabId() })
}
```

### 4.2 UIDVALIDITY 处理

> IMAP 邮箱在某些情况下（重建、迁移、磁盘故障恢复）会让 `UIDVALIDITY` 改变；这意味着之前记录的 `lastSeenUid` **不再有意义**。

```ts
async function syncAccount(account, settings) {
  const connection = await provider.connect(account)
  const validity = await connection.getUidValidity()

  if (account.uidValidity && account.uidValidity !== validity) {
    // UIDVALIDITY 变了：清零游标，下次同步只记 UIDNEXT 不拉邮件；用户去邮箱自己看
    console.warn(`[mail-peon] 账号 ${account.label} 的 UIDVALIDITY 变了（${account.uidValidity} → ${validity}），已清零 lastSeenUid`)
    account.uidValidity = validity
    account.lastSeenUid = null
    account.lastError = '邮箱 UIDVALIDITY 变化；下次同步将从最新邮件开始（不再保留历史）'
    await put('accounts', account, account.id)
  }
  // ...正常同步
}
```

---

## 5. Normalize（`src/adapters/mail/parser.ts`）

`simpleParser` 输出 → `Mail`：

| 字段 | 来源 |
| --- | --- |
| `id` | `<accountId>:<messageId>`，**健**为 messageId 缺失时退化为 `nanoid()` |
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
| 账号 / 密码错 | `LOGIN Failed` | 写 `account.lastError`；下次同步跳过（直到用户重测） |
| TLS 失败 | `ECONNRESET` | 同上 |
| 解析某封失败 | `simpleParser` throw | 跳过该封，继续处理其余 |
| 网络抖动 | `ETIMEDOUT` | 单封失败不写 lastError；3 次连续失败才写 |
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