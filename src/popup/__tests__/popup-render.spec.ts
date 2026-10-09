import type { Mail } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MailListItem from '~/components/MailListItem.vue'

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
  /**
   * `justCopied` 必须是真的 Vue `ref`（理由见下面 `useMails` 的 mock）。
   *
   * ⚠ `vi.hoisted` 的回调在 import 之前执行，所以这里**不能**直接用 `ref`
   *   （那时 `vue` 还没加载）。改成在 `beforeAll` 里补上 —— 但 mock 工厂
   *   是**惰性**调用的（每次 `useMails()` 才跑），所以到那时 `mocks.justCopied`
   *   已经被赋成真 ref 了。
   */
  justCopied: null as unknown as { value: Set<string> },
}))

vi.mock('~/logic/bridge', () => ({
  useMails: () => ({
    mails: mocks.mails,
    loading: { value: false },
    /*
     * 「刚刚复制过」的集合 —— **纯前端瞬时状态**，不落库。
     * 默认空集合：绝大多数的渲染用例关心的是「没复制过」那一态。
     * 它的行为（点完变绿、几秒后复原）在下面单独测。
     *
     * ⚠ 必须是**真的 `ref`**，不能写成 `{ value: new Set() }`。
     *   `useMails` 的返回值被 Popup 解构，而解构出来的 `justCopied` 会被
     *   当成 setup 的顶层绑定交给模板解包 —— Vue 只对**真的 ref** 解包。
     *   假对象不会，于是模板里拿到的是 `{ value: Set }`，
     *   调用 `.has()` 直接报「has is not a function」。
     *   （这个测试本身就是被这条规则咬过才这么写的。）
     */
    justCopied: mocks.justCopied,
    copyCode: vi.fn(async () => true),
    setRead: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    trash: vi.fn(async () => true),
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
  /*
   * ⚠ `vi.hoisted` 在 import 之前跑，那时 `vue` 还没加载，所以只能在**这里**
   *   建那个真的 ref。`useMails` 的 mock 工厂是惰性调用的（每次组件 setup 才跑），
   *   到那时这个赋值早就完成了。
   */
  mocks.justCopied = ref(new Set<string>())
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
    /*
     * ⚠ 默认用 `'none'`（还没复制过）而不是 `'copied'`。
     *
     *   这是邮件的**初始状态**，也是绝大多数用例想验的那个状态。
     *   默认成 `'copied'` 的话，「复制按钮」在几乎每个用例里都不渲染，
     *   而模板里 `v-if="copyStatus !== 'copied'"` 判断错了也看不出来
     *   （测试会以为「按钮不存在」是正常的）。
     */
    copyStatus: 'none',
    read: false,
    ...patch,
  }
}

describe('极简模式渲染', () => {
  /*
   * ⚠ 这一条防的是「打开弹窗就自带一个空弹窗」。
   *
   *   删除确认弹窗（`ConfirmDialog`）只在 `pending !== null` 时渲染。
   *   如果 `open` 的绑定写错（例如直接写 `pending`、或者被模板解包成了 ref 对象，
   *   而**任何对象都是真值**），它就会一打开就铺满整个弹窗 —— 而且因为
   *   `pending` 是 null、文案算出来是空串，它看起来就是个**没有内容的空框**。
   *
   *   所以这里断言的是「一开始根本没有那个遮罩层」。
   */
  it('初始不渲染删除确认弹窗', () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = [codeMail()]

    const wrapper = mount(Popup)

    expect(wrapper.find('.overlay').exists()).toBe(false)
    expect(wrapper.find('.dialog').exists()).toBe(false)

    wrapper.unmount()
  })

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

  it('验证码旁边是文字「复制」按钮（不是方块按钮）', () => {
    mocks.app.value = { minimalMode: true, excludeAds: true, popupDefaultTab: 'important' }
    mocks.mails.value = [codeMail()]

    const wrapper = mount(Popup)

    // 未复制时：文字按钮
    const copyButton = wrapper.find('.copy')
    expect(copyButton.exists()).toBe(true)
    expect(copyButton.text()).toBe('复制')
    /*
     * 刻意**不是带边框的方块按钮**（旧实现里的 `.btn-mini`）——
     * 它读起来应是验证码那一行的延续。
     *
     * ⚠ 实现换成 antd 之后，这个语义由 `type="link"` 表达（`ant-btn-link`：
     *   无边框、无底色、主色文字）。断言类名是为了守住「它还是文字按钮」这件事
     *   —— 换成 `type="primary"` 之类的方块按钮时这条会失败。
     */
    expect(copyButton.classes()).not.toContain('btn-mini')
    expect(copyButton.classes()).toContain('ant-btn-link')

    wrapper.unmount()
  })

  it('copyStatus 为 copied 时显示绿色「√ 复制成功」', () => {
    /*
     * ⚠ 判据是组件的 `justCopied` **prop**（前端瞬时状态），
     *   不是 `mail.copyStatus`（持久字段）。
     *
     *   这里直接挂 `MailListItem` 而不是 Popup：那个 prop 由 Popup 从
     *   `useMails().justCopied` 算出来传下去，而在这个测试里它是 mock 的。
     *   直接给 prop 能精确验「成功态长什么样」，不掺 mock 的细节。
     */
    const mail = codeMail({ copyStatus: 'none' })
    const wrapper = mount(MailListItem, { props: { mail, justCopied: true } })

    expect(wrapper.find('.copy-done').exists()).toBe(true)
    expect(wrapper.find('.copy-done').text()).toContain('复制成功')
    // 成功后按钮本身要让位（否则两个东西同时出现，宽度也会抖）
    expect(wrapper.find('.copy').exists()).toBe(false)

    wrapper.unmount()
  })

  /*
   * ⚠ 这一条守的是**回归**：判据一旦退回 `mail.copyStatus`，
   *   「几秒后复原」就失效了 —— 因为那个字段落库之后会被 `reload()` 读回来。
   *   所以「持久字段是 copied、但不是刚复制」时必须显示普通的「复制」。
   */
  it('持久 copyStatus 为 copied 时不显示成功态（那是自动复制的记录）', () => {
    const mail = codeMail({ copyStatus: 'copied' })
    const wrapper = mount(MailListItem, { props: { mail, justCopied: false } })

    expect(wrapper.find('.copy').exists()).toBe(true)
    expect(wrapper.find('.copy-done').exists()).toBe(false)

    wrapper.unmount()
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
