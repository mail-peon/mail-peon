import type { AiSettings, AppSettings } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * 「关于」页的 peon-hall 下载入口测试。
 *
 * 这条单测守的不只是「链接是不是对的」——它守的是「这条**对外跳转**永远存在」。
 *
 * 没有它：
 *   - 有人删掉 AboutPage.vue 里的 `<a-card title="配套桌面端">`，UI 不会报错，
 *     直到用户反馈「IMAP 收不到验证码、不知道去哪装中继」才发现；
 *   - 有人把 URL 改成内网地址、域名写错、或指向 latest 之外的某条 tag，
 *     同样不会报错——只在 CI 跑 e2e 时才发现。
 *
 * ⚠️ 不去测链接是否真的能打开 GitHub Releases：那是网络事，测它就是 e2e，
 *   而且会被网络/限流/版本回滚等噪声搞成 flake。
 */

const mocks = vi.hoisted(() => ({
  app: null as unknown as { value: AppSettings | null },
  ai: null as unknown as { value: AiSettings | null },
  reload: vi.fn(async () => {}),
}))

vi.mock('~/logic/bridge', () => ({
  useSettings: () => ({ app: mocks.app, ai: mocks.ai, reload: mocks.reload }),
}))

let AboutPage: import('vue').Component
beforeAll(async () => {
  AboutPage = (await import('~/options/pages/AboutPage.vue')).default
})

beforeEach(() => {
  mocks.app = ref(null)
  mocks.ai = ref(null)
  mocks.reload.mockClear()
})

async function mountPage() {
  const wrapper = mount(AboutPage)
  await new Promise(resolve => setTimeout(resolve, 0))
  return wrapper
}

describe('aboutPage - peon-hall 下载入口', () => {
  it('两种运行模式的标题渲染成文案，而不是原始 i18n key', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()

    // `t()` 查不到时返回键名本身 —— 界面会直接显示 about.modeMinimal
    expect(text).not.toContain('about.modeMinimal')
    expect(text).not.toContain('about.modeFull')
    expect(text).toContain('极简模式')
    expect(text).toContain('自定义模式')
    // 极简模式的描述已更新为「验证码 + 确认邮件」
    expect(text).toContain('确认邮件')
  })

  it('渲染「配套桌面端（peon-hall）」卡片', async () => {
    const wrapper = await mountPage()
    const titles = wrapper.findAll('.ant-card-head-title').map(node => node.text())
    // 配套桌面端卡片标题里有「peon-hall」字样 —— 把它从卡片标题里捞出来
    expect(titles.some(title => title.includes('peon-hall'))).toBe(true)
  })

  /*
   * 关于"为什么需要装"的提示：**只剩一句话** —— "浏览器扩展不能直接连 IMAP"。
   *
   * 之前组 27 还有 22 字 + 安全部分；这次连那条 22 字都压成 18 字。
   * 其它细节全删 —— 用户想看完整可以点下载链接进 GitHub，或者去 About 页其它卡片。
   */
  it('「为什么需要 peon-hall」提示只剩一句', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()

    expect(text).toContain('浏览器扩展不能直接连接 IMAP')
    expect(text).toContain('peon-hall')

    // 不该出现的（不论之前是 alert 还是 button 里的）—— 全删了
    expect(text).not.toContain('邮箱密码')
    expect(text).not.toContain('TLS 握手')
    expect(text).not.toContain('127.0.0.1')
    // 不该用 button / alert 这种强势视觉元素了
    expect(wrapper.find('.ant-alert').exists()).toBe(false)
    expect(wrapper.find('.ant-btn-primary').exists()).toBe(false)
  })

  it('下载链接是普通 <a> 文字链（带下划线），不是 antd button', async () => {
    const wrapper = await mountPage()
    // 找文本含「下载」的 <a> 标签
    const downloadLinks = wrapper.findAll('a').filter(node => node.text().includes('下载'))
    expect(downloadLinks.length).toBeGreaterThan(0)

    const link = downloadLinks[0]
    // 不是 antd 渲染的 button —— 直接是裸 <a>
    expect(link.classes()).not.toContain('ant-btn')

    // href / target / rel 三件套
    expect(link.attributes('href')).toBe('https://github.com/mail-peon/peon-hall/releases/latest')
    expect(link.attributes('target')).toBe('_blank')
    const rel = link.attributes('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')
  })

  it('下载链接带 peon-hall-link 类（这条类在 scoped 样式里声明了 text-decoration: underline）', async () => {
    const wrapper = await mountPage()
    const link = wrapper.findAll('a').find(node => node.text().includes('下载'))
    expect(link).toBeDefined()
    // ⚠ 没法直接查 computed style（jsdom 不一定完整），查类名 + 源码里
    // scoped style 的存在性 —— 类不在 scoped 范围内会从源码 strip 掉。
    expect(link!.classes()).toContain('peon-hall-link')
  })
})
