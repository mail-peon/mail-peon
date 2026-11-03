import { refreshBadge } from '~/logic/notification/badge'
import { ensureStoreReady } from '~/logic/store/ready'
import { ensureAlarm, purgeExpiredCodes, SYNC_ALARM } from './runtime/maintenance'
import { syncAfterCurrent } from './runtime/sync'
import { restartWatchChannels } from './runtime/watch'

export function registerBackgroundLifecycle() {
// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarm()
    void restartWatchChannels()
    void (async () => {
      await ensureStoreReady()
      // 装完先把 badge 画对：用户看到「0」比看到空白更安心（空白像是坏了）
      await refreshBadge()
    })()
  })

  /**
   * 浏览器启动。
   *
   * ⚠ 这里**必须**重建 watch 连接：浏览器关掉时所有 WebSocket 都断了，
   *   而 `onStartup` 是这个时机唯一可靠的信号。
   *
   *   （注意它**不覆盖**「SW 被回收后重启」——那种情况下 `onStartup` 不会触发，
   *   所以才要在模块顶层也调一次。两个入口都不能省。）
   */
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm()
    void restartWatchChannels()
  })

  if (browser.alarms?.onAlarm) {
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === SYNC_ALARM) {
        /*
         * ⚠ 这里的任何异常都必须吞掉：`onAlarm` 的监听器抛错会让 Chrome 把这个
         *   监听器标成不可靠（历史上表现为「alarm 还在响，但 handler 不再被调用」）。
         *
         * ⚠ 走 `syncAfterCurrent()` 而不是 `syncOnce()`：这一跳的语义是「必须真的
         *   问一次邮箱」，所以它在途时排到那一轮之后（不会和在途那轮抢同一批邮件）。
         */
        void syncAfterCurrent().catch(error => console.warn('[mail-peon] 定时抓取异常', error))

        /*
         * 顺带跑一次失效验证码清理。
         *
         * ⚠ 挂在这里而不是自建一个 `setTimeout`：MV3 的 Service Worker 空闲约 30 秒
         *   就被回收，`setTimeout` **不会**在回收后触发 —— 用它做「失效后 30 秒删除」
         *   在真机上基本永远不执行，而代码看起来完全正确。
         *
         *   代价是精度：`chrome.alarms` 的最小间隔是 1 分钟，所以实际延迟落在
         *   「失效 + 30 秒 ~ 失效 + 90 秒」。对本功能完全可以接受 ——
         *   验证码已经失效了，早删晚删几十秒不影响用户。
         */
        void purgeExpiredCodes()
      }
    })
  }
}
