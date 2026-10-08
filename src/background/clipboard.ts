import { sendMessage } from 'webext-bridge/background'
import { getActiveTabId } from '~/logic/messaging'

/**
 * 「把验证码写进剪贴板」的第二级降级：交给当前页面的 content script。
 *
 * 为什么需要它（`features/05-verification-code.md § 3`）：
 * `navigator.clipboard.writeText` 要求文档处于 focused 状态，而 **MV3 的 Service
 * Worker 没有文档** —— 所以 SW 里那一次调用经常直接抛 `NotAllowedError`。
 * content script 跑在真实页面里，页面就是用户正在看的那一个，几乎必然成功。
 *
 * ⚠ 注意这里**没有**用 `Notifier` 接口：它是 notifier 自己的实现细节，
 *   业务层不该知道「复制可能要走页面」这件事。
 */

/**
 * 等 content script 回话的上限。
 *
 * ⚠ 这个超时是**必需**的，不是保险 —— 没有它整个收信流程会被挂死。
 *
 *   真机故障：用户开着**设置页**（`chrome-extension://…/options.html`）时收到验证码邮件，
 *   而 content script **不会注入 `chrome-extension://` 页面**。
 *   于是 `getActiveTabId()` 拿到那个 tab，`sendMessage` 发过去**永远等不到响应**
 *   —— promise 既不 resolve 也不 reject。
 *
 *   而调用链是 `processMinimal` 里 `await copyToClipboard(code)` **紧跟着**
 *   `await upsertMail(...)` —— 复制挂住 ⇒ **邮件永远不入库**。
 *   症状：background 日志停在「提取到验证码」，既没有「已入库」也没有任何报错，
 *   界面上新邮件就是不出现。
 *
 *   剪贴板是「锦上添花」，绝不该阻塞入库。
 */
const CLIPBOARD_TIMEOUT_MS = 2000

export async function copyViaContentScript(code: string): Promise<boolean> {
  const tabId = await getActiveTabId()
  if (tabId === null)
    return false

  try {
    /*
     * 走 `mail:copy-code` 通道而不是在 notifier 里内联实现：
     * 这条通道也服务「toast 上的点击复制」，两处用同一个 handler
     * （见 `contentScripts/index.ts`），行为不会分叉。
     */
    const sent = sendMessage('mail:copy-code', { mailId: '', code }, { context: 'content-script', tabId })

    /*
     * ⚠ `setTimeout` 的第三个参数用来传值，而不是包一层箭头函数 ——
     *   lint 的 `e18e/prefer-timer-args` 要求这样（省一次闭包分配）。
     */
    const timeout = new Promise<null>((resolve) => {
      setTimeout(resolve, CLIPBOARD_TIMEOUT_MS, null)
    })

    const result = await Promise.race([sent, timeout])

    return result?.ok === true
  }
  catch {
    // 没有内容脚本（chrome:// 等）或页面正在卸载 —— 都不是错误，落到第三级
    return false
  }
}
