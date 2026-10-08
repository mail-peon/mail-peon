import type { Ref } from 'vue'
import { onUnmounted, ref } from 'vue'

/**
 * 「刚刚复制成功」的瞬时反馈状态。
 *
 * ## ⚠ 为什么单独一个模块，而且不落库
 *
 * 用户点一下「复制」之后，界面上要把那个按钮换成绿色的「√ 复制成功」，
 * 几秒后**自己变回**「复制」。这是**纯前端、转瞬即逝**的东西 ——
 * 不该被记住，也不该进 IndexedDB。
 *
 * 它曾经和 `Mail.copyStatus`（持久字段，由「自动复制」流水线写）混在一起用，
 * 后果是界面上的成功提示**永远清不掉**：
 *
 *   点击复制 → 本地标 `copyStatus = 'copied'` → 同时让后台落库 →
 *   后台广播 `mail:updated` → `useMails().reload()` 把 `mails.value`
 *   **整个换成从库里读回来的新数组**（里面的 `copyStatus` 还是 `'copied'`）→
 *   3 秒后定时器改的是**已经被换掉的那个旧对象** ⇒ 界面不变。
 *
 * 抽成独立模块还有两个好处：
 *
 *   1. 它的行为（几秒后复原）可以**直接用假定时器测** —— 之前它埋在
 *      `useMails` 里，那是个要连 store / 消息通道的重家伙，测不动；
 *   2. `Set` 的增删不触发 Vue 响应式（`ref` 只追踪 `.value` 的整体替换），
 *      这个坑集中在一处，用注释钉住。
 */

/** 「√ 复制成功」显示多久后变回「复制」 */
export const COPY_FEEDBACK_MS = 3000

export interface CopyFeedback {
  /** 刚刚复制成功的邮件 id 集合 */
  justCopied: Ref<Set<string>>
  /** 标记某封「刚刚复制成功」，`COPY_FEEDBACK_MS` 后自动清掉 */
  markCopied: (mailId: string) => void
}

/**
 * 建一个复制反馈状态。
 *
 * ⚠ 必须在**组件的 `setup()` 里**调用：它用了 `onUnmounted` 来清定时器。
 *
 * @returns 状态与标记函数
 */
export function useCopyFeedback(): CopyFeedback {
  const justCopied = ref(new Set<string>()) as Ref<Set<string>>

  /** 每个 id 一个定时器；重复点同一封时先清掉旧的，不会叠出两个 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * 标记「刚刚复制成功」。
   *
   * ⚠ 每次都用**新的 `Set`**（而不是 `.add()`）：
   *   `Set` 的增删不会触发 Vue 的响应式 —— `ref` 只追踪 `.value` 的**整体替换**。
   *   就地 `add` 的话模板不会重渲染，界面根本不会变成「√ 复制成功」。
   *   看起来多分配一个对象，但这是唯一能保证刷新的写法（而且集合很小）。
   *
   * @param mailId 邮件 id
   */
  function markCopied(mailId: string) {
    justCopied.value = new Set(justCopied.value).add(mailId)

    const existing = timers.get(mailId)
    if (existing)
      clearTimeout(existing)

    timers.set(mailId, setTimeout(() => {
      timers.delete(mailId)
      const next = new Set(justCopied.value)
      next.delete(mailId)
      justCopied.value = next
    }, COPY_FEEDBACK_MS))
  }

  onUnmounted(() => {
    /*
     * ⚠ 定时器必须清掉：每个都持有 `justCopied` 的闭包。
     *   不清的话，用户关掉弹窗后它们还会各跑一次 ——
     *   虽然改的是一个已经没人看的状态，但那是**泄漏**：
     *   弹窗每次打开都会注册一遍，开开关关几十次就攒下一堆悬空定时器。
     */
    for (const timer of timers.values())
      clearTimeout(timer)
    timers.clear()
  })

  return { justCopied, markCopied }
}
