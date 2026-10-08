import type { Mail } from '~/logic/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import MailListItem from '~/components/MailListItem.vue'

/**
 * 取源码里 `<style scoped>` 之后的 CSS（解析规则用）。
 *
 * ⚠ 参数是**正则源码**，不是转义后的字面量 —— 选择器里有 `.` 之类的元字符。
 *   早期版本在这里又转义了一次，于是传进来的 `\s*` 变成字面量、
 *   规则永远找不到，而失败信息是「样式里找不到规则」，
 *   看起来像样式缺了，其实是断言写错了。
 */
function ruleBody(css: string, selectorPattern: string): string {
  const match = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match)
    throw new Error(`样式里找不到规则：${selectorPattern}`)
  return match[1]
}

const source = readFileSync(resolve(process.cwd(), 'src/components/MailListItem.vue'), 'utf8')

/**
 * 去掉注释后的 CSS 文本。
 *
 * ⚠ 断言「某条声明**不**存在」时必须用这个，不能用原始源码 ——
 *   本项目习惯在注释里写「早期版本设过 `pointer-events: none`」这类
 *   反向说明，而正则会把它一起匹配上，于是得到**假的失败**：
 *   代码明明是对的，测试却说错了。
 *   （「显示规则不依赖 `.mail-item:hover`」那条就是这么被咬的。）
 */
const css = source
  .slice(source.indexOf('<style scoped>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 卡片上两个按钮的**独立性**测试。
 *
 * ## 为什么值得单独一个文件
 *
 * 真机上出现过「长按复制按钮，删除按钮显示；松开就隐藏」——
 * 而这两件事**本该毫无关系**。根因是把删除按钮的显示条件挂到了
 * `.mail-item:hover` 一类「卡片整体」的状态上：
 *
 *   卡片内部一重渲染（点复制 → 按钮换成「√ 复制成功」）→
 *   浏览器不重算悬停状态 → 卡片级 `:hover` 残留或错乱 →
 *   删除按钮跟着复制按钮的行为走。
 *
 * 修法是让删除按钮**只看自己**：鼠标进出它自己的热区由 `mouseenter` /
 * `mouseleave` 直接驱动，不经手任何 CSS `:hover` 组合。
 * 这样它与复制按钮在实现上就没有任何共享状态了。
 *
 * ⚠ jsdom 不跑 CSS，所以这里测不了「悬停会不会卡住」。
 *   但能测**结构上的独立性**，而那正是这类 bug 的来源：
 *   - 两个按钮是**兄弟**（不同父元素链），不共享任何条件渲染；
 *   - 点复制只改复制那一边的 DOM，删除那一边的节点**原样不动**
 *     （`isSameNode` —— 一旦有人给它们套上同一个 `v-if`，这条立刻失败）。
 */

function makeMail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'a1:m1',
    accountId: 'a1',
    from: [{ name: '测试发件人', address: 'from@example.com' }],
    to: [],
    subject: '测试邮件',
    snippet: '',
    receivedAt: Date.now(),
    processing: 'skipped',
    code: '34949',
    copyStatus: 'none',
    read: false,
    ...patch,
  }
}

function mountItem(patch: Partial<Mail> = {}, props: Record<string, unknown> = {}) {
  return mount(MailListItem, {
    props: { mail: makeMail(patch), ...props },
    // 卡片根节点上的点击会被当成「打开邮件」，测试里不需要真的处理
    attachTo: document.body,
  })
}

describe('删除按钮与复制按钮互相独立', () => {
  it('两个按钮同时存在于卡片里', () => {
    const wrapper = mountItem()

    expect(wrapper.find('.copy').exists()).toBe(true)
    expect(wrapper.find('.trash-zone').exists()).toBe(true)
    expect(wrapper.find('.trash').exists()).toBe(true)

    wrapper.unmount()
  })

  /*
   * ⚠ 结构上的独立性：删除按钮**不**在复制按钮的容器里，
   *   两者唯一的共同祖先是卡片的 `<header>` / `<article>`。
   *   一旦有人把它们塞进同一个 `v-if` / 同一个 wrapper，这条会失败。
   */
  it('删除按钮不在复制按钮的容器里（不共享条件渲染）', () => {
    const wrapper = mountItem()

    const copy = wrapper.find('.copy')
    const trashZone = wrapper.find('.trash-zone')

    expect(copy.element.contains(trashZone.element)).toBe(false)
    expect(trashZone.element.contains(copy.element)).toBe(false)

    wrapper.unmount()
  })

  /*
   * ⚠⚠ 核心回归：**点复制不能让删除按钮的节点被重建**。
   *
   *   用 `isSameNode` 而不是「还在不在」——
   *   即使删除按钮「还在」，只要它被重新创建过，
   *   与它相关的悬停 / 焦点状态就会被浏览器清掉或卡住，
   *   表现就是「长按复制，删除按钮乱闪」。
   */
  it('点复制之后，删除按钮的 DOM 节点是同一个（没被重建）', async () => {
    const wrapper = mountItem()
    const trashBefore = wrapper.find('.trash-zone').element

    await wrapper.find('.copy').trigger('click')

    expect(wrapper.find('.trash-zone').element.isSameNode(trashBefore)).toBe(true)

    wrapper.unmount()
  })

  it('点复制只改复制那一边（按钮 → 成功提示）', async () => {
    const wrapper = mountItem()

    expect(wrapper.find('.copy').exists()).toBe(true)

    // `justCopied` 是父组件传下来的 prop（真实场景里由 `useMails` 驱动）
    await wrapper.setProps({ justCopied: true })

    expect(wrapper.find('.copy').exists()).toBe(false)
    expect(wrapper.find('.copy-done').exists()).toBe(true)
    // 删除按钮不受任何影响
    expect(wrapper.find('.trash-zone').exists()).toBe(true)

    wrapper.unmount()
  })

  it('点复制会 emit copy，点删除会 emit trash（互不串台）', async () => {
    const wrapper = mountItem()

    await wrapper.find('.copy').trigger('click')
    expect(wrapper.emitted('copy')).toHaveLength(1)
    expect(wrapper.emitted('trash')).toBeUndefined()

    await wrapper.find('.trash').trigger('click')
    expect(wrapper.emitted('trash')).toHaveLength(1)
    // 点删除**不该**顺带触发复制（各自 @click.stop）
    expect(wrapper.emitted('copy')).toHaveLength(1)

    wrapper.unmount()
  })

  /*
   * ⚠ 点删除也不该让卡片「打开邮件」——那是最让人恼火的结果：
   *   想删一封，结果它被标已读 + 展开。
   */
  it('点删除不会触达卡片的打开行为', async () => {
    const wrapper = mountItem()
    const opened = vi.fn()
    // 卡片根节点的 @click 就是「打开」
    wrapper.vm.$el.addEventListener('click', opened)

    await wrapper.find('.trash').trigger('click')

    expect(opened).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('删除按钮的显示由鼠标事件驱动', () => {
  /*
   * ⚠⚠ 这一组是那个真机 bug 的断言版：
   *   「长按复制按钮，删除按钮显示；松开就隐藏」——
   *   两个本该无关的按钮被一条 CSS `:hover` 条件绑在了一起。
   *
   *   修法：显示状态改由 `mouseenter` / `mouseleave` 显式驱动。
   *   CSS `:hover` 在卡片内部重渲染后不重新求值，而这两个事件由浏览器
   *   在指针真的进出时触发，一定会到、也一定会清。
   */
  it('鼠标进卡片 → 删除按钮出现；离开 → 消失', async () => {
    const wrapper = mountItem()
    const zone = wrapper.find('.trash-zone')

    expect(zone.classes()).not.toContain('is-visible')

    await wrapper.find('.mail-item').trigger('mouseenter')
    expect(wrapper.find('.trash-zone').classes()).toContain('is-visible')

    await wrapper.find('.mail-item').trigger('mouseleave')
    expect(wrapper.find('.trash-zone').classes()).not.toContain('is-visible')

    wrapper.unmount()
  })

  /*
   * ⚠ 鼠标进入热区本身也保证可见 —— 这样即使卡片的 `mouseenter` 因为
   *   某种原因没派发到，图标也不会「明明鼠标在上面却不显示」。
   */
  it('鼠标进热区也能让它可见', async () => {
    const wrapper = mountItem()

    await wrapper.find('.trash-zone').trigger('mouseenter')
    expect(wrapper.find('.trash-zone').classes()).toContain('is-visible')

    wrapper.unmount()
  })

  /*
   * ⚠⚠ 核心：**点复制不能让删除按钮出现或消失**。
   *   这正是用户报的那个 bug 的断言。
   */
  it('点复制不影响删除按钮的可见状态', async () => {
    const wrapper = mountItem()

    // 鼠标不在卡片里
    await wrapper.find('.copy').trigger('click')
    await wrapper.setProps({ justCopied: true })
    expect(wrapper.find('.trash-zone').classes()).not.toContain('is-visible')

    // 鼠标在卡片里：复制之后仍然可见（不该被复制动作改变）
    await wrapper.find('.mail-item').trigger('mouseenter')
    await wrapper.setProps({ justCopied: false })
    expect(wrapper.find('.trash-zone').classes()).toContain('is-visible')

    wrapper.unmount()
  })

  /*
   * ⚠ 热区必须**始终**能接收指针事件。
   *   早期版本在隐藏时设 `pointer-events: none`，看似更安全，
   *   但它有个致命副作用：**隐藏的元素收不到 `mouseenter`，永远没法把自己点亮**。
   *   这条断言把那个回归钉住。
   */
  it('热区不靠 pointer-events 隐藏（否则无法被点亮）', () => {
    const body = ruleBody(css, '\\.trash-zone')
    expect(body).not.toMatch(/pointer-events:\s*none/)

    // 可见性只由 opacity 控制，并且由 `.is-visible` 打开
    expect(body).toMatch(/opacity:\s*0/)
    expect(css).toMatch(/\.trash-zone\.is-visible/)
  })
})

describe('删除按钮的样式契约', () => {
  /*
   * ⚠ 这里**只**留「定位祖先是谁」这一条 —— 它决定 `top` / `right`
   *   **相对谁**算，而那正是「图标跑到时间上方」那个 bug 的根因。
   *
   *   具体数值（该是多少、与卡片 padding 的算术关系）在
   *   `mail-item-style.spec.ts` 里测 —— 那边断言的是**关系**而不是写死的数。
   *   两个文件都测数值的话，改一次设计要改两处，
   *   而且两处的阈值迟早不一致（这里就发生过：偏移从 7px 改成 4px 后
   *   这条 `>= 6px` 的旧断言立刻假失败）。
   */
  it('.mail-item 是定位祖先（否则偏移不算在卡片上）', () => {
    expect(ruleBody(css, '\\.mail-item')).toMatch(/position:\s*relative/)
  })

  it('没有焦点框（用户明确要求按下后不要边框）', () => {
    const body = ruleBody(css, '\\.trash:focus,[\\s\\S]*?\\.trash:focus-visible')
    expect(body).toMatch(/outline:\s*none/)
  })

  it('键盘用户能看到（focus-within 保留可见性）', () => {
    expect(css).toMatch(/\.mail-item:focus-within\s+\.trash-zone/)
  })

  /*
   * ⚠ 显示规则**不能**再依赖卡片级 `:hover` 组合 —— 那是 bug 的来源。
   */
  it('显示规则不依赖 .mail-item:hover', () => {
    expect(css).not.toMatch(/\.mail-item:hover\s+\.trash-zone/)
  })

  /*
   * ⚠⚠ 时间与垃圾桶**互斥**：垃圾桶出现在右上角时，时间必须让位。
   *
   *   两者视觉上占**同一个位置**（时间在文档流、垃圾桶绝对定位盖在它上面）。
   *   时间不消失的话，垃圾桶会叠在时间文字上，两个东西糊在一起 ——
   *   用户报的「hover card 后时间没消失」就是这个。
   *
   *   ⚠ 关键是两者由**同一个状态值**驱动：`trashZoneVisible`。
   *     所以断言的是「DOM 上两个 class 同时切换」，
   *     而不是「某条 CSS 选择器存在」——
   *     早期版本用兄弟选择器（`.trash-zone.is-visible ~ .time-slot .time`）
   *     看着等价、实际静默不匹配，而**没有任何断言能发现它**
   *     （因为它测的是「规则在不在」，不是「效果有没有」）。
   */
  it('鼠标进卡片 → 垃圾桶可见，且时间同时让位（同一个状态）', async () => {
    const wrapper = mountItem()

    expect(wrapper.find('.time-slot').classes()).not.toContain('is-hidden')

    await wrapper.find('.mail-item').trigger('mouseenter')

    expect(wrapper.find('.trash-zone').classes()).toContain('is-visible')
    expect(wrapper.find('.time-slot').classes()).toContain('is-hidden')

    await wrapper.find('.mail-item').trigger('mouseleave')

    expect(wrapper.find('.trash-zone').classes()).not.toContain('is-visible')
    expect(wrapper.find('.time-slot').classes()).not.toContain('is-hidden')

    wrapper.unmount()
  })

  /*
   * ⚠ 反向：时间**不能**再用 CSS 兄弟选择器那一套。
   *   那种写法把判断寄托在「另一个元素的 class + DOM 顺序 + scoped 属性」
   *   三件事同时成立上，任何一环不对就静默失效。
   */
  it('时间的显隐由 class 驱动，不用兄弟选择器', () => {
    expect(css).toMatch(/\.time-slot\.is-hidden\s+\.time/)
    expect(css).not.toMatch(/\.trash-zone\.is-visible\s*~/)
    expect(css).not.toMatch(/\.trash-zone:hover\s*~/)
    expect(css).not.toMatch(/\.mail-item:hover\s+\.time\s*\{/)
  })

  it('再悬停按钮本身才变红', () => {
    expect(ruleBody(css, '\\.trash:hover')).toMatch(/color:\s*var\(--mp-danger\)/)
  })
})
