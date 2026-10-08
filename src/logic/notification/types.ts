/**
 * 通知接口：把「怎么弹 / 怎么复制」从业务逻辑里摘出去。
 *
 * `logic/` 这一层刻意**不 import 任何 `chrome.*` / `browser.*` API**，理由有三：
 *
 *  1. 单测跑在 jsdom 里，没有扩展 API；把副作用收在一个接口后面，
 *     「AI 失败要降级」「验证码要写 copyStatus」这些**真正值得测的判断**
 *     才能在几毫秒内跑完；
 *  2. 同一个 `pipeline` 要能在不同上下文里工作（SW / 将来的 offscreen document），
 *     而它们的通知能力不同（前者没有 DOM，后者没有 `action` API）；
 *  3. 设计文档要求「所有能关的行为都能关」——把「弹什么」的判定与「怎么弹」
 *     分开之后，关掉某个通知就是换一个 NoopNotifier，不用在业务逻辑里加 if。
 */

/** toast 的三种形态（`design/page-toast.md § 2`） */
export type ToastStatus = 'copied' | 'failed' | 'manual'

export interface CodeToastPayload {
  kind: 'code'
  mailId: string
  /** 发件人展示串（`Name <a@b.com>`） */
  from: string
  code: string
  status: ToastStatus
}

export type ToastPayload = CodeToastPayload

export interface Notifier {
  /**
   * 更新 icon badge。
   *
   * `count` 由 `badgeCount()` 算（排除广告 + 已验证码），传 -1 表示「重新算一遍」——
   * 让实现方决定要不要查库，而不是让业务层每封邮件都重算一次全表。
   */
  updateBadge: (count?: number) => Promise<void>
  /** 在当前激活页面顶部弹 toast；没有可用页面时静默跳过 */
  showToast: (payload: ToastPayload) => Promise<void>
  /**
   * 复制到剪贴板。
   *
   * ⚠ 返回 `false` 是**正常路径**而不是异常（`features/05-verification-code.md § 7`）：
   *   MV3 的 SW 里 `navigator.clipboard.writeText` 经常因为没有 focus 而失败，
   *   此时实现方应当**先试 SW、再经 content script 重试**，两次都失败才回 false。
   *   业务层拿到 false 就把 `copyStatus` 写成 `'failed'`，toast 显示「点击复制」——
   *   用户在 toast 上点一下就能成（那是在页面 DOM 内执行的，几乎必然成功）。
   */
  copyToClipboard: (code: string) => Promise<boolean>
  /** 通知 UI「某封邮件已更新」，让打开的 Popup / Sidepanel 刷新 */
  notifyMailUpdated: (mailId: string) => void
}

/**
 * 什么都不做的实现。
 *
 * 用在两个地方：单测（断言业务逻辑而不关心通知），以及「所有通知开关都关掉」的
 * 用户配置。有一个现成的空实现，比在每个调用点写 `if (notify) …` 干净得多 ——
 * 后者会随着开关变多而指数级长草。
 */
export const noopNotifier: Notifier = {
  async updateBadge() {},
  async showToast() {},
  async copyToClipboard() {
    return false
  },
  notifyMailUpdated() {},
}
