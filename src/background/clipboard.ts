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
    const result = await sendMessage('mail:copy-code', { mailId: '', code }, { context: 'content-script', tabId })
    return result?.ok === true
  }
  catch {
    // 没有内容脚本（chrome:// 等）或页面正在卸载 —— 都不是错误，落到第三级
    return false
  }
}
