import type { ToastPayload } from '~/logic/notification/types'
import { sendMessage } from 'webext-bridge/content-script'
import { TOAST_CSS } from './toast.css'

/**
 * `webext-bridge` 的 `Destination` 类型把 `context: 'background'` 也要求带 `tabId`
 * （它的 `Endpoint` 联合类型写得比实际用法严）。这里用一个集中转换，
 * 而不是在每个调用点写三遍 `as never`。
 */
function sendToBackground(channel: string, payload: unknown): Promise<unknown> {
  const destination = { context: 'background' } as unknown as Parameters<typeof sendMessage>[2]
  return sendMessage(channel as never, payload as never, destination) as Promise<unknown>
}

/**
 * 页面顶部 toast（`ai-docs/design/page-toast.md`）。
 *
 * **替代 `chrome.notifications`**：所有「我刚做了一件事」的反馈都在网页内完成，
 * 不在 OS 层打扰用户。验证码自动复制是它最主要的场景 —— 用户输验证码时正在看
 * 某个页面的输入框，toast 弹在他眼前，而不是在系统通知中心里躺着。
 *
 * 四个实现要点（都能在真机上表现成「toast 没出现」或「toast 把页面搞坏了」）：
 *
 * 1. **closed shadow DOM**：页面 JS 读不到我们的 DOM，页面 CSS 也污染不到我们
 *    （`design/page-toast.md` G6）。`mode: 'open'` 的话，页面脚本可以遍历到
 *    并改我们的样式 —— 而「toast 在某个网站上长得不一样」是最难查的一类反馈。
 * 2. **`all: initial` 重置 host**：页面可能给 `div` 设了 `font-size: 62.5%`、
 *    `line-height`、`direction: rtl` 之类，不重置的话 toast 的排版会随页面变。
 * 3. **`pointer-events` 分级**：host 与 stack 都不接收事件（否则会在页面顶部
 *    挡出一条看不见的 32px 高的死区，用户点不到那一条上的任何东西），
 *    只有 toast 自身打开。
 * 4. **容器懒创建**：空闲时不往每个页面塞 DOM。只有真的收到 toast 才挂载 ——
 *    内容脚本被注入到**所有**页面（manifest 的 `<all_urls>`），
 *    每个页面都多一个 fixed 定位的 div 是没必要的开销。
 */

/** 验证码类 toast 的存活时间（`page-toast.md § 5`：让用户来得及读） */
const AUTO_DISMISS_MS = 5000

/** 最多同时显示几条；超出时最老的立刻消失（`page-toast.md § 3.1`） */
const MAX_TOASTS = 3

interface ToastEntry {
  el: HTMLElement
  timer: ReturnType<typeof setTimeout> | null
  dismiss: () => void
}

const entries = new Map<string, ToastEntry>()
let host: HTMLElement | null = null
let stack: HTMLElement | null = null

/**
 * 取（必要时创建）toast 容器。
 *
 * 返回 `null` 表示当前页面根本不能挂 DOM（XML / 图片文档、`documentElement` 缺失），
 * 调用方应当静默跳过 —— 往一个 XML 文档里 append 一个 `div` 在某些浏览器上会抛错。
 */
function ensureContainer(): HTMLElement | null {
  if (stack && host?.isConnected)
    return stack

  if (!document.documentElement || !document.body)
    return null

  host = document.createElement('div')
  host.id = 'mail-peon-toast-host'
  /*
   * `all: initial` 必须写在 style 属性里（而不是 shadow 内的 :host）：
   * 页面给的继承样式作用在 host 元素本身，shadow 内的规则来不及拦。
   */
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;'

  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = TOAST_CSS
  shadow.appendChild(style)

  stack = document.createElement('div')
  stack.className = 'stack'
  shadow.appendChild(stack)

  document.documentElement.appendChild(host)
  return stack
}

/**
 * 显示一条 toast。
 *
 * 同一封邮件重复到达（重发 / 重试 / 心跳重拉）时**不叠加**，而是把已有那条的状态
 * 更新掉（`page-toast.md § 8`：「已有 toast 时不再叠加；改 toast 文案」）。
 * 不做这件事的话，用户会看到同一封邮件的验证码连续弹三次。
 */
export function showToast(payload: ToastPayload): void {
  const container = ensureContainer()
  if (!container)
    return

  const existing = entries.get(payload.mailId)
  if (existing) {
    // 更新已有那条：内容与状态可能变了（比如用户点了「点击复制」之后按钮要消失）
    renderBody(existing.el, payload)
    restartTimer(existing.el, payload)
    return
  }

  const toast = document.createElement('div')
  toast.className = 'toast'
  renderBody(toast, payload)

  const dismiss = () => removeToast(payload.mailId)
  const entry: ToastEntry = { el: toast, timer: null, dismiss }
  entries.set(payload.mailId, entry)

  // 点击整条 → 打开 Popup 并定位这封邮件。
  // 用 `mail:focus` 广播而不是 `chrome.action.openPopup()`：后者只有 Chrome 有，
  // 而且会抢焦点；广播让已经打开的 Popup 滚过去，没打开时用户点 icon 时自然会看到。
  toast.addEventListener('click', () => {
    void sendToBackground('mail:focus', { mailId: payload.mailId }).catch(() => {})
    dismiss()
  })

  // hover / focus 暂停自动关闭（`page-toast.md § 4.4`）：
  // 用户已经在读了，这时候消失是最让人恼火的
  toast.addEventListener('mouseenter', () => pauseTimer(payload.mailId))
  toast.addEventListener('mouseleave', () => restartTimer(toast, payload))
  toast.addEventListener('focusin', () => pauseTimer(payload.mailId))
  toast.addEventListener('focusout', () => restartTimer(toast, payload))

  container.appendChild(toast)
  pruneOverflow()
  restartTimer(toast, payload)
}

/** 关掉某条 */
export function removeToast(mailId: string): void {
  const entry = entries.get(mailId)
  if (!entry)
    return
  if (entry.timer)
    clearTimeout(entry.timer)
  entries.delete(mailId)

  entry.el.classList.add('leaving')
  // 等出场动画跑完再摘：直接 remove 的话「滑上去淡出」根本看不到
  setTimeout(() => entry.el.remove(), 200)
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/**
 * 重建 toast 的内容。
 *
 * 自动复制成功（`design/page-toast.md § 3.3`）：
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ GitHub · noreply@github.com                  × │  ← 第一行：发件人 · 发件邮箱
 *   │ 验证码  123456                                 │  ← 第二行：验证码（主体，放大）
 *   │ √ 已复制                                       │  ← 第三行：一句安静的确认（灰色）
 *   └────────────────────────────────────────────────┘
 *
 * 自动复制失败时第三行换成失败说明 + 复制按钮（§ 3.4）：
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ GitHub · noreply@github.com                  × │
 *   │ 验证码  123456                                 │
 *   │ 自动复制失败  复制                             │
 *   └────────────────────────────────────────────────┘
 *
 * 五条刻意为之：
 *
 * 1. **第一行不带状态 emoji**（以前是 ✅ / ⚠ / ℹ）：状态已经由左侧 4px 色条
 *    表达了，同一件事说两遍只会把发件人那一行挤短。
 * 2. **第二行永远只有验证码**：状态词、按钮都放第三行 —— 挤在那一行会把主体
 *    （22px 的验证码）压小，而那是用户唯一要读的东西。
 * 3. **自动复制成功的确认是灰色的**（`√ 已复制`）：成功是默认预期，
 *    只需要一句安静的话，不需要绿色加粗去强调（对比手动复制那下，
 *    那是用户刚做的动作，才值得 `.copy-done` 的绿色）。
 * 4. **关闭按钮在第一行右端**：以前它被 append 在内容行之后，于是单独占了
 *    第三行、落在左下角，看起来像第二个操作按钮。
 * 5. **手动模式（没开自动复制）不写状态词**：那是用户自己的设置，
 *    不是这条 toast 要报告的事情 —— 只给复制按钮。
 *
 * 用 `replaceChildren` + `createElement` 而**不是** `innerHTML`：
 * 发件人名与主题来自邮件，是**不可信输入**。用 innerHTML 拼接它们就是一个
 * 自造的 XSS（`<img src=x onerror=…>` 出现在发件人名里是完全可行的）。
 */
function renderBody(toast: HTMLElement, payload: ToastPayload): void {
  toast.dataset.status = payload.status
  toast.replaceChildren()

  const accent = document.createElement('div')
  accent.className = 'accent'

  const body = document.createElement('div')
  body.className = 'body'

  const head = document.createElement('div')
  head.className = 'head'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = payload.from

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.title = '关闭'
  close.setAttribute('aria-label', '关闭')
  close.textContent = '×'
  close.addEventListener('click', (event) => {
    // 别让点击冒泡到整条 toast（那会打开 Popup）
    event.stopPropagation()
    removeToast(payload.mailId)
  })

  head.append(title, close)

  const content = document.createElement('div')
  content.className = 'content'

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = '验证码'

  const code = document.createElement('span')
  code.className = 'code'
  code.textContent = payload.code

  content.append(label, code)

  // 没开自动复制：不写状态词，复制按钮直接跟在验证码后面
  if (payload.status === 'manual')
    content.append(createCopyButton(toast, payload, null))

  body.append(head, content)

  if (payload.status === 'failed') {
    // 第三行：失败说明 + 复制按钮（`status` 交给它，复制成功后要把这行说明撤掉）
    const status = document.createElement('span')
    status.className = 'status'
    status.textContent = '自动复制失败'

    body.append(createFooterRow(status, createCopyButton(toast, payload, status)))
  }
  else if (payload.status === 'copied') {
    // 第三行：自动复制成功的一句安静确认（灰色、不加粗，见 `.copied-hint`）
    const hint = document.createElement('span')
    hint.className = 'copied-hint'
    hint.textContent = '√ 已复制'

    body.append(createFooterRow(hint))
  }

  toast.append(accent, body)
}

/**
 * 第三行（`.footer`）。
 *
 * 单独一行是为了让第二行永远只有「验证码 + 数字」这一件事 —— 状态词挤在那一行
 * 会把主体压小（用户报过）。两种内容共用它：失败说明 + 复制按钮、
 * 以及自动复制成功那句灰色确认。
 */
function createFooterRow(...children: HTMLElement[]): HTMLDivElement {
  const footer = document.createElement('div')
  footer.className = 'footer'
  footer.append(...children)
  return footer
}

/**
 * 「复制」文字按钮（`design/page-toast.md § 3.4`）。
 *
 * 与 Popup 列表项里那个同款做法：无边框、无底色，读起来是左边那句话的延续
 * （「验证码 123456 复制」），而不是一个需要去找的控件。
 *
 * `status` 只在失败态有：复制成功后要把「自动复制失败」那半句撤掉 ——
 * 留着就是「自动复制失败 √ 复制成功」这种自相矛盾的一行。
 */
function createCopyButton(
  toast: HTMLElement,
  payload: ToastPayload,
  status: HTMLElement | null,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'copy'
  button.type = 'button'
  button.textContent = '复制'
  button.addEventListener('click', (event) => {
    // 别让点击冒泡到整条 toast（那会打开 Popup）
    event.stopPropagation()
    void handleManualCopy(toast, payload, button, status)
  })
  return button
}

/**
 * 把复制按钮**换成**绿色的「√ 复制成功」。
 *
 * 与 Popup 的 `.copy-done` 同一套做法：那一刻它已经不是一个可点的控件了，
 * 所以是换成一个 `<span>`，而不是改按钮文案再禁用（后者还留着按钮的盒模型与
 * 焦点行为）。`.copy-done` 与 `.copy` 共用字号 / 行高，换的时候这一行不会跳。
 */
function markCopied(button: HTMLButtonElement): void {
  const done = document.createElement('span')
  done.className = 'copy-done'
  done.textContent = '√ 复制成功'
  button.replaceWith(done)
}

/**
 * toast 上的「复制」。
 *
 * 这是**第三级降级**：SW 与 content script 的自动复制都失败（或用户关掉了自动
 * 复制）之后，用户手动点一下。因为发生在页面 DOM 内、且是用户手势触发的，
 * `writeText` 在这里几乎必然成功。
 */
async function handleManualCopy(
  toast: HTMLElement,
  payload: ToastPayload,
  button: HTMLButtonElement,
  status: HTMLElement | null,
): Promise<void> {
  button.disabled = true
  let ok = false
  try {
    await navigator.clipboard.writeText(payload.code)
    ok = true
  }
  catch {
    ok = false
  }

  if (ok) {
    status?.remove()
    markCopied(button)
    /*
     * ⚠ 成功之后再给 5 秒：用户刚点了复制，这条提示不该在他读到
     *   「√ 复制成功」之前消失（原来的写法是重渲染，顺带重置了倒计时；
     *   现在就地换文案，得自己把倒计时拨回来）。
     */
    restartTimer(toast, payload)
  }
  else {
    if (status)
      status.textContent = '复制失败，请手动选中'
    button.disabled = false
  }

  // 无论成败都告诉 background：由它落库（content script 不该有 IDB 访问路径）
  try {
    await sendToBackground('mail:manual-copy-result', { mailId: payload.mailId, ok })
  }
  catch {
    // 报不回去也不影响用户已经复制成功这件事
  }
}

function restartTimer(toast: HTMLElement, payload: ToastPayload): void {
  const entry = entries.get(payload.mailId)
  if (!entry)
    return
  if (entry.timer)
    clearTimeout(entry.timer)
  entry.timer = setTimeout(removeToast, AUTO_DISMISS_MS, payload.mailId)
  void toast
}

function pauseTimer(mailId: string): void {
  const entry = entries.get(mailId)
  if (entry?.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

/** 超过上限时立刻挤掉最老的（`page-toast.md § 3.1`：超过 3 条最老的自动消失） */
function pruneOverflow(): void {
  while (entries.size > MAX_TOASTS) {
    const oldest = entries.keys().next().value
    if (oldest === undefined)
      return
    removeToast(oldest)
  }
}
