import type { Ref } from 'vue'
import type { Mail } from '~/logic/types'
import { onMounted, onUnmounted, ref } from 'vue'
import { useCopyFeedback } from '~/logic/copy-feedback'
import { installBridgeListener, mailUpdateListeners } from './events'
import { send } from './transport'

export function useMails(limit = 200) {
  const mails = ref<Mail[]>([]) as Ref<Mail[]>
  const loading = ref(true)

  /**
   * 上一次 `reload()` 是不是**失败**了（没拿到列表）。
   *
   * ⚠ 与 `useSettings` 的 `loadFailed` 同一个理由：`send` 失败时不抛错，
   *   只返回兜底值（这里是 `{ mails: [] }`），于是「加载失败」和「一封邮件都没有」
   *   在 `mails.value.length === 0` 上完全一样。
   *
   *   后果不是「少了个提示」那么轻：Popup 会一本正经地告诉用户
   *   「还没有收到邮件」—— 而他可能刚收到一封验证码。**界面在陈述一个假事实。**
   */
  const loadFailed = ref(false)

  async function reload() {
    /*
     * ⚠ 计时「UI 侧看到的往返耗时」，而不是只看 background 内部耗时。
     *
     *   两者的差值是**消息通道**的开销 —— 真机上那个「十几秒才显示」如果出在这里，
     *   background 的日志会显示它很快就返回了，而 UI 直到很久之后才拿到。
     *   只有两侧都计时才能分清是「库慢」还是「消息慢」。
     */
    const started = Date.now()
    const result = await send<{ mails: Mail[] } | null>('mail:list', { limit }, null)
    const elapsed = Date.now() - started

    /*
     * ⚠ 兜底值用 `null` 而不是 `{ mails: [] }`：`send` 把 `null` 原样透传（它只对
     *   `undefined` 兜底），于是「失败」有了一个**和空列表分得开**的表示。
     *   失败时**不动** `mails` —— 上一次拿到的数据比一个假的空列表有用得多。
     */
    if (result) {
      mails.value = result.mails
      loadFailed.value = false
    }
    else {
      loadFailed.value = true
    }
    loading.value = false

    if (elapsed > 300)
      console.warn(`[mail-peon] mail:list 往返慢：${mails.value.length} 条用了 ${elapsed}ms`)
  }

  /**
   * 「刚刚复制成功」的瞬时反馈（**纯前端，不落库**）。
   *
   * 实现与踩过的坑都在 `logic/copy-feedback.ts` 里；这里只是接上它。
   * 单独一个模块是为了能**直接用假定时器测**「几秒后复原」那个行为 ——
   * 它埋在 `useMails`（要连 store 与消息通道）里的话根本测不动，
   * 而真机上坏掉的恰恰就是它。
   */
  const { justCopied, markCopied: markJustCopied } = useCopyFeedback()

  /**
   * 复制验证码。
   *
   * ## ⚠ 为什么在**这里**写剪贴板，而不是让 background 代劳
   *
   * `navigator.clipboard.writeText` 要求调用它的**文档处于 focused 状态**。
   *
   *   - background（MV3 Service Worker）**没有文档** —— 它那次调用经常直接抛
   *     `NotAllowedError`，所以才有了「降级给 content script」那一套；
   *   - 而 **Popup / Sidepanel 自己就是 focused 文档** —— 由用户点一下触发，
   *     这是剪贴板 API 最理想的调用场景，几乎必然成功。
   *
   * 早期实现把这一步交给 background 的 `copyViaContentScript`，它打的是
   * **当前激活 tab 的 content script** —— 而用户点弹窗里的复制按钮时，
   * 激活页往往就是扩展自己的页面（`chrome-extension://…`），
   * 那里**没有 content script**。于是消息石沉大海，超时后返回 `ok: false`：
   * 用户看到的正是「复制按钮无效」。
   *
   * ## ⚠ 全程不落库
   *
   * 手动复制**不写任何持久状态**（理由见 `justCopied` 的说明）。
   * 剪贴板里那句 `writeText` 本身就是结果，写进去了就成功了 ——
   * 不需要再让后台记一笔。
   *
   * ⚠ 写失败时才回退给 background（`mail:copy-code`）：它还有 content script
   *   那一级，比直接放弃多一次机会。那条路才会落库为 `'failed'`。
   *
   * ⚠ 这是「点击复制」这条路；**自动复制**（收到验证码时）仍然走 background
   *   那套三级降级，那条路没有 focused 文档可用。
   *
   * @param mail 邮件
   * @returns 是否复制成功
   */
  async function copyCode(mail: Mail) {
    const code = mail.code ?? mail.ai?.code
    if (!code)
      return false

    let ok = false
    try {
      await navigator.clipboard.writeText(code)
      ok = true
    }
    catch (error) {
      console.warn('[mail-peon] 页面内写剪贴板失败，回退给 background', error)
      const result = await send<{ ok: boolean }>('mail:copy-code', { mailId: mail.id, code }, { ok: false })
      ok = result.ok
    }

    if (ok)
      markJustCopied(mail.id)

    return ok
  }

  async function setRead(mail: Mail, read: boolean) {
    await send('mail:dismiss', { mailId: mail.id, read }, { ok: false })
    await reload()
  }

  async function dismiss(mail: Mail) {
    await send('mail:dismiss', { mailId: mail.id, dismissed: true }, { ok: false })
    await reload()
  }

  /**
   * 把一封邮件移入回收站。
   *
   * ⚠ 用户可见的说法是「删除」，但底层是**状态变更**（写一个 `trashedAt`），
   *   所以这里可以乐观地立刻从列表里摘掉而不必等广播回来 ——
   *   真出错了回收站页里也找得到它（不会凭空消失）。
   *
   *   刻意**不**做乐观更新：`reload()` 一次只花几毫秒，
   *   而乐观更新在「操作失败」时要回滚，回滚代码是 bug 的高发区。
   *   等广播 + `reload()` 的代价很小，换来的是「界面永远等于库里的真相」。
   *
   * @param mail 要移入回收站的邮件
   * @returns 是否成功
   */
  async function trash(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:trash', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
  }

  async function markAllRead() {
    await send('mail:mark-all-read', undefined, { ok: false })
    await reload()
  }

  onMounted(() => {
    void reload()
    // background 的 `mail:updated` 广播是**唯一**的刷新信号：轮询（setInterval）
    // 会让 SW 反复被唤醒，而 MV3 的 SW 唤醒是有成本的
    installBridgeListener()
    mailUpdateListeners.add(reload)
  })

  onUnmounted(() => {
    mailUpdateListeners.delete(reload)
  })

  return { mails, loading, loadFailed, justCopied, reload, copyCode, setRead, dismiss, trash, markAllRead }
}
