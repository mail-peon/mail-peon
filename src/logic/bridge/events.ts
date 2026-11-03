import type { SyncDonePayload } from '~/logic/types'
import { onMessage } from 'webext-bridge/popup'
import { settingsAi, settingsApp } from './settings'
// ---------------------------------------------------------------------------
// 邮件列表
// ---------------------------------------------------------------------------

/**
 * 已注册的 `mail:updated` 监听器。
 *
 * ⚠ 必须去重：`webext-bridge` 的 `onMessage` 是**累加**注册的，而每个用到
 *   `useMails()` 的组件都会尝试注册一次。不去重的话，Popup 里切换一次 tab
 *   （组件重新挂载）就多一个监听器 —— 每个新邮件广播都会触发 N 次全量重载，
 *   而 N 会随用户点击次数增长。症状是「用久了弹窗越来越卡」。
 *
 * 用一个 Set 而不是布尔量：将来可能有多个界面同时监听（Popup + Sidepanel），
 * 每个都需要刷新自己的列表。
 */
export const mailUpdateListeners = new Set<() => void>()

/**
 * 「账号 / 规则 / 设置被改动了」的订阅者。
 *
 * ⚠ 这一套是**必需的**，不是优化。原因是一个很容易踩的 UI 生命周期事实：
 *
 *   Options 的页面用 `v-show` 切换（见 `Options.vue`），所以 `GeneralPage`
 *   在**打开设置页的那一刻就挂载了**，并在 `onMounted` 里读了一次账号 ——
 *   而那时用户还没添加任何账号。之后他切到「账号」页新建，再切回「通用」，
 *   `GeneralPage` **不会重新挂载**，于是它一直显示「账号 · 0 个」，
 *   「立即同步增量」也跟着用不上（它依赖那份账号列表做前置检查）。
 *
 *   真机症状：账号页明明有账号、测试连接也通过，通用页却坚持说「没有启用的账号」。
 *
 * 修法是让写操作**广播**出来，由订阅者重载 —— 而不是在每个组件里 `watch`
 * 一个共享状态（那要求所有页面共用同一份响应式数据，跨 `v-show` 的组件做不到）。
 */
export const dataChangeListeners = new Set<() => void>()

export const syncDoneListeners = new Set<(result: SyncDonePayload) => void>()

/**
 * 「用户点了某条 toast，希望定位到这封邮件」的订阅者。
 *
 * ⚠ 这条通道**曾经只有发送端**：内容脚本在 toast 被点击时
 *   `sendToBackground('mail:focus', …)`（见 `contentScripts/toast.ts`），
 *   注释和 `shim.d.ts` 都写着「让已经打开的 Popup 滚过去」——
 *   但 `installBridgeListener()` 里没有注册它，**全项目没有一个接收端**。
 *   于是点 toast 就是单纯地让它消失，那半句承诺从来没兑现过。
 */
export const mailFocusListeners = new Set<(mailId: string) => void>()

let bridgeListenerInstalled = false

export function installBridgeListener(): void {
  if (bridgeListenerInstalled)
    return
  bridgeListenerInstalled = true
  onMessage('mail:updated', () => {
    for (const listener of mailUpdateListeners)
      listener()
  })
  onMessage('data:changed', () => {
    for (const listener of dataChangeListeners)
      listener()
  })
  /*
   * ⚠ 设置改动走**单独的通道**，而不是复用 `data:changed`：
   *
   *   - 设置是**共享响应式状态**（上面的 `settingsApp` / `settingsAi`），
   *     收到广播直接写进 ref 就够了，不需要订阅者各自去拉一次；
   *   - 而 `data:changed` 的订阅者做的是「重读账号 / 用量」这类**网络往返**，
   *     把设置变化也塞进去等于每次拨开关都多打几个 message。
   */
  onMessage('settings:changed', ({ data }) => {
    if (data?.app)
      settingsApp.value = data.app
    if (data?.ai)
      settingsAi.value = data.ai
  })
  onMessage('sync:done', ({ data }) => {
    for (const listener of syncDoneListeners)
      listener(data)
  })
  /*
   * 内容脚本点 toast → 定位那封邮件。
   *
   * ⚠ 这条**必须**在这里注册：`onMessage` 是累加注册的，漏了它发送端就白发。
   *   而且它和上面几条不同 —— 那几条是「数据变了，去重读」，这条是
   *   「请把某一封滚到眼前」，所以载荷里的 `mailId` 要原样传给订阅者。
   */
  onMessage('mail:focus', ({ data }) => {
    if (!data?.mailId)
      return
    for (const listener of mailFocusListeners)
      listener(data.mailId)
  })
}

/**
 * 订阅「数据被改动」。返回取消订阅函数（组件卸载时调用）。
 *
 * 用在需要跟着账号 / 规则 / 设置变化刷新的地方。
 */
export function onDataChanged(listener: () => void): () => void {
  installBridgeListener()
  dataChangeListeners.add(listener)
  return () => dataChangeListeners.delete(listener)
}

/**
 * 订阅「一轮同步结束」。
 *
 * ⚠ 同步**不是**通过 `send()` 的返回值告知结果的，而是走广播 ——
 *   原因见 `background/main.ts` 里 `accounts:sync-now` 的注释：
 *   MV3 的 worker 在没有事件 30 秒后被回收，而挂着一条未完成的 `sendMessage`
 *   不算事件，所以「等同步跑完再返回」在同步较慢时必然失败。
 *
 * 返回取消订阅函数。
 */
export function onSyncDone(
  listener: (result: SyncDonePayload) => void,
): () => void {
  installBridgeListener()
  syncDoneListeners.add(listener)
  return () => syncDoneListeners.delete(listener)
}

/**
 * 订阅「把某封邮件滚到眼前」（内容脚本的 toast 被点击时发出）。
 *
 * ⚠ 与其它订阅不同，它的载荷是**一次性的意图**而不是状态：
 *   收到就执行一次滚动 / 高亮，不需要（也不该）缓存下来等下次挂载。
 *   所以没有「挂载时补一次」这回事 —— 弹窗没开着的时候点击 toast，
 *   那条消息本来就没人收（用户点扩展图标打开时自然会看到列表）。
 *
 * 返回取消订阅函数。
 */
export function onMailFocus(listener: (mailId: string) => void): () => void {
  installBridgeListener()
  mailFocusListeners.add(listener)
  return () => mailFocusListeners.delete(listener)
}
