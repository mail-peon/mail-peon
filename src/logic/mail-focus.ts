import { nextTick, onUnmounted, ref } from 'vue'
import { onMailFocus } from '~/logic/bridge'

/**
 * 「把某封邮件滚到眼前」——内容脚本的 toast 被点击时触发。
 *
 * ## 它补的是一个只做了一半的功能
 *
 * `contentScripts/toast.ts` 一直在点击整条 toast 时
 * `sendToBackground('mail:focus', { mailId })`，注释和 `shim.d.ts` 都写着
 * 「让已经打开的 Popup 滚过去」—— 但**接收端从来没写过**：
 * `bridge.ts` 的 `installBridgeListener()` 没有注册这条通道，
 * 全项目没有一个 `onMessage('mail:focus')`。
 *
 * 于是那个行为一直是「toast 消失，然后什么也没发生」。
 *
 * ## 为什么高亮而不是只是滚动
 *
 * 列表可能有几十条，`scrollIntoView` 之后目标只是「出现在视口里」——
 * 用户刚从网页上的 toast 切过来，视线还在找。给一层短暂的描边，
 * 「就是这条」这件事才不需要再扫一遍。
 *
 * @param highlightMs 高亮持续多久（默认 2.4 秒：够看清，又不至于留在那儿碍事）
 */
export function useMailFocus(highlightMs = 2400) {
  /** 当前被高亮的那封；`null` = 没有 */
  const focusedId = ref<string | null>(null)
  let timer: number | undefined

  function focusMail(mailId: string) {
    focusedId.value = mailId

    /*
     * 等一帧再滚：这封邮件可能刚刚才由 `mail:updated` 带进列表，
     * 此刻 DOM 里还没有它 —— 立刻查会查不到，然后就再也不滚了。
     */
    void nextTick(() => {
      /*
       * ⚠ 用「遍历所有 `[data-mail-id]` 比 id」而不是 `querySelector('[data-mail-id="…"]')`：
       *   `mailId` 进 CSS 选择器要转义，而 `CSS.escape` 在 jsdom 里不一定有。
       *   列表最多几百条，遍历的开销可以忽略。
       */
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-mail-id]'))
        .find(node => node.dataset.mailId === mailId)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })

    // 重新点另一条时把上一条的高亮收掉，避免同时亮着两条
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      focusedId.value = null
    }, highlightMs)
  }

  const stop = onMailFocus(focusMail)

  onUnmounted(() => {
    stop()
    window.clearTimeout(timer)
  })

  return { focusedId, focusMail }
}
