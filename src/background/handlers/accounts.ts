import type { SyncDonePayload } from '~/logic/types'
import { onMessage } from 'webext-bridge/background'
import { resetAccountCursor, testAccountConnection } from '~/adapters/mail/mailbox'
import { broadcastToExtension } from '~/logic/messaging'
import { refreshBadge } from '~/logic/notification/badge'
import { deleteAccount, listAccounts, markAccountError, upsertAccount } from '~/logic/store/accounts'
import { clearMailsByAccount } from '~/logic/store/mails'
import { ensureStoreReady } from '~/logic/store/ready'
import { fireAndForget } from '../deferred-task'
import { authorizeGmail } from '../gmail-oauth'
import { hooksFor } from '../runtime/pipeline'
import { syncOnce } from '../runtime/sync'
import { restartWatchChannels } from '../runtime/watch'

/**
 * 最近一轮同步的结果（UI 的**轮询兜底**）。
 *
 * ⚠ 为什么不能只靠 `sync:done` 广播：
 *
 *   广播的送达依赖 background 侧 `connMap` 里有没有那个端点，而它只在
 *   对方握手完成后才有条目。于是「页面在 background 重载之前就连上了」
 *   「同一 context 有多个连接」「端点名对不上」这三种情况都会让消息**静默消失** ——
 *   用户看到的是「一直转圈」，而且**没有任何错误**可查。真机上就这样卡过。
 *
 *   所以结果同时存一份在这里，UI 拿不到广播时可以**问**回来。
 *   这不会重新引入 MV3 的 30 秒问题：`accounts:sync-now` 已经立刻返回了，
 *   这个查询是同步**跑完之后**才发的短请求。
 */
let lastSync: SyncDonePayload | null = null

export function registerAccountHandlers() {
// ---------------------------------------------------------------------------
// 消息：账号
// ---------------------------------------------------------------------------

  onMessage('accounts:list', async () => {
    await ensureStoreReady()
    return { accounts: await listAccounts() }
  })

  onMessage('accounts:upsert', async ({ data }) => {
    await ensureStoreReady()
    await upsertAccount(data.account)
    /*
     * ⚠ **必须重建 watch**：账号可能是刚加的（此前没有连接），也可能是改了
     *   密码 / 中继地址（旧连接还在用旧配置）。
     *
     *   漏掉这一步的症状正是「手动同步能拉到、自动推送一直不响」——
     *   手动同步每次都从库里读新配置，而 watch 只在模块加载 / 浏览器启动时建立。
     */
    void restartWatchChannels()
    /*
     * ⚠ 广播出去，否则「通用」页会一直显示旧的账号数。
     *
     *   这一页用 `v-show` 常驻（见 `Options.vue`），它 `onMounted` 里读的那次账号
     *   是「用户还没添加账号」时读的；没有这条广播，用户去「账号」页新建一个再切回来，
     *   看到的还是「账号 · 0 个」—— 真机症状就是「账号页明明有账号，通用页说没有」。
     */
    broadcastToExtension('data:changed', { reason: 'accounts' })
    return { ok: true as const, id: data.account.id }
  })

  onMessage('accounts:delete', async ({ data }) => {
    await ensureStoreReady()
    /*
     * 先删邮件再删账号。反过来的话，中途失败会留下一批「孤儿邮件」——
     * 它们的 accountId 指向一个不存在的账号，UI 上既显示不出来也删不掉。
     */
    await clearMailsByAccount(data.id)
    await deleteAccount(data.id)
    // 停掉这个账号的 watch（重建会顺带清掉已删除账号的连接）
    void restartWatchChannels()
    await refreshBadge()
    broadcastToExtension('data:changed', { reason: 'accounts' })
    return { ok: true as const }
  })

  onMessage('accounts:test', async ({ data }) => {
    await ensureStoreReady()
    return testAccountConnection(data.account, hooksFor(data.account))
  })

  onMessage('accounts:reset-cursor', async ({ data }) => {
    await ensureStoreReady()
    const account = (await listAccounts()).find(item => item.id === data.id)
    if (!account)
      return { ok: false, error: '账号不存在' }

    try {
    // 语义：连一次、记下当前游标、**不拉历史**
      await resetAccountCursor(account, hooksFor(account))
      return { ok: true as const }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markAccountError(account.id, message)
      return { ok: false, error: message }
    }
  })

  /**
   * 手动触发一轮同步。
   *
   * ⚠ **立刻返回，不等待同步跑完**。这不是优化，是这个功能能不能用的前提：
   *
   *   MV3 的 Service Worker 在**没有事件** 30 秒后被回收，而一条**正在进行中**的
   *   `sendMessage` **不算事件**。所以「点同步 → 等它跑完 → 返回结果」这种写法在
   *   同步超过 30 秒时必然失败 —— worker 被杀，promise 永远不 settle，
   *   UI 停在「同步中」不动（真机上就是这么发生的：用户邮箱 3 万多封，
   *   一轮同步跑了 32 秒）。
   *
   *   同步本身继续在后台跑（它自己会 `await` 网络与 IDB，这些都会让 worker 保活）。
   *
   * ⚠ 结果**同时**走两条路（见 `lastSync` 的说明）：
   *   1. 广播 `sync:done` —— 快，但不保证送到；
   *   2. 存进 `lastSync` 供 UI **轮询**取回 —— 兜底，保证「同步中」一定会结束。
   *
   * ⚠ 用 `syncOnce()`（搭车复用）而不是 `syncAfterCurrent()`（排到本轮之后）：
   *   后者会让这条 `sendMessage` 的 promise 挂上两整轮同步的时间，而那正是上面
   *   那个 MV3 故障的成因。点下去时若已有一轮在途，它抓的同样是「游标之后的所有
   *   邮件」，结果照样会写进 `lastSync`（`finishedAt` 一定晚于本次点击），
   *   UI 的轮询兜底能拿到 —— 见 `pages/GeneralPage.vue` 的 `startSyncWatchdog`。
   */
  onMessage('accounts:sync-now', async () => {
    await ensureStoreReady()
    return fireAndForget(async () => {
      try {
        const { value: results } = await syncOnce()
        lastSync = { ok: true, results, finishedAt: Date.now() }
        broadcastToExtension('data:changed', { reason: 'accounts' })
        broadcastToExtension('sync:done', { ok: true, results, finishedAt: lastSync.finishedAt })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[mail-peon] 手动同步失败', error)
        lastSync = { ok: false, results: [], error: message, finishedAt: Date.now() }
        // 失败也要通知 —— 否则 UI 会一直停在「同步中」（这正是修之前的行为）
        broadcastToExtension('sync:done', { ok: false, results: [], error: message, finishedAt: lastSync.finishedAt })
      }
    }, (error) => {
    // 同步到这里都不应该失败（try / catch 里走完了）；兜底把异常吃掉 + 记日志，
    // 不能再让 promise 走 unhandled rejection（MV3 worker 会被报错）。
      console.warn('[mail-peon] 手动同步未捕获异常', error)
    })
  })

  onMessage('accounts:sync-status', async () => {
    return lastSync
  })

  onMessage('accounts:gmail-authorize', async ({ data }) => {
    return authorizeGmail(data.clientId)
  })
}
