import type { Notifier, ToastPayload } from '~/logic/notification/types'
import { broadcastToExtension, deliverToast } from '~/logic/messaging'
import { computeBadgeCount, refreshBadge } from '~/logic/notification/badge'
import { copyViaContentScript } from './clipboard'

/**
 * 生产环境的 `Notifier` 实现 —— **唯一碰扩展 API 的地方**。
 *
 * `logic/` 那一层只知道 `Notifier` 接口（见 `logic/notification/types.ts` 的说明），
 * 所以「怎么弹 toast」「怎么复制」的实现全部收在这个文件里。换实现（比如将来用
 * offscreen document 做复制）不需要动任何业务逻辑。
 */

export function createBrowserNotifier(): Notifier {
  return {
    async updateBadge(count) {
      // count 不传时让 badge 模块自己读库重算 —— 业务层刚算过时可以直接给值，
      // 省一次全表遍历
      await refreshBadge(count ?? (await computeBadgeCount()))
    },

    async showToast(payload: ToastPayload) {
      // 没有激活 tab（所有窗口最小化 / 当前页是 chrome://）时不弹也不报错：
      // 设计文档 `page-toast.md § 8` 明确要求「只更新 badge」。
      await deliverToast(payload)
    },

    async copyToClipboard(code: string) {
      /*
       * 三级降级（`features/05-verification-code.md § 3`）：
       *
       *   1. SW 里直接 `navigator.clipboard.writeText`。Chrome 的 MV3 SW 在
       *      「存在用户激活态窗口」时能写成功，多数情况下这一级就够了。
       *   2. 失败则交给当前页面的 content script 写 —— 页面本来就是 focused 的，
       *      这一级几乎必然成功。
       *   3. 两级都失败则返回 false，业务层把 `copyStatus` 记成 `'failed'`，
       *      toast 显示「点击复制」按钮（那是在页面 DOM 内执行的，最稳）。
       *
       * ⚠ 第 1 级失败是**常态**而不是异常：SW 没有 focus 概念，`writeText` 经常抛
       *   `NotAllowedError`。所以这里刻意 try/catch 之后继续降级，
       *   而不是把异常抛给业务层。
       */
      try {
        await navigator.clipboard.writeText(code)
        return true
      }
      catch {
        // 落到第二级
      }

      return copyViaContentScript(code)
    },

    notifyMailUpdated(mailId: string) {
      // 广播而不是只发给 popup：Sidepanel 与 Options 都可能开着
      broadcastToExtension('mail:updated', { mailId })
    },
  }
}
