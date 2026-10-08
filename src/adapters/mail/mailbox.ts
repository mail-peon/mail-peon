import type { MailConnectionHooks, MailProvider, RawMail, SyncCursor } from './types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { Mail, MailAccount, MailRetention } from '~/logic/types'
import { isBlocked } from '~/logic/rules/blocked'
import { markAccountError, markAccountSynced, upsertAccount } from '~/logic/store/accounts'
import { parseRawMail, toMail } from './parser'
import { createMailProvider } from './registry'

/**
 * 邮箱同步编排（`ai-docs/features/01-mail-inbox-connect.md § 4`）。
 *
 * 职责边界刻意画在「provider 给原始邮件」和「pipeline 处理 Mail」之间：
 * 本文件**不知道**极简 / 完整模式的区别，也**不知道** AI 怎么调 —— 那些都是
 * `MailPipeline` 的实现细节。这样做的收益在测试上最明显：给一个假 provider +
 * 一个假 pipeline，整条同步流程可以在没有网络、没有 AI、没有真邮箱的情况下跑完。
 *
 * 流程（顺序不能换）：
 *
 *   1. `provider.connect(account)`
 *   2. 首次同步（游标为空）→ `getInitialCursor()` → **只写游标，一封都不拉**
 *   3. 后续同步 → `fetchSince(cursor)` → 逐封解析
 *   4. per-account 排除邮箱过滤（仅完整模式；命中的完全不进插件）
 *   5. 交给 pipeline
 *   6. 写游标 + `lastSyncedAt`；任一步抛错则写 `lastError` 且**不动游标**
 */

export interface SyncAccountResult {
  accountId: string
  /** 是否只是记了游标（首次同步） */
  firstSync: boolean
  /** 拉到的原始邮件数 */
  fetched: number
  /** 被排除邮箱挡掉的封数 */
  blocked: number
  /** 解析失败被跳过的封数 */
  failed: number
  /** 服务端给的警告（如 UIDVALIDITY 变化） */
  warning?: string
}

/**
 * 同步一个账号。
 *
 * ⚠ **失败时不动游标**，这是整个增量同步的正确性基石：游标只在「这一批确实处理完」
 *   之后才推进，所以任何中途失败都只是「下次重拉同一段」，不会丢邮件。
 *   代价是可能重复处理 —— 而重复写同一封邮件只是覆盖同一个账本键，无害。
 */
export async function syncAccount(
  account: MailAccount,
  pipeline: MailPipeline,
  options: { hooks?: MailConnectionHooks, retention?: MailRetention } = {},
): Promise<SyncAccountResult> {
  return syncWithProvider(account, createMailProvider(account.provider), pipeline, options)
}

/**
 * 同步的核心循环，**provider 由调用方给**。
 *
 * 拆出这一层纯粹是为了可测：`syncAccount` 会经注册表按 id 造 provider，而单测里
 * 要的是一个假 provider（返回固定邮件、可以模拟 UIDVALIDITY 变化 / 抛错）。
 * 于是「首次只记游标」「失败不推进游标」这些**正确性契约**能在毫秒级被断言，
 * 而不需要真邮箱、真网络。
 */
export async function syncWithProvider(
  account: MailAccount,
  provider: MailProvider,
  pipeline: MailPipeline,
  options: { hooks?: MailConnectionHooks, retention?: MailRetention } = {},
): Promise<SyncAccountResult> {
  let connection
  try {
    connection = await provider.connect(account, options.hooks)

    // ---- 1. 首次同步：只记游标 -------------------------------------------------
    if (!account.cursor) {
      const cursor = await connection.getInitialCursor()
      if (!cursor) {
        /*
         * provider 拿不到有效游标（IMAP 的 UIDNEXT 异常、Gmail 的 profile 失败）。
         * 这里**不写假游标**：写一个 `{ uid: 0 }` 会让下次把整箱历史当增量拉下来，
         * 那正是设计文档最明确要避免的行为（Q5：首次不拉历史）。
         */
        await markAccountError(account.id, '拿不到邮箱的同步游标；本次不拉取任何邮件，下次心跳会重试')
        return { accountId: account.id, firstSync: true, fetched: 0, blocked: 0, failed: 0 }
      }

      await markAccountSynced(account.id, cursor)
      return { accountId: account.id, firstSync: true, fetched: 0, blocked: 0, failed: 0 }
    }

    // ---- 2. 增量拉取 -----------------------------------------------------------
    const result = await connection.fetchSince(account.cursor)

    const stats = await processRawMails(result.mails, account, pipeline, options.retention)

    // ---- 3. 推进游标 -----------------------------------------------------------
    await markAccountSynced(account.id, result.nextCursor)

    // UIDVALIDITY 变化之类的警告：不进「失败」统计（同步本身成功了），
    // 但要留下痕迹让 UI 能提示用户
    if (result.warning) {
      console.warn(`[mail-peon] ${account.label}：${result.warning}`)
      await markAccountError(account.id, result.warning)
    }

    return {
      accountId: account.id,
      firstSync: false,
      fetched: result.mails.length,
      blocked: stats.blocked,
      failed: stats.failed,
      warning: result.warning,
    }
  }
  finally {
    // 连接必须关掉：MV3 的 SW 随时可能被回收，留着连接只会在下次冷启动时
    // 拿到一个已经死掉的 socket（IMAP 会表现为「登录成功但命令全超时」）
    await connection?.logout().catch(() => {})
  }
}

interface ProcessStats {
  blocked: number
  failed: number
}

/**
 * 逐封处理：解析 → 排除邮箱过滤 → pipeline。
 *
 * ⚠ 解析失败只跳过**这一封**（设计文档 § 10 的错误分类表）：一封畸形邮件
 *   （非标准 MIME、被截断）不该让整轮同步失败 —— 那会让后面所有正常邮件都收不到。
 */
async function processRawMails(
  raws: RawMail[],
  account: MailAccount,
  pipeline: MailPipeline,
  retention?: MailRetention,
): Promise<ProcessStats> {
  const stats: ProcessStats = { blocked: 0, failed: 0 }
  if (!raws.length)
    return stats

  /*
   * 排除邮箱在**解析之后、pipeline 之前**判定（设计文档 features/06 § 4）：
   * 要拿到 `from` 才知道该不该屏蔽，而拿到 from 就必须先解析。
   * 顺序反过来的话，屏蔽只能按服务器给的元数据猜 —— Gmail 的 history 响应
   * 根本不带发件人。
   */
  const app = await pipeline.readSettingsForFilter()

  for (const raw of raws) {
    let mail: Mail
    try {
      const parsed = await parseRawMail(raw.source)
      mail = toMail(parsed, account, { messageId: raw.messageId })
    }
    catch (error) {
      stats.failed++
      console.warn(`[mail-peon] 解析邮件失败（已跳过）：${describe(error)}`)
      continue
    }

    // 排除邮箱 / 屏蔽列表：只对完整模式生效（极简模式没有这个概念）
    if (!app.minimalMode && app.blockedEnabled && isBlocked(mail, account.blockedList)) {
      stats.blocked++
      continue
    }

    try {
      const outcome = await pipeline.process(mail, account, retention)
      if (outcome === 'skipped')
        stats.blocked++
    }
    catch (error) {
      /*
       * pipeline 内部已经做过降级（AI 失败也会落一条带 `degraded` 的记录），
       * 能抛到这里说明连入库都失败了。记下来但继续处理其余的 ——
       * 游标会照常推进，所以这一封不会被重试，这是有意的：
       * 反复重试一封写不进去的邮件只会卡住整个账号的同步。
       */
      stats.failed++
      console.warn(`[mail-peon] 处理邮件失败（已跳过）：${describe(error)}`)
    }
  }

  return stats
}

/**
 * 同步所有启用的账号。
 *
 * 逐个串行、且**一个账号失败不影响其他账号**：多账号时最糟的体验是
 * 「Gmail 的 token 过期了，结果公司邮箱也一起收不到信」。
 */
export async function syncAllAccounts(
  accounts: MailAccount[],
  pipeline: MailPipeline,
  options: { hooksFor?: (account: MailAccount) => MailConnectionHooks | undefined } = {},
): Promise<SyncAccountResult[]> {
  const results: SyncAccountResult[] = []

  for (const account of accounts) {
    if (!account.enabled)
      continue
    try {
      results.push(await syncAccount(account, pipeline, { hooks: options.hooksFor?.(account) }))
    }
    catch (error) {
      const message = describe(error)
      await markAccountError(account.id, message).catch(() => {})
      results.push({ accountId: account.id, firstSync: false, fetched: 0, blocked: 0, failed: 0, warning: message })
    }
  }

  return results
}

/**
 * 一次性重建账号的游标（Options 的「重置同步位置」用）。
 *
 * 语义：连一次、记下当前游标、**不拉历史**。用户换过邮箱服务器、
 * 或想把「从现在开始」当作新起点时用得上。
 */
export async function resetAccountCursor(account: MailAccount, hooks?: MailConnectionHooks): Promise<SyncCursor> {
  const provider = createMailProvider(account.provider)
  const connection = await provider.connect(account, hooks)
  try {
    const cursor = await connection.getInitialCursor()
    await upsertAccount({ ...account, cursor, lastError: undefined })
    return cursor
  }
  finally {
    await connection.logout().catch(() => {})
  }
}

/** 测试连接（Options 的「测试连接」按钮） */
export async function testAccountConnection(account: MailAccount, hooks?: MailConnectionHooks) {
  const provider = createMailProvider(account.provider)
  return provider.testConnection(account, hooks)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
