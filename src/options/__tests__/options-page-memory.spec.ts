import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { forgetRememberedPage, readRememberedPage, rememberPage } from '~/logic/options-page-memory'

/**
 * 设置页的「上次停在哪一页」记忆。
 *
 * ## 守的是什么
 *
 * 1. **刷新后不回弹**：重新挂载（= 刷新）时直接落在记忆里的那一页；
 * 2. **记忆要经过校验**：旧版本可能存过一个已经删掉的页面 id —— 那时必须回退到
 *    「通用」，而不是停在一个**没有任何内容的页面**上（那个现象看起来像渲染坏了）；
 * 3. **只有用户点导航才写记忆**：极简模式把隐藏页拉回「通用」是**程序性**跳转，
 *    不该覆盖用户的选择。
 *
 * ⚠ 这里把七个页面组件都换成桩：本测试关心的是**导航与路由**，
 *   而不是那些页面自己的数据加载（各自另有测试）。不换桩的话，挂载 Options
 *   会把整个设置页的依赖树（含 antd 的表格 / 表单）都拉起来。
 */

const mocks = vi.hoisted(() => ({
  /** 可写：用来模拟「切到极简模式」 */
  app: null as unknown as { value: { minimalMode: boolean } },
}))

vi.mock('~/logic/bridge', () => ({
  useSettings: () => ({
    app: mocks.app,
    ai: { value: null },
    reload: vi.fn(async () => {}),
  }),
}))

function stub(name: string) {
  return { default: { name, template: `<div class="stub-${name}" />` } }
}

vi.mock('~/options/pages/GeneralPage.vue', () => stub('general'))
vi.mock('~/options/pages/AccountsPage.vue', () => stub('accounts'))
vi.mock('~/options/pages/RulesPage.vue', () => stub('rules'))
vi.mock('~/options/pages/AiPage.vue', () => stub('ai'))
vi.mock('~/options/pages/BlockedPage.vue', () => stub('blocked'))
vi.mock('~/options/pages/TrashPage.vue', () => stub('trash'))
vi.mock('~/options/pages/AboutPage.vue', () => stub('about'))

let Options: import('vue').Component
beforeEach(async () => {
  mocks.app = ref({ minimalMode: false })
  forgetRememberedPage()
  Options = (await import('~/options/Options.vue')).default
})

/** 当前选中的导航项文案 */
function selectedNav(wrapper: ReturnType<typeof mount>): string {
  return wrapper.find('.ant-menu-item-selected').text()
}

async function clickNav(wrapper: ReturnType<typeof mount>, label: string) {
  const item = wrapper.findAll('.ant-menu-item').find(node => node.text() === label)
  if (!item)
    throw new Error(`导航里没有「${label}」—— 页面清单改了？`)
  await item.trigger('click')
  await wrapper.vm.$nextTick()
}

/**
 * 挂载并等 `onMounted` 跑完。
 *
 * ⚠ 必须等：`onMounted` 里先 `await reload()` 再 `ensureVisiblePage()`，
 *   而**路由校正发生在那一拍之后**。不等的话，断言看到的是校正前的状态 ——
 *   第一版就因此得到「导航里一个选中项都没有」这种看不懂的失败。
 */
async function mountOptions() {
  const wrapper = mount(Options)
  for (let i = 0; i < 4; i++)
    await Promise.resolve()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('设置页的 tab 记忆', () => {
  it('没有记忆时停在「通用」', async () => {
    const wrapper = await mountOptions()
    expect(selectedNav(wrapper)).toBe('通用')
    wrapper.unmount()
  })

  it('有记忆时直接落在那一页（刷新不回弹）', async () => {
    rememberPage('trash')

    const wrapper = await mountOptions()
    expect(selectedNav(wrapper)).toBe('回收站')
    // 主区渲染的也是那一页，而不只是导航高亮
    expect(wrapper.find('.stub-trash').exists()).toBe(true)

    wrapper.unmount()
  })

  it('点导航会写入记忆（供下次刷新使用）', async () => {
    const wrapper = await mountOptions()
    await clickNav(wrapper, 'AI 配置')

    expect(selectedNav(wrapper)).toBe('AI 配置')
    expect(readRememberedPage(['general', 'accounts', 'rules', 'ai', 'blocked', 'trash', 'about'], 'general')).toBe('ai')

    wrapper.unmount()
  })

  /*
   * ⚠ 这一条是「校验」的价值所在：不校验的话，界面会停在一个空页面上 ——
   *   导航里没有任何选中项、主区一片空白，看起来像渲染坏了。
   */
  it('记忆里是不认识的页面时回退到「通用」', async () => {
    // 直接写一个「旧版本留下的」id
    globalThis.localStorage.setItem('mail-peon:options-page', 'legacy-page')

    const wrapper = await mountOptions()
    expect(selectedNav(wrapper)).toBe('通用')

    wrapper.unmount()
  })

  /*
   * ⚠ 极简模式会把停在隐藏页（提示词 / 屏蔽列表）的路由拉回「通用」——
   *   那是**程序性**跳转，不能把它写进记忆，否则用户切回完整模式时
   *   就回不到提示词页了。
   */
  it('极简模式把隐藏页拉回「通用」，但不覆盖记忆', async () => {
    rememberPage('rules')
    mocks.app.value = { minimalMode: true }

    const wrapper = await mountOptions()
    // 极简模式下「提示词」不在导航里，当前页被拉回「通用」
    expect(selectedNav(wrapper)).toBe('通用')
    expect(wrapper.find('.stub-rules').exists()).toBe(false)

    // 记忆还是「提示词」：切回完整模式应当能回去
    expect(globalThis.localStorage.getItem('mail-peon:options-page')).toBe('rules')

    wrapper.unmount()
  })
})
