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

/**
 * 给一个 promise 套超时。
 *
 * ⚠ 超时后**不去取消**原来的操作（`writeText` 没法取消）：它可能稍后自己成功，
 *   那时剪贴板里会有内容 —— 但我们已经返回 `false`，界面会显示「点击复制」。
 *   这比「挂住整个收信流程」好得多：最坏情况是用户多点一次，而不是收不到邮件。
 *
 * @param promise 要限时的操作
 * @param ms 上限
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`剪贴板操作超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function createBrowserNotifier(): Notifier {
  return {
    async updateBadge(count) {
      // count 不传时让 badge 模块自己读库重算 —— 业务层刚算过时可以直接给值，
      // 省一次全表遍历
      await refreshBadge(count ?? (await computeBadgeCount()))
    },

    async showToast(payload: ToastPayload) {
      /*
       * 没有激活 tab（所有窗口最小化 / 当前页是 chrome://）时不弹也不报错：
       * 设计文档 `page-toast.md § 8` 明确要求「只更新 badge」。
       *
       * ⚠ 这里**必须吞掉异常**：`showToast` 是在 `pipeline.process()` 里被 await 的，
       *   而它的下一句就是 `notifyMailUpdated`。投 toast 失败（目标 tab 没有
       *   content script、页面正在导航、扩展页在前台…）**不该**让整封邮件的
       *   处理流程中断 —— 那属于「锦上添花」失败，邮件本身已经入库了。
       *
       *   这与剪贴板那次是同一类错误：辅助动作把主流程带崩。
       *   见 `logic/ai/pipeline.ts` 的 `copyWithTimeout`。
       */
      try {
        await deliverToast(payload)
      }
      catch (error) {
        console.warn('[mail-peon] 投递 toast 失败（不影响入库）', error)
      }
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
       *
       * ⚠⚠ **整个复制过程决不能阻塞入库。**
       *   调用链是 `processMinimal` 里 `await copyToClipboard(code)` **紧跟着**
       *   `await upsertMail(...)`。任何一级挂住 ⇒ 邮件永远不入库，而且
       *   **没有任何报错** —— 真机上就是这样丢过邮件（见 `clipboard.ts` 的说明）。
       *
       *   所以两级都套了超时，最坏情况总耗时被限制在 2.5 秒内，
       *   然后返回「复制失败」，让邮件照常入库、toast 上给「点击复制」按钮。
       */
      try {
        await withTimeout(navigator.clipboard.writeText(code), 500)
        return true
      }
      catch {
        // 落在第二级
      }

      return copyViaContentScript(code)
    },

    notifyMailUpdated(mailId: string) {
      // 广播而不是只发给 popup：Sidepanel 与 Options 都可能开着
      broadcastToExtension('mail:updated', { mailId })
    },
  }
}
