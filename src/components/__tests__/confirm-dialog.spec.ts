import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

/**
 * 确认弹窗的测试。
 *
 * ## 为什么这层值得测
 *
 * 它是**破坏性操作的唯一闸门**。这类组件的 bug 不会表现为「界面不对」，
 * 而是「用户点了一下，邮件没了」—— 而那是不可撤销的。
 *
 * 特别要守住的一条：**默认焦点在「取消」上**。
 * 如果哪天有人把它挪到「确认」（或者干脆不聚焦），
 * 用户习惯性敲回车就会删掉邮件。这条断言就是防这个的。
 *
 * ⚠ 断言用 `.open` 判定是否渲染，而不是去数 DOM 节点 ——
 *   弹窗用 `v-if`，关闭时**整个子树都不存在**（这是刻意的：
 *   隐藏的弹窗不该留在 Tab 顺序里）。
 *
 * ⚠ 按钮的类名是 **antd 的**（`ant-btn-primary` / `ant-btn-dangerous`）：
 *   弹窗内部已经换成 `a-button`，所以「主色还是红色」这件事由 antd 的
 *   `type` / `danger` 表达，而不是我们自己的 `mp-btn-*`。
 */

/**
 * 去掉空白后的按钮文案。
 *
 * ⚠ antd 默认会在**两个汉字**的按钮里插一个空格（"取 消"、"彻 底 删 除"）。
 *   应用里靠 `ConfigProvider` 的 `autoInsertSpaceInButton: false` 关掉了它，
 *   但**单独挂载这个组件**的测试没有那层 Provider，于是拿到的是插了空格的文本。
 *   这里去掉空白再断言 —— 强度不变（文案错了照样失败），
 *   只是不把「antd 的排版细节」当成产品行为来考。
 */
function buttonLabel(text: string): string {
  return text.replace(/\s+/g, '')
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(ConfirmDialog, {
    props: {
      open: true,
      title: '彻底删除这封邮件？',
      message: '「测试邮件」将被永久移除，此操作无法撤销。',
      confirmText: '彻底删除',
      danger: true,
      ...props,
    },
    attachTo: document.body,
  })
}

describe('confirmDialog（破坏性操作的唯一闸门）', () => {
  it('open 为 false 时整个弹窗不存在（不进 Tab 顺序）', () => {
    const wrapper = mountDialog({ open: false })
    expect(wrapper.find('.overlay').exists()).toBe(false)
    expect(wrapper.find('.dialog').exists()).toBe(false)
    wrapper.unmount()
  })

  it('open 为 true 时渲染标题、正文与两个按钮', () => {
    const wrapper = mountDialog()

    expect(wrapper.find('.title').text()).toBe('彻底删除这封邮件？')
    expect(wrapper.find('.message').text()).toContain('无法撤销')

    const buttons = wrapper.findAll('.actions button')
    expect(buttons).toHaveLength(2)
    expect(buttonLabel(buttons[0].text())).toBe('取消')
    expect(buttonLabel(buttons[1].text())).toBe('彻底删除')

    wrapper.unmount()
  })

  /*
   * ⚠ 核心断言：默认焦点必须在「取消」那一侧。
   */
  it('默认焦点在取消按钮上（敲回车不会误删）', async () => {
    const wrapper = mountDialog()
    await new Promise(resolve => setTimeout(resolve, 0))

    const active = document.activeElement
    expect(active?.textContent && buttonLabel(active.textContent)).toBe('取消')

    wrapper.unmount()
  })

  it('点确认只触发 confirm，不触发 cancel', async () => {
    const wrapper = mountDialog()

    await wrapper.findAll('.actions button')[1].trigger('click')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toBeUndefined()

    wrapper.unmount()
  })

  it('点取消只触发 cancel', async () => {
    const wrapper = mountDialog()

    await wrapper.findAll('.actions button')[0].trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  /*
   * ⚠ 点遮罩 = 取消。危险操作不该因为「点偏了」而执行。
   */
  it('点遮罩触发 cancel', async () => {
    const wrapper = mountDialog()

    await wrapper.find('.overlay').trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  /*
   * ⚠ 点弹窗本体（不是按钮）**不该**关掉它 ——
   *   否则用户在正文上选个文字、或者手抖点一下空白处，弹窗就没了，
   *   而他会以为「确认过了」。
   */
  it('点弹窗本体不做任何事', async () => {
    const wrapper = mountDialog()

    await wrapper.find('.dialog').trigger('click')

    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  it('按 Escape 触发 cancel', async () => {
    const wrapper = mountDialog()
    await new Promise(resolve => setTimeout(resolve, 0))

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  /*
   * ⚠ 关闭之后 Esc 必须**不再**触发任何事件。
   *   监听器忘了摘的话，调用方会在弹窗之外收到莫名其妙的 cancel ——
   *   那种 bug 表现为「有时候列表会自己刷新」，极难归因。
   */
  it('关闭后 Escape 不再触发事件（监听器已摘掉）', async () => {
    const wrapper = mountDialog()
    await new Promise(resolve => setTimeout(resolve, 0))

    await wrapper.setProps({ open: false })
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('cancel')).toBeUndefined()

    wrapper.unmount()
  })

  it('danger 为假时确认按钮是主色，不带 danger', () => {
    const wrapper = mountDialog({ danger: false })
    const confirmButton = wrapper.findAll('.actions button')[1]
    expect(confirmButton.classes()).toContain('ant-btn-primary')
    expect(confirmButton.classes()).not.toContain('ant-btn-dangerous')
    wrapper.unmount()
  })

  /*
   * ⚠ 危险按钮在 antd 里是「primary + dangerous」两个类**同时**有
   *   （红底实心按钮）。所以这里只能断言「带 danger」，不能再断言
   *   「不带 primary」—— 那是我们自己那套 `mp-btn-*` 的旧约定。
   */
  it('danger 为真时确认按钮带 danger（红底实心）', () => {
    const wrapper = mountDialog()
    const confirmButton = wrapper.findAll('.actions button')[1]
    expect(confirmButton.classes()).toContain('ant-btn-dangerous')
    wrapper.unmount()
  })
})
