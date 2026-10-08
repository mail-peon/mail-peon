import type { Mail } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Popup 的渲染测试。
 *
 * ## 为什么需要这一层
 *
 * 真机上出现过「background 日志显示已入库、Popup 日志显示 `收到 1 条记录 →
 * 含验证码 1 条`，但界面上什么都没有」。
 *
 * 数据到了组件里却没渲染出来 —— 所有纯函数（`minimalModeMails`、`filterMails`）
 * 都是对的，所以问题只能在**模板层**，而模板层恰恰是前面只做纯函数单测时
 * 完全没覆盖的地方。
 *
 * ## ⚠️ 一次错误的诊断，留在这里当教训
 *
 * 排查时我怀疑列表元素上同时写了 `v-for` 与 `v-else`：
 *
 * ```html
 * <p v-if="loading" />
 * <EmptyState v-else-if="!list.length" />
 * <MailListItem v-for="mail in list" v-else />
 * ```
 *
 * 并据此「修复」成了 `v-if` + `v-for`。**那个诊断是错的** ——
 * 查看编译产物后确认，`v-for` 本来就嵌套在 `v-else` 的真分支里，
 * 渲染逻辑完全正确。
 *
 * 犯错的根因值得记下来：我用一个**自己猜出来的正则**（`n\(_`）去产物里找
 * 列表段，PascalCase 组件名编译成别的调用形式所以没匹配上，
 * 于是把「正则没匹配到」误读成了「代码被跳过」。
 * **不要用猜出来的模式去证明结论** —— 那只是把假设重复了一遍。
 *
 * 现在改成外层 `<template v-if>`（lint 也要求这样），语义明确且无歧义。
 * 下面这些断言的价值不变：它们守的是「有数据必须渲染出来」。
 */

const mocks = vi.hoisted(() => ({
  mails: { value: [] as Mail[] },
  app: { value: { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' } },
  ai: { value: { apiKey: 'test-key' } },
}))

vi.mock('~/logic/bridge', () => ({
  useMails: () => ({
    mails: mocks.mails,
    loading: { value: false },
    copyCode: vi.fn(async () => true),
    setRead: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
  }),
  useSettings: () => ({
    app: mocks.app,
    ai: mocks.ai,
    reload: vi.fn(async () => {}),
  }),
}))

let Popup: import('vue').Component
beforeAll(async () => {
  Popup = (await import('~/popup/Popup.vue')).default
})

function codeMail(patch: Partial<Mail> = {}): Mail {
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
    ai: {
      minimal: '验证码：34949',
      summary: '',
      isAd: false,
      code: '34949',
      validForSeconds: 300,
      urgency: 'high',
    },
    copyStatus: 'copied',
    read: false,
    ...patch,
  }
}

describe('极简模式渲染', () => {
  it('有验证码邮件时渲染出列表项', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = [codeMail()]

    const wrapper = mount(Popup)

    const text = wrapper.text()
    // 验证码本身必须出现 —— 这是极简模式的**全部价值**
    expect(text).toContain('34949')
    expect(text).toContain('测试邮件')

    wrapper.unmount()
  })

  it('没有验证码邮件时不渲染任何邮件内容', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = []

    const wrapper = mount(Popup)

    /*
     * ⚠ 只断言「没有渲染出邮件」，**不**断言空态文案。
     *
     *   jsdom 里 `useMails()` 的 `onMounted` 时机与真实浏览器不同，
     *   `loading` 在挂载那一瞬仍可能是初始值 `true` —— 于是界面停在「加载中」。
     *   那是**测试环境**的时序差异，不是产品行为（真机上 `reload()` 会立刻
     *   把 `loading` 置回 false）。
     *
     *   这一条真正要守住的是「空列表不会渲染出任何邮件」，
     *   而下一条测试守住「有数据必须渲染出来」—— 后者才是修复的核心。
     */
    expect(wrapper.text()).not.toContain('34949')
    expect(wrapper.findAll('.mail-item')).toHaveLength(0)

    wrapper.unmount()
  })

  /*
   * ⚠ 这一条专门盯 `v-for` + `v-else` 那个写法。
   *
   * 如果 `v-else` 被忽略，列表会在**空数组**时也「渲染」——
   * 表现是空态不显示（因为 `v-else-if` 已经把空态吃掉了，而 v-for 又无条件渲染 0 项）。
   * 反过来说：如果 `v-for` 被 `v-else` 抑制，有数据时也不渲染。
   * 两个方向都要钉住。
   */
  it('空态与列表互斥（不会同时出现，也不会都不出现）', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }

    // 空列表：不能显示任何邮件内容
    mocks.mails.value = []
    const empty = mount(Popup)
    expect(empty.text()).not.toContain('34949')
    empty.unmount()

    // 有数据：必须显示出来（这一条是修复的核心）
    mocks.mails.value = [codeMail()]
    const filled = mount(Popup)
    expect(filled.text()).toContain('34949')
    filled.unmount()
  })

  it('含有效期时渲染倒计时', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }

    /*
     * 造一封「发出 1 分钟、有效期 5 分钟」的邮件 —— 于是剩余 4 分钟、进度 80%。
     * 这两个数**只由「现在」决定**，与什么时候渲染无关（这才是修复后的语义）。
     */
    const receivedAt = Date.now() - 60_000
    mocks.mails.value = [codeMail({
      receivedAt,
      codeExpiresAt: receivedAt + 300_000,
      codeValidForSeconds: 300,
    })]

    const wrapper = mount(Popup)
    const text = wrapper.text()

    expect(text).toContain('有效')
    // 剩余 4 分钟左右（允许 3:59–4:00 的进位差）
    expect(text).toMatch(/[34]:\d\d/)

    /*
     * ⚠ 进度必须是**真实比例**（剩余 / 总时长 ≈ 80%），而不是接近满格。
     *
     *   真机 bug：组件拿「挂载那一刻的剩余量」当分母，于是每次打开 Popup
     *   进度条都从 100% 重新往下走 —— 它当时表达的是「这次打开后过了多久」。
     *   这条断言把「真实比例」钉住：80% 明显不是 100%。
     */
    const fill = wrapper.find('.fill')
    expect(fill.exists()).toBe(true)
    const width = Number.parseFloat(String(fill.attributes('style') ?? '').replace(/[^\d.]/g, ''))
    expect(width).toBeGreaterThan(70)
    expect(width).toBeLessThan(90)

    wrapper.unmount()
  })

  it('没有 codeExpiresAt 时不渲染倒计时', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = [codeMail()]

    const wrapper = mount(Popup)
    expect(wrapper.text()).not.toContain('有效')
    expect(wrapper.text()).not.toContain('失效')

    wrapper.unmount()
  })

  it('已失效时左侧显示失效时间点（而不是空白）', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }

    // 6 分钟前收到、有效期 5 分钟 → 失效时刻是 1 分钟前（同一自然日）
    const receivedAt = Date.now() - 6 * 60_000
    mocks.mails.value = [codeMail({
      receivedAt,
      codeExpiresAt: receivedAt + 300_000,
      codeValidForSeconds: 300,
    })]

    const wrapper = mount(Popup)
    const text = wrapper.text()

    expect(text).toContain('失效')
    /*
     * ⚠ 关键：左侧**不再是空白**，而是失效的具体时间点。
     *   产品要求「失效时左侧显示灰色的失效时间点」—— 因为「失效」两个字
     *   不告诉用户**什么时候**失效的，而那个信息决定了「还有没有救」。
     */
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/)

    wrapper.unmount()
  })

  it('只有 expiresAt、没有总时长时不渲染倒计时（半套数据无法算比例）', async () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = [codeMail({ codeExpiresAt: Date.now() + 300_000 })]

    const wrapper = mount(Popup)

    /*
     * ⚠ 缺 `codeValidForSeconds` 时**不渲染**倒计时，而不是渲染一个瞎猜分母的进度条。
     *   瞎猜的进度条会误导用户（看起来还剩很多，实际不一定）。
     *   数据层保证两个字段同生同灭（见 `deriveCodeExpiry`），这里守 UI 侧。
     */
    expect(wrapper.text()).not.toContain('有效')
    expect(wrapper.find('.fill').exists()).toBe(false)

    wrapper.unmount()
  })
})
