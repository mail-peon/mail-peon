import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { COPY_FEEDBACK_MS, useCopyFeedback } from '~/logic/copy-feedback'

/**
 * 「√ 复制成功」几秒后自动变回「复制」的行为测试。
 *
 * ## 为什么单独测这个
 *
 * 真机上它**坏过两次**，而两次的原因都不是这段逻辑本身：
 *
 * 1. 第一次：状态存在 `mail.copyStatus` 上，而后台把它落了库 →
 *    广播 + `reload()` 把 `mails.value` 整个换成从库里读回来的新数组
 *    （里面还是 `'copied'`）→ 定时器改的是**已经被换掉的旧对象** ⇒ 界面不变。
 * 2. 第二次：状态是对的，但判定用的字段还是那个持久字段。
 *
 * 所以现在这段逻辑被抽成独立的 `useCopyFeedback`：
 *   - 它**只活在内存里**，不落库、不参与 `reload()`；
 *   - 它能**直接用假定时器测**（见下），不再埋在要连 store 与消息通道的
 *     `useMails` 里 —— 那种东西根本测不动，而坏掉的恰恰是它。
 *
 * ⚠ 用 `vi.useFakeTimers()` 而不是真的等 3 秒：真等会让测试慢，
 *   而且「等了 3 秒」与「定时器到点」之间有竞态，容易出现偶发失败。
 */

/** 把 composable 挂进一个真组件 —— `onUnmounted` 只在组件上下文里有效 */
function mountFeedback() {
  let api!: ReturnType<typeof useCopyFeedback>
  const Host = defineComponent({
    setup() {
      api = useCopyFeedback()
      return () => h('div')
    },
  })
  const wrapper = mount(Host)
  return { api, wrapper }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCopyFeedback', () => {
  it('初始没有任何「刚刚复制」的邮件', () => {
    const { api } = mountFeedback()
    expect(api.justCopied.value.size).toBe(0)
    expect(api.justCopied.value.has('a1:m1')).toBe(false)
  })

  it('标记之后立刻进入「刚刚复制」状态', () => {
    const { api } = mountFeedback()
    api.markCopied('a1:m1')
    expect(api.justCopied.value.has('a1:m1')).toBe(true)
  })

  /*
   * ⚠⚠ 这条就是核心：**到点必须自己复原**。
   *   真机上「一直不变回去」正是这个断言要守的东西。
   */
  it('过了 COPY_FEEDBACK_MS 之后自动复原', async () => {
    const { api } = mountFeedback()
    api.markCopied('a1:m1')
    expect(api.justCopied.value.has('a1:m1')).toBe(true)

    // 差一点点：还不该复原
    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1)
    expect(api.justCopied.value.has('a1:m1')).toBe(true)

    // 到点：复原
    vi.advanceTimersByTime(1)
    expect(api.justCopied.value.has('a1:m1')).toBe(false)
  })

  /*
   * ⚠ `Set` 的增删**不触发** Vue 响应式 —— `ref` 只追踪 `.value` 的整体替换。
   *   如果哪天有人把实现改成就地 `justCopied.value.add(...)`，
   *   界面就不会重渲染（点了复制没反应），而上面那些断言**照样通过**。
   *   所以这一条专门盯「`.value` 换了新对象」。
   */
  it('每次标记都替换整个 Set（就地 add 不会触发响应式）', () => {
    const { api } = mountFeedback()
    const before = api.justCopied.value

    api.markCopied('a1:m1')

    expect(api.justCopied.value).not.toBe(before)
  })

  it('复原时也是替换整个 Set', () => {
    const { api } = mountFeedback()
    api.markCopied('a1:m1')
    const flagged = api.justCopied.value

    vi.advanceTimersByTime(COPY_FEEDBACK_MS)

    expect(api.justCopied.value).not.toBe(flagged)
  })

  /*
   * 用户可能有**两封**验证码要复制。第一封的成功提示不该被第二封影响，
   * 也不该两封一起消失（各自有自己的定时器）。
   */
  it('多封邮件各自独立计时', () => {
    const { api } = mountFeedback()

    api.markCopied('a1:first')
    vi.advanceTimersByTime(1000)
    api.markCopied('a1:second')

    // 走到第一封的截止点：只有它复原
    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1000)
    expect(api.justCopied.value.has('a1:first')).toBe(false)
    expect(api.justCopied.value.has('a1:second')).toBe(true)

    // 再走一会儿，第二封也复原
    vi.advanceTimersByTime(1000)
    expect(api.justCopied.value.has('a1:second')).toBe(false)
  })

  /*
   * ⚠ 重复点同一封不能叠出两个定时器 —— 否则第一个到点就把提示清掉，
   *   用户会看到「刚点完就又变回复制了」（反馈时长被腰斩）。
   */
  it('重复标记同一封时重新计时，不会提前复原', () => {
    const { api } = mountFeedback()

    api.markCopied('a1:m1')
    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 100) // 快到点了
    api.markCopied('a1:m1') // 又点一次 → 应该重新计时

    // 走完**原来**那个定时器该到的时间点
    vi.advanceTimersByTime(200)
    // 还在（说明旧定时器被清掉了，没有被腰斩）
    expect(api.justCopied.value.has('a1:m1')).toBe(true)

    // 走完新一轮
    vi.advanceTimersByTime(COPY_FEEDBACK_MS)
    expect(api.justCopied.value.has('a1:m1')).toBe(false)
  })

  /*
   * ⚠ 组件卸载要清掉定时器。不清的话它们还会各跑一次 ——
   *   虽然改的是一个已经没人看的状态，但那是泄漏：
   *   弹窗每次打开都注册一遍，开开关关几十次就攒下一堆悬空定时器。
   */
  it('组件卸载后定时器不再改状态（不泄漏）', async () => {
    const { api, wrapper } = mountFeedback()
    api.markCopied('a1:m1')

    wrapper.unmount()
    await nextTick()

    const afterUnmount = api.justCopied.value

    // 推进到原定时器该触发的时间点：状态不该再被改动
    vi.advanceTimersByTime(COPY_FEEDBACK_MS * 2)
    expect(api.justCopied.value).toBe(afterUnmount)
    expect(api.justCopied.value.has('a1:m1')).toBe(true)
  })
})
