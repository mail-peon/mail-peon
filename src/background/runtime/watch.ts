import type { MailAccount } from '~/logic/types'
import { buildWatchRequest, openWatchChannel } from '~/adapters/mail/transport/watch'
import { listEnabledAccounts, markAccountError } from '~/logic/store/accounts'
import { ensureStoreReady } from '~/logic/store/ready'
import { syncOnce } from './sync'

// ---------------------------------------------------------------------------
// 常驻监听：中继替我们挂 IMAP IDLE，有新邮件就推过来
// ---------------------------------------------------------------------------

/** 每个账号一条 watch 连接的停止函数 */
const watchStops = new Map<string, () => void>()

/**
 * 上一次 watch 报给我们的 `EXISTS`（邮箱总封数）。
 *
 * ⚠ 这是**补漏的关键**：watch 重连时中继会重新 `SELECT`，把当时的 `EXISTS` 当新基线，
 *   于是「插件睡着期间到达的邮件」不会被当作新邮件推送。这里拿上一次的值做比较：
 *   新基线更大 ⇒ 沉睡期间确实有邮件到达 ⇒ 补一轮同步。
 *
 *   没有它时，真机表现就是：中继日志里 `exists` 从 36117 涨到 36119，
 *   但插件一条推送都没收到 —— 下次手动点「立即同步」才看到。
 */
const watchExists = new Map<string, number>()

/**
 * 重建中的标记 —— 防止并发重建把连接搞成重复。
 *
 * ⚠ 这个守卫是必需的，不是保险：`restartWatchChannels()` 是 `async` 的，而它会被
 *   四个入口调用（模块加载 / `onInstalled` / `onStartup` / 账号变更）。
 *   这些调用**会重叠**（浏览器启动时 `onStartup` 与模块加载几乎同时），
 *   于是「先清空再重建」的两份执行交错：A 清空 → B 清空 → A 建 → B 建，
 *   结果是**每个账号两条 watch 连接**。
 *
 *   症状很有迷惑性：中继日志里 `开始常驻监听` 出现多次，而同一次新邮件被推送
 *   多遍（真机上看到过三条一模一样的 `新邮件：35505 → 35507`），
 *   于是同一轮同步被触发多次 —— 既浪费邮箱连接名额，也会触发限流。
 */
let watchRestartInFlight: Promise<void> | null = null

/**
 * 重新建立所有账号的 watch 连接。
 *
 * ⚠ 必须在四个时机都调用：
 *   1. **模块加载**（SW 冷启动）—— SW 被回收重启后 `onStartup` 不会再触发，
 *      只挂事件的话用户下午就收不到推送了；
 *   2. `onInstalled` / `onStartup`；
 *   3. 账号列表变化之后（`accounts:upsert` / `accounts:delete`）。
 *
 * 每次调用都**先全部停掉再重建**：增量更新需要判断「哪个账号的哪些字段变了」，
 * 而漏判的后果是「改了密码但推送还在用旧的」—— 那种 bug 表现为
 * 「同步能拉到邮件，但推送一直不响」，极难联想。全量重建的代价只是几条
 * WebSocket 握手，几毫秒的事。
 *
 * ⚠ 并发调用会被**合并**（见 `watchRestartInFlight`）。不合并就会产生重复连接。
 */
export async function restartWatchChannels(): Promise<void> {
  if (watchRestartInFlight)
    return watchRestartInFlight

  watchRestartInFlight = rebuildWatchChannels().finally(() => {
    watchRestartInFlight = null
  })
  return watchRestartInFlight
}

async function rebuildWatchChannels(): Promise<void> {
  for (const stop of watchStops.values()) {
    try {
      stop()
    }
    catch {}
  }
  watchStops.clear()
  watchExists.clear()

  let accounts: MailAccount[]
  try {
    await ensureStoreReady()
    accounts = await listEnabledAccounts()
  }
  catch (error) {
    console.warn('[mail-peon] 读取账号失败，暂不建立监听', error)
    return
  }

  for (const account of accounts) {
    // Gmail 走 REST + OAuth，没有 IMAP 连接可挂
    if (account.provider !== 'imap')
      continue

    const request = buildWatchRequest(account)
    if (!request) {
      // 配置不全（缺中继地址 / 密码）—— 静默跳过。
      // UI 在「测试连接」时会明确报错，这里不需要再刷一遍日志
      continue
    }

    const relayUrl = String(account.config.relayUrl).trim()
    watchStops.set(account.id, openWatchChannel(relayUrl, request, (event) => {
      if (event.type === 'mail') {
        /*
         * ⚠ 这一行让「主动推送到底有没有生效」变成**可观测**的。
         *
         *   没有它时，「中继推了但插件没反应」与「中继根本没推」在插件侧
         *   完全无法区分 —— 而这两种情况的排查方向完全相反
         *   （一个查 watch 连接，一个查同步链路）。
         */
        console.warn(`[mail-peon] 收到中继推送：${account.label} 有 ${event.exists} 封邮件 → 触发同步`)
        watchExists.set(account.id, event.exists)

        /*
         * ⚠ 推送里只有「有几封」，所以这里走的是**普通的一轮同步** ——
         *   它抓的是游标之后的所有邮件，不依赖推送里带的数字。
         *
         *   不用 `await`：watch 的回调要尽快返回，否则后续推送会排在它后面。
         *
         * ⚠ 走 `syncOnce()` 而不是直接跑：推送可能在**一轮同步跑到一半**时到达
         *   （真机上很常见），那时直接再跑一轮会和在途那轮读到同一个游标、
         *   把同一批邮件重复喂给 AI。在途时的诉求已经被那一轮的抓取范围覆盖，
         *   所以这里搭车复用即可 —— 详见 `syncFlight` 的说明。
         */
        void syncOnce().catch(error => console.warn('[mail-peon] 推送触发的同步失败', error))
        return
      }

      if (event.state === 'watching') {
        /*
         * 新 watch 连上来了：中继会重新 SELECT，并把当前 EXISTS 当基线。
         *
         * ⚠ 这一步是**补漏**，不是重复推送：watch 断开期间（SW 被回收、
         *   网络切换、中继重启）到达的邮件不会被 `mail` 事件推到我们这边，
         *   但重连后的 EXISTS 会比上次大。看到这个差值就补一轮同步。
         */
        const previous = watchExists.get(account.id)
        watchExists.set(account.id, event.exists)
        if (previous === undefined || event.exists > previous) {
          console.warn(
            `[mail-peon] 监听基线变化：${account.label} ${previous ?? '首次'} → ${event.exists}，补一轮同步`,
          )
          void syncOnce().catch(error => console.warn('[mail-peon] 监听补漏同步失败', error))
        }
        return
      }

      if (event.state === 'failed') {
        // 中继说重试无用（密码错 / 白名单拒绝）—— 记进账号状态，让 UI 能显示
        console.warn(`[mail-peon] 中继拒绝监听 ${account.label}：${event.error}`)
        watchExists.delete(account.id)
        void markAccountError(account.id, event.error)
        return
      }

      if (event.state === 'error') {
        // 中继说本轮失败但还在退避重试——可观测，不打断 sync 调度
        console.warn(`[mail-peon] 中继监听 ${account.label} 本轮出错：${event.error}`)
      }
    }))
  }

  /*
   * ⚠ 这里**不**打「已建立监听：<账号> → <中继地址>」，也不打重建完成的汇总。
   *
   *   重建在 SW 每次冷启动都会跑（`restartWatchChannels` 的四个时机），
   *   每次都是同样的几行「成功」播报，只能把失败那几行淹掉 ——
   *   而这一段的诊断价值全在失败路径上（读取账号失败 / 中继拒绝 / 本轮出错），
   *   连接是否真的活着则由「收到中继推送」那行证明。
   */
}
