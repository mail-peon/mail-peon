import type { FetchResult, MailConnection, MailConnectionHooks, MailProvider, MailProviderDefinition, RawMail, SyncCursor, TestConnectionResult } from '../../types'
import type { MailAccount } from '~/logic/types'
import { MAX_MESSAGES_PER_SYNC } from '../../types'
import {
  ensureAccessToken,
  getProfile,
  getRawMessage,
  GmailAuthError,
  GmailHistoryExpiredError,
  listHistory,
  listMessagesAfter,
} from './api'

/**
 * Gmail provider（OAuth 2.0 + Gmail REST API）。
 *
 * **这是唯一「装上就能收到真邮件」的路径**：纯 HTTPS，不需要中继、不需要 native host。
 * IMAP 需要一条 WebSocket↔TCP 隧道才能用（见 `providers/imap/`）。
 *
 * 游标形状（存进 `MailAccount.cursor`）：
 *
 *   { historyId: string, syncedAt: number }
 *
 *   - `historyId`：Gmail 的增量游标。**首次同步只记它，不拉任何历史**
 *     （设计文档的硬约束）。
 *   - `syncedAt`：上次同步时刻。存在的唯一理由是给 `historyId` 过期（Gmail 只保留
 *     约一周）时的回退路径用：`messages.list?q=after:<syncedAt>` 需要它。
 *     没有这个值时回退只能盲猜一个时间窗 —— 猜大了灌历史，猜小了丢邮件。
 *
 * 与 IMAP 的关系：两者都产出**原始 RFC822 字节**（Gmail 用 `format=raw`），
 * 所以「原始邮件 → Mail」的解析是**同一份代码**（`parser.ts`）。
 * 两套 payload 解析意味着两套编码 / 附件 / 线程头的坑。
 */
export const definition: MailProviderDefinition = {
  id: 'gmail',
  label: 'Gmail（OAuth）',
  hint: '推荐。浏览器原生支持，不需要中继；只读收件箱，不会改动你的已读状态',
  availability: 'ready',
  fields: [
    {
      key: 'clientId',
      label: 'Google OAuth Client ID',
      type: 'text',
      placeholder: 'xxxxx.apps.googleusercontent.com',
      required: true,
    },
    { key: 'refreshToken', label: 'Refresh Token', type: 'password', required: true },
  ],
}

function readCursor(cursor: SyncCursor): { historyId: string | null, syncedAt: number | null } {
  if (!cursor)
    return { historyId: null, syncedAt: null }
  return {
    historyId: typeof cursor.historyId === 'string' && cursor.historyId ? cursor.historyId : null,
    syncedAt: typeof cursor.syncedAt === 'number' ? cursor.syncedAt : null,
  }
}

/** 回退路径的时间窗：没有 `syncedAt` 时往回看多久（宁可重复也不漏 —— 重复写只是覆盖同一个键） */
const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000

/** 把刷新出来的 token 写回账号（由调用方注入，避免这一层直接依赖存储） */
type TokenSink = (token: { token: string, expiresAt: number }) => Promise<void> | void

async function buildConnection(account: MailAccount, onRefreshed: TokenSink): Promise<MailConnection> {
  // 连接即鉴权：拿不到 token 就没有必要继续（错误信息也更准 —— 是授权问题而不是网络问题）
  await ensureAccessToken(account, onRefreshed)

  async function initialCursor(): Promise<SyncCursor> {
    const profile = await getProfile(account, onRefreshed)
    if (!profile.historyId)
      return null
    return { historyId: String(profile.historyId), syncedAt: Date.now() } satisfies Record<string, unknown>
  }

  return {
    getInitialCursor: initialCursor,

    async fetchSince(cursor: SyncCursor): Promise<FetchResult> {
      const previous = readCursor(cursor)
      if (!previous.historyId) {
        // 没有游标却来拉增量：说明调用方跳过了 getInitialCursor。
        // 宁可什么都不拉（返回空 + 写回有效游标），也不猜 —— 猜错的代价是灌一箱历史。
        return { mails: [], nextCursor: await initialCursor() }
      }

      let ids: Array<{ id: string, threadId?: string }> = []
      let nextHistoryId = previous.historyId
      let warning: string | undefined

      try {
        const history = await listHistory(account, previous.historyId, onRefreshed)
        ids = history.messages
        if (history.historyId)
          nextHistoryId = history.historyId
      }
      catch (error) {
        if (!(error instanceof GmailHistoryExpiredError))
          throw error

        // history 过期（游标放了一周以上）：回退为按时间拉。
        // 这不是错误，是 Gmail API 的固有约束，所以只提示、不写 lastError。
        warning = error.message
        const since = previous.syncedAt ?? (Date.now() - FALLBACK_LOOKBACK_MS)
        ids = await listMessagesAfter(account, since, MAX_MESSAGES_PER_SYNC, onRefreshed)
        // 回退之后 historyId 需要重新取：旧的已经不可用
        const profile = await getProfile(account, onRefreshed)
        nextHistoryId = String(profile.historyId)
      }

      // 去重：history 可能把同一封邮件报两次（加标签 + 进收件箱）
      const uniqueIds = [...new Map(ids.map(item => [item.id, item])).values()].slice(0, MAX_MESSAGES_PER_SYNC)

      const mails: RawMail[] = []
      for (const [index, item] of uniqueIds.entries()) {
        try {
          const source = await getRawMessage(account, item.id, onRefreshed)
          mails.push({ source, messageId: item.id, seq: index })
        }
        catch (error) {
          /*
           * 单封失败不能拖垮整轮同步：Gmail 在邮件被删除/移到垃圾箱的瞬间会 404，
           * 而那封邮件本来也不该入库。但**游标必须照常推进**（下面用 historyId），
           * 否则下一轮还会拉到它、再失败一次，永久卡住。
           */
          console.warn(`[mail-peon] 跳过无法读取的 Gmail 邮件 ${item.id}`, error)
        }
      }

      return {
        // Gmail 的游标是 historyId 而不是序号，所以 `RawMail.seq` 只用于本轮内的稳定排序；
        // 真正的续传点由 nextHistoryId 表达
        mails,
        nextCursor: { historyId: nextHistoryId, syncedAt: Date.now() } satisfies Record<string, unknown>,
        warning,
      }
    },

    /** Gmail 没有 UIDVALIDITY 那种「代次」概念；historyId 的失效由 404 表达 */
    async getMailboxTag(): Promise<string | number | null> {
      return previousHistoryTag(account)
    },

    async logout(): Promise<void> {
      // Gmail API 是无状态 REST：没有会话要关。token 留在账号配置里，
      // 由用户显式「取消授权」时才清（那是 Options 的动作，不是这里）。
    },
  }
}

function previousHistoryTag(account: MailAccount): string | null {
  const { historyId } = readCursor(account.cursor ?? null)
  return historyId
}

export function create(): MailProvider {
  return {
    id: definition.id,

    connect(account: MailAccount, hooks?: MailConnectionHooks): Promise<MailConnection> {
      // ⚠ 刷新后的 token 由 `hooks.onTokenRefreshed` 交回编排层写存储：
      //   provider 层没有存储依赖（它要能跑在单测里），也不该有 ——
      //   见 `MailConnectionHooks` 的说明（模块级 sink 会让两个账号串号）。
      return buildConnection(account, hooks?.onTokenRefreshed ?? (() => {}))
    },

    async testConnection(account: MailAccount, hooks?: MailConnectionHooks): Promise<TestConnectionResult> {
      try {
        const profile = await getProfile(account, hooks?.onTokenRefreshed ?? (() => {}))
        const who = profile.emailAddress || account.email
        return {
          ok: true,
          detail: `已连接 ${who}，收件箱共 ${profile.messagesTotal} 封（首次同步只记游标，不会拉历史）`,
        }
      }
      catch (error) {
        if (error instanceof GmailAuthError)
          return { ok: false, error: error.message }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
