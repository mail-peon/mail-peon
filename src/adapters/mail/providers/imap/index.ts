import type { MailSocketFactory } from '../../transport/types'
import type { FetchResult, MailConnection, MailConnectionHooks, MailProvider, MailProviderDefinition, RawMail, SyncCursor, TestConnectionResult } from '../../types'
import type { ImapCursor, MailAccount } from '~/logic/types'
import { relaySocketFactory } from '../../transport/relay'
import { MailTransportUnavailableError } from '../../transport/types'
import { MAX_MESSAGES_PER_SYNC } from '../../types'
import { ImapClient } from './client'

/**
 * IMAP provider（用户名 + 密码）。
 *
 * ⚠ **在扩展里它需要一条隧道**：MV3 没有裸 TCP，字节必须经 WebSocket↔TCP 中继
 *   转发（见 `transport/relay.ts`）。所以 `config.relayUrl` 为空时这个 provider
 *   会明确地报「当前环境走不通」，而不是让用户对着一个超时干等。
 *
 * 游标形状（存进 `MailAccount.cursor`）：
 *
 *   { uid: number, uidValidity: number }
 *
 *   - `uid`：已同步过的最高 UID。**首次同步只记 `UIDNEXT - 1`，不拉任何历史**
 *     （设计文档的硬约束）。
 *   - `uidValidity`：邮箱代次。变化 ⇒ 之前记的 UID **不再有意义**（邮箱被重建 /
 *     迁移 / 从备份恢复），必须清零游标并警告用户。设计文档明确要求「不试图恢复：
 *     没有可靠的 ID 可以恢复」，所以这里只报警，不猜。
 */
export const definition: MailProviderDefinition = {
  id: 'imap',
  label: 'IMAP（用户名密码）',
  hint: '通用协议，支持任意邮箱；需要先在本机运行中继（pnpm relay）',
  availability: 'needs-relay',
  /*
   * ⚠ 这段文案要说实话。
   *
   * 之前的版本写的是「中继看不到明文（TLS 是端到端）」—— 那是**错的**：
   * 993 是 implicit TLS，中继必须自己完成 TLS 握手才能跟邮件服务器通话，
   * 而握手完成后明文就在中继进程里，**包括用户的邮箱密码**。
   *
   * 这不是实现缺陷，是 TLS 的协议结构决定的（谁终止握手谁看到明文）。
   * 所以正确的做法是：默认只绑 127.0.0.1，并把这件事明说，
   * 让用户知道「自己跑中继」等于「密码留在自己机器上」。
   */
  availabilityNote:
    '浏览器扩展里没有裸 TCP，IMAP 必须经 WebSocket↔TCP 中继转发字节。'
    + '中继需要完成 TLS 握手，因此它能看到你的邮箱密码 —— 所以请把中继跑在'
    + '本机（默认只监听 127.0.0.1），这样凭据不会离开你的电脑。',
  fields: [
    { key: 'host', label: 'IMAP 服务器', type: 'text', placeholder: 'imap.qq.com', required: true },
    { key: 'port', label: '端口', type: 'number', default: 993, required: true },
    { key: 'tls', label: '使用 TLS（993 端口必须开）', type: 'toggle', default: true },
    { key: 'user', label: '用户名', type: 'text', placeholder: '你的QQ号@qq.com', required: true },
    { key: 'pass', label: '密码 / 授权码', type: 'password', placeholder: 'QQ 邮箱填 16 位授权码', required: true },
    {
      key: 'relayUrl',
      label: 'WebSocket 中继地址',
      type: 'text',
      /*
       * ⚠ `default` 而不是只给 `placeholder`：本机中继是 99% 的场景，
       *   给默认值让用户**不用填**（也避免他把 `https://` 或裸 `127.0.0.1:41316`
       *   填进来 —— 那两种都不是合法的中继地址，而报错会出现在「测试连接」，
       *   用户很难联想到是地址格式问题）。
       */
      default: 'ws://127.0.0.1:41316/',
      placeholder: 'ws://127.0.0.1:41316/',
      required: true,
    },
  ],
}

/** 允许测试注入假 socket（见 `transport/types.ts` 的 `MailSocketFactory`） */
let socketFactory: MailSocketFactory = relaySocketFactory

/** 仅供测试：替换传输实现 */
export function setImapSocketFactory(factory: MailSocketFactory): void {
  socketFactory = factory
}

function readCursor(cursor: SyncCursor): ImapCursor | null {
  if (!cursor)
    return null
  const uid = cursor.uid
  if (typeof uid !== 'number' || !Number.isFinite(uid))
    return null
  const uidValidity = typeof cursor.uidValidity === 'number' ? cursor.uidValidity : undefined
  return { uid, uidValidity }
}

function requireConfig(account: MailAccount) {
  const { host, user, pass, port, tls } = account.config
  if (!host)
    throw new Error('缺少 IMAP 服务器地址')
  if (!user)
    throw new Error('缺少用户名')
  if (pass === undefined || pass === '')
    throw new Error('缺少密码')
  return { host, user, pass, port: port ?? 993, tls: tls ?? true, relayUrl: account.config.relayUrl }
}

/** 建连 + 登录 + 选中收件箱，把三件事收成一处（每个调用方都少不了这三步） */
async function openInbox(account: MailAccount) {
  const config = requireConfig(account)
  const socket = await socketFactory({
    host: config.host,
    port: config.port,
    tls: config.tls,
    relayUrl: config.relayUrl,
  })

  const client = new ImapClient(socket)
  try {
    await client.login(config.user, config.pass)
    const status = await client.selectInbox()
    return { client, status }
  }
  catch (error) {
    client.dispose()
    throw error
  }
}

export function create(): MailProvider {
  return {
    id: definition.id,

    async connect(account: MailAccount, _hooks?: MailConnectionHooks): Promise<MailConnection> {
      const { client, status } = await openInbox(account)
      /** 连接建立时看到的 UIDVALIDITY —— 与游标里存的不一致就说明邮箱被重建了 */
      const uidValidity = status.uidValidity
      const uidNext = status.uidNext

      /**
       * 首次同步要落下的游标（三处复用，抽一个局部函数）。
       *
       * UIDNEXT 是「下一封将获得的 UID」，所以最后一封已有的邮件是 `uidNext - 1`。
       * 拿不到有效 UIDNEXT（= 0，某些服务器在空邮箱上也这么回）时返回 `null` ——
       * 落一个假游标（比如 0）会让下次把整箱历史当增量拉下来。
       */
      const initialCursor = (): SyncCursor => {
        if (!Number.isFinite(uidNext) || uidNext <= 0)
          return null
        return { uid: uidNext - 1, uidValidity } satisfies ImapCursor
      }

      return {
        async getInitialCursor(): Promise<SyncCursor> {
          // 首次同步：**只记游标，不拉任何邮件**（设计文档 Q5 的硬约束）
          return initialCursor()
        },

        async fetchSince(cursor: SyncCursor): Promise<FetchResult> {
          const previous = readCursor(cursor)
          if (!previous) {
            // 没有游标却来拉增量：说明调用方跳过了 getInitialCursor。
            // 这里**宁可什么都不拉**（返回空 + 写回一个有效游标），也不猜 ——
            // 猜错的代价是用户被灌一箱历史邮件。
            return { mails: [], nextCursor: initialCursor() }
          }

          if (previous.uidValidity !== undefined && uidValidity !== undefined && previous.uidValidity !== uidValidity) {
            /*
             * UIDVALIDITY 变了：邮箱被重建 / 迁移 / 从备份恢复，之前记的 UID 不再有意义。
             * 设计文档明确要求「检测到就清零 + 警告用户，**不试图恢复**」——
             * 没有可靠的 ID 能把新旧 UID 对应起来，任何「恢复」都是猜。
             */
            const warning
              = `邮箱的 UIDVALIDITY 已变化（${previous.uidValidity} → ${uidValidity}），`
                + '历史游标已失效。本次从最新邮件开始，之前的邮件不会补拉 —— 需要的话请去邮箱里看。'
            return { mails: [], nextCursor: initialCursor(), warning }
          }

          /*
           * ⚠ 这里**不能**用 `client.fetchSince(previous.uid, { limit: 50 })`
           *   （原来的写法），它在本例这种真实邮箱上必然超时并丢邮件：
           *
           *   - `UID FETCH <cursor+1>:*` 会让服务器把**游标之后的所有邮件正文**
           *     都发过来，`limit` 只是收完之后在客户端做的截断。该邮箱有 35492 封、
           *     游标在 37727，积压几千封 → 几千次 `BODY.PEEK[]` 全量传输 →
           *     撞爆中继的 30 秒命令超时。
           *   - 更要命的是它保留的是**最新**的 50 封、然后把游标直接推到 UIDNEXT-1，
           *     中间那几千封**永远不会再被拉取**（游标已经越过它们了）。这是静默丢件。
           *
           * 正确做法分两步：先 SEARCH 拿 UID 列表（只有整数，几乎不占带宽），
           * 再取**最旧**的一批 —— 这样每一轮都在推进游标，积压会多轮消化完，
           * 而且任何一轮失败都只影响那一批。
           */
          const backlog = await client.searchSince(previous.uid)

          if (!backlog.length) {
            // 没有新邮件：游标推到 UIDNEXT-1 是安全的（它只代表「服务器上已有的都看过了」）
            return {
              mails: [],
              nextCursor: { uid: Math.max(uidNext > 0 ? uidNext - 1 : 0, previous.uid), uidValidity } satisfies ImapCursor,
            }
          }

          // 取最旧的一批（不是最新的）—— 见上面关于「静默丢件」的说明
          const batch = backlog.slice(0, MAX_MESSAGES_PER_SYNC)
          const fetched = await client.fetchRange(batch[0], batch[batch.length - 1])

          const mails: RawMail[] = fetched
            .filter(message => message.source.length > 0)
            .map(message => ({
              source: message.source,
              // `BODY.PEEK[]` 只给原始邮件；messageId 要从 MIME 头里解析（由 parser.ts 负责）
              // —— 这里不假装知道
              messageId: undefined,
              seq: message.uid,
            }))

          /*
           * 游标只推进到**本批最大的 UID**，而不是 UIDNEXT-1。
           *
           * ⚠ 这一点与上面「没有新邮件」那条分支不同，不能混：
           *   本批之后还有积压时，把游标推到 UIDNEXT-1 就等于宣布「剩下的都处理过了」，
           *   于是它们被永久跳过。下一轮心跳会从本批末尾继续，把积压一轮轮吃完。
           *
           * 取 `max(batch 最大 UID, 实际解析出的最大 UID, 旧游标)`：
           * 被过滤掉的条目（正文为空）也要计入推进，否则会卡在同一批上反复重拉。
           */
          const batchMax = batch[batch.length - 1]
          const maxFetched = mails.reduce((max, mail) => Math.max(max, mail.seq), batchMax)

          return {
            mails,
            nextCursor: { uid: Math.max(maxFetched, previous.uid), uidValidity } satisfies ImapCursor,
          }
        },

        async logout(): Promise<void> {
          await client.logout()
        },
      }
    },

    async testConnection(account: MailAccount): Promise<TestConnectionResult> {
      try {
        const { client, status } = await openInbox(account)
        await client.logout()
        const validity = status.uidValidity ? `，UIDVALIDITY ${status.uidValidity}` : ''
        return { ok: true, detail: `收件箱有 ${status.exists} 封邮件${validity}` }
      }
      catch (error) {
        // 传输层不可用（没配中继）要单独说清楚 —— 它不是「你填错了」
        if (error instanceof MailTransportUnavailableError)
          return { ok: false, error: error.message }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
