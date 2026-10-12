import type { MailAccount } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * 「重置同步位置」与「测试连接」两个按钮的**独立性**。
 *
 * ## 这一组对应一个真机 bug
 *
 * 现象：点「重置同步位置」，转圈的却是**测试连接**按钮，而重置按钮自己毫无反馈
 * （用户不知道点没点到，只能再点一次）。
 *
 * 根因不在按钮上，而在状态：两个操作共用了一个 `testState[accountId]` 槽位，
 * 都往里写 `status: 'busy'`，而模板里的 loading 判据是
 * `testState[id]?.status === 'busy'` —— **它看不出是谁在忙**。
 * 于是「重置在跑」被读成「测试连接在跑」；顺带连状态徽标也只能说「连接中…」，
 * 而那时根本没在连接。
 *
 * 修法：`busyOps`（**哪个**操作在跑）与 `probeState`（最近一次探测的结果）分开，
 * 按钮的 loading 只问自己那一种。
 *
 * ⚠ 断的是「**哪个按钮**在转」——这是用户唯一能看见的东西。
 *   `.ant-btn-loading` 是 antd 给「正在转的按钮」加的那个 class。
 *
 * ⚠ 这里不测网络：`resetCursor` / `test` 都换成可控的 promise，
 *   好让断言落在「操作进行中」那一拍上（而不是等它跑完）。
 */

const DEPS = {
  providers: [
    {
      value: 'imap',
      label: 'IMAP（用户名密码）',
      hint: '',
      availability: 'needs-relay',
      availabilityNote: '浏览器扩展不能直接连接 IMAP，需要本机中继转发。',
      // 与真实 provider（`providers/imap/index.ts`）保持一致
      downloadHint: {
        text: '下载 peon-hall',
        url: 'https://github.com/mail-peon/peon-hall/releases/latest',
      },
      fields: [
        // 与真实 provider（`providers/imap/index.ts`）完全一致 —— 故意包括 6 个字段，
        // 这样单测能看到选预设时 host / port / tls 三字段联动。
        // 缺一个都会让"选预设回填"的断言拿不到对应字段。
        { key: 'host', label: 'IMAP 服务器', type: 'text', required: true, presets: [
          { label: 'QQ 邮箱', value: 'imap.qq.com', port: 993, tls: true, note: '需用授权码，不是登录密码' },
          { label: '网易 163', value: 'imap.163.com', port: 993, tls: true },
          { label: 'Outlook / Hotmail', value: 'outlook.office365.com', port: 993, tls: true },
        ] },
        { key: 'port', label: '端口', type: 'number', default: 993, required: true },
        { key: 'tls', label: '使用 TLS（993 端口必须开）', type: 'toggle', default: true },
        { key: 'user', label: '用户名', type: 'text', placeholder: '你的QQ号@qq.com', required: true },
        { key: 'pass', label: '密码 / 授权码', type: 'password', placeholder: 'QQ 邮箱填 16 位授权码', required: true },
        { key: 'relayUrl', label: 'WebSocket 中继地址', type: 'text', required: true },
      ],
    },
  ],
}

function account(patch: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1',
    label: '个人邮箱',
    email: 'me@example.com',
    provider: 'imap',
    /*
     * ⚠️ `user` / `pass` / `port` 必须给：DEPS 里的 IMAP provider 把它们声明成
     *   `required`，而 `validateAccount()` 会逐个校验 required 字段 —— 缺任何一个
     *   就**在调用 `test()` 之前**返回错误（界面上只显示「请填写『用户名』」）。
     *   这条之前没暴露，是因为 mock 的 provider 只有 host / relayUrl 两个字段。
     */
    config: {
      host: 'imap.qq.com',
      port: 993,
      user: 'me@example.com',
      pass: 'test-auth-code',
      relayUrl: 'ws://127.0.0.1:41316/',
    },
    blockedList: [],
    enabled: true,
    createdAt: Date.now(),
    lastSyncedAt: Date.now() - 3_600_000,
    cursor: { uid: 37744 },
    ...patch,
  }
}

const mocks = vi.hoisted(() => {
  /*
   * `vi.hoisted` 的回调在模块顶层 `const DEPS` **之前**执行 —— 但下面那个箭头
   * 函数体是**调用时**才读 `DEPS` / `providerOverride`，所以没有 TDZ 问题。
   * 这样 `send` 的返回既能用默认 DEPS，又能被单个用例临时替换（见 Gmail 那条）。
   */
  const m = {
    accounts: null as unknown as { value: import('~/logic/types').MailAccount[] },
    /** 临时替换 `send('mail:providers')` 的返回；`null` = 用默认 DEPS */
    providerOverride: null as unknown,
    message: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      open: vi.fn(),
      destroy: vi.fn(),
    },
    reload: vi.fn(async () => {}),
    test: vi.fn(),
    resetCursor: vi.fn(),
    send: vi.fn(async (): Promise<unknown> => m.providerOverride ?? DEPS),
    /**
     * 模拟「剪贴板里有东西」：每个测试按需改 `clipboardText`。
     * 默认 null（没有 navigator.clipboard）。
     */
    clipboardText: null as string | null,
    clipboardError: false as boolean,
  }
  return m
})

/**
 * 模拟 navigator.clipboard.readText()。在 vi.hoisted 之后单独 setup，
 * 让 describe 块能根据 `mocks.clipboardText` / `mocks.clipboardError` 切换返回值。
 */
function installClipboardMock() {
  vi.stubGlobal('navigator', {
    clipboard: {
      readText: async () => {
        if (mocks.clipboardError)
          throw new Error('permission denied')
        return mocks.clipboardText
      },
    },
  })
}

vi.mock('~/logic/bridge', () => ({
  useAccounts: () => ({
    accounts: mocks.accounts,
    reload: mocks.reload,
    save: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    test: mocks.test,
    resetCursor: mocks.resetCursor,
    authorizeGmail: vi.fn(async () => ({ ok: true })),
    syncNow: vi.fn(async () => ({ started: true, startedAt: Date.now() })),
    syncStatus: vi.fn(async () => null),
  }),
  send: mocks.send,
}))

vi.mock('~/logic/ui-message', () => ({
  useAppMessage: () => mocks.message,
  ERROR_DURATION: 8,
  WARNING_DURATION: 6,
}))

let AccountsPage: import('vue').Component
beforeAll(async () => {
  AccountsPage = (await import('~/options/pages/AccountsPage.vue')).default
})

/** 一个手动控制何时完成的操作 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++)
    await Promise.resolve()
}

async function mountPage() {
  const wrapper = mount(AccountsPage)
  await flush()
  return wrapper
}

/** 按文字找一个按钮 —— antd 在两个字的按钮里插了空格，忽略空白匹配。 */
function button(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll('button').find(node => node.text().replace(/\s+/g, '').includes(text))
  if (!found)
    throw new Error(`没找到「${text}」按钮 —— 模板改了？`)
  return found
}

/** 这个按钮在转圈吗 */
function isLoading(wrapper: ReturnType<typeof mount>, text: string) {
  return button(wrapper, text).classes().includes('ant-btn-loading')
}

/** 状态徽标上的状态词 */
function statusLabel(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('.ant-badge-status-text').text()
}

describe('「重置同步位置」不会让「测试连接」转圈', () => {
  beforeEach(() => {
    mocks.accounts = ref([account()])
    mocks.reload.mockClear()
    for (const level of Object.values(mocks.message))
      level.mockClear()
    mocks.test.mockReset()
    mocks.resetCursor.mockReset()
    mocks.clipboardText = null
    mocks.clipboardError = false
    mocks.providerOverride = null
    vi.unstubAllGlobals()
  })

  /*
   * ⚠⚠ 这就是那个 bug 本身：重置在跑的时候，转的必须是**重置**按钮。
   */
  it('重置进行中：只有「重置同步位置」转圈，且状态词是「重置中…」', async () => {
    const d = deferred<{ ok: boolean }>()
    mocks.resetCursor.mockReturnValue(d.promise)

    const wrapper = await mountPage()
    await button(wrapper, '重置同步位置').trigger('click')
    await flush()

    expect(isLoading(wrapper, '重置同步位置')).toBe(true)
    expect(isLoading(wrapper, '测试连接')).toBe(false)

    // 徽标说的也是「重置中…」，而不是「连接中…」（那时没在连接）
    expect(statusLabel(wrapper)).toBe('重置中…')

    d.resolve({ ok: true })
    await flush()
    await wrapper.vm.$nextTick()

    // 收尾：两边都不转，徽标回到账号本身的健康度
    expect(isLoading(wrapper, '重置同步位置')).toBe(false)
    expect(isLoading(wrapper, '测试连接')).toBe(false)
    expect(statusLabel(wrapper)).toBe('已连接')

    wrapper.unmount()
  })

  it('重置成功 → 走全局 message（不再污染连接状态）', async () => {
    mocks.resetCursor.mockResolvedValue({ ok: true })

    const wrapper = await mountPage()
    await button(wrapper, '重置同步位置').trigger('click')
    await flush()

    expect(
      mocks.message.success.mock.calls.map(call => String(call[0])).join('\n'),
    ).toContain('已重置')
    // 一次性操作的回执不该变成卡片上的常驻 tooltip
    expect(statusLabel(wrapper)).toBe('已连接')

    wrapper.unmount()
  })

  it('重置失败 → 红色 message（而不是把卡片改成「连接失败」）', async () => {
    mocks.resetCursor.mockResolvedValue({ ok: false, error: '无法连接中继' })

    const wrapper = await mountPage()
    await button(wrapper, '重置同步位置').trigger('click')
    await flush()

    expect(
      mocks.message.error.mock.calls.map(call => String(call[0])).join('\n'),
    ).toContain('无法连接中继')
    expect(statusLabel(wrapper)).toBe('已连接')

    wrapper.unmount()
  })

  /*
   * ⚠ 测试连接期间重置要禁用：同一个账号上并发两个操作没有意义，
   *   而且结果会互相覆盖（谁后回来谁说了算）。
   */
  it('测试连接进行中：「重置同步位置」被禁用，转圈的是「测试连接」', async () => {
    const d = deferred<{ ok: boolean, detail?: string }>()
    mocks.test.mockReturnValue(d.promise)

    const wrapper = await mountPage()
    await button(wrapper, '测试连接').trigger('click')
    await flush()

    expect(isLoading(wrapper, '测试连接')).toBe(true)
    expect(isLoading(wrapper, '重置同步位置')).toBe(false)
    expect(button(wrapper, '重置同步位置').attributes('disabled')).toBeDefined()

    d.resolve({ ok: true, detail: '收件箱有 128 封邮件' })
    await flush()
    await wrapper.vm.$nextTick()

    expect(isLoading(wrapper, '测试连接')).toBe(false)
    expect(button(wrapper, '重置同步位置').attributes('disabled')).toBeUndefined()
    // 探测成功 → 徽标绿，tooltip 是这次的结果
    expect(statusLabel(wrapper)).toBe('已连接')

    wrapper.unmount()
  })

  /*
   * ⚠ 操作**抛错**（而不是返回 ok:false）时也必须收尾。
   *   没有 finally 的话 busyOps 会永远留着那一项 —— 两个按钮一个永远转、
   *   另一个永远禁用，而界面上没有任何报错可查。
   *
   * ⚠ 而且抛出的错要**报出来**（红 message），不能悄悄吞掉 ——
   *   否则用户点了按钮，界面既没转圈也没提示，等于什么都没发生。
   */
  it('操作抛错也要收尾，并且把错误报出来', async () => {
    mocks.resetCursor.mockRejectedValue(new Error('boom'))

    const wrapper = await mountPage()
    await button(wrapper, '重置同步位置').trigger('click')
    await flush()

    expect(isLoading(wrapper, '重置同步位置')).toBe(false)
    expect(isLoading(wrapper, '测试连接')).toBe(false)
    expect(
      mocks.message.error.mock.calls.map(call => String(call[0])).join('\n'),
    ).toContain('boom')

    wrapper.unmount()
  })
})

/*
 * 「剪贴板里有中继地址」的提示与填入 —— 见 `src/logic/clipboard-relay.ts`。
 *
 * ⚠ 这里是**界面级**断言：banner 渲染、点【填入】写进字段、点【不用】收起 banner。
 *    `clipboard-relay.ts` 自己的纯函数有 10 条单测（`logic/__tests__/clipboard-relay.spec.ts`）。
 */
describe('剪贴板里有中继地址 → 表单顶部提示【填入】', () => {
  beforeEach(() => {
    mocks.accounts = ref([account({
      // 把 relayUrl 留空，否则 banner 不会出现（已经有值就别覆盖）
      config: { host: 'imap.qq.com', relayUrl: '' },
    })])
    mocks.clipboardText = null
    mocks.clipboardError = false
    mocks.providerOverride = null
    vi.unstubAllGlobals()
  })

  /** 找「填入 / 不用」按钮 —— antd 在两个字的按钮里插了空格，trim 之后匹配。 */
  function actionButton(wrapper: ReturnType<typeof mount>, text: string) {
    const found = wrapper.findAll('button').find(node => node.text().replace(/\s+/g, '') === text)
    if (!found)
      throw new Error(`没找到「${text}」按钮 —— 模板改了？`)
    return found
  }

  /** 提示出现：用 alert 里的 URL 作为锚定（抗文字与按钮变化） */
  function promptsVisible(wrapper: ReturnType<typeof mount>): boolean {
    return wrapper.findAll('.ant-alert').some(node => node.text().includes('127.0.0.1:41316'))
  }

  it('剪贴板里有 ws:// 形态的中继地址 + relayUrl为空 → 弹窗里出现「填入」提示', async () => {
    mocks.clipboardText = 'ws://127.0.0.1:41316/'
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    expect(promptsVisible(wrapper)).toBe(true)
    // 顺便验文案
    const alertText = wrapper.findAll('.ant-alert').map(node => node.text()).join('\n')
    expect(alertText).toContain('ws://127.0.0.1:41316/')

    wrapper.unmount()
  })

  it('点【填入】 → 字段被写入 + banner 收起', async () => {
    mocks.clipboardText = 'ws://127.0.0.1:41316/'
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()
    expect(promptsVisible(wrapper)).toBe(true)

    await actionButton(wrapper, '填入').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(promptsVisible(wrapper)).toBe(false)
    // 字段值通过 input 取
    const relayInput = wrapper.findAll('input').find(input => input.element.value?.includes('127.0.0.1:41316'))
    expect(relayInput).toBeDefined()

    wrapper.unmount()
  })

  it('点【不用】 → banner 收起但字段不变', async () => {
    mocks.clipboardText = 'ws://127.0.0.1:41316/'
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()
    expect(promptsVisible(wrapper)).toBe(true)

    await actionButton(wrapper, '不用').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(promptsVisible(wrapper)).toBe(false)
    // 字段值还是空（没点填入）
    const relayInput = wrapper.findAll('input').find(input => input.element.value?.includes('127.0.0.1:41316'))
    expect(relayInput).toBeUndefined()

    wrapper.unmount()
  })

  it('剪贴板里不是 ws/wss → 不出现', async () => {
    mocks.clipboardText = 'hello world'
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    expect(promptsVisible(wrapper)).toBe(false)

    wrapper.unmount()
  })

  it('剪贴板为空 → 不出现', async () => {
    mocks.clipboardText = ''
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    expect(promptsVisible(wrapper)).toBe(false)

    wrapper.unmount()
  })

  it('剪贴板 API 抛错（permission denied）→ 静默退化、不抛到界面上', async () => {
    mocks.clipboardError = true
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    expect(promptsVisible(wrapper)).toBe(false)
    // 没有全局 error message —— 退化是设计行为
    const errorMsgs = mocks.message.error.mock.calls.map(call => String(call[0]))
    expect(errorMsgs.some(m => m.includes('clipboard'))).toBe(false)

    wrapper.unmount()
  })

  it('已有 relayUrl → 即使剪贴板有也不再出现（不覆盖用户填过的值）', async () => {
    mocks.accounts = ref([account({
      // 已有值
      config: { host: 'imap.qq.com', relayUrl: 'ws://127.0.0.1:41316/' },
    })])
    mocks.clipboardText = 'ws://127.0.0.1:9999/' // 用户故意填另一个
    installClipboardMock()

    const wrapper = await mountPage()
    await button(wrapper, '编辑').trigger('click')
    await flush()

    expect(promptsVisible(wrapper)).toBe(false)

    wrapper.unmount()
  })
})

/*
 * 「需要装 peon-hall」时的那条下载链接 —— 见 `providers/imap/index.ts` 的
 * `downloadHint` 与 `AccountsPage.vue` 里把它渲染成 `<a>` 的那段模板。
 *
 * ⚠️ 断的是「**可点**」：antd 的 `a-alert` 把 `:message` 当纯文本，链接塞在里面
 *   点不开 —— 所以 downloadHint 走独立的 `<a>`，这里验证它真的渲染成了 `<a>`。
 */
describe('imap provider 的 peon-hall 下载链接', () => {
  beforeEach(() => {
    mocks.accounts = ref([])
    mocks.clipboardText = null
    mocks.clipboardError = false
    mocks.providerOverride = null
    vi.unstubAllGlobals()
  })

  it('黄条里渲染出可点的「下载 peon-hall」链接', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const link = wrapper.findAll('a').find(node => node.text().includes('下载 peon-hall'))
    expect(link).toBeDefined()
    expect(link!.attributes('href')).toBe('https://github.com/mail-peon/peon-hall/releases/latest')

    wrapper.unmount()
  })

  it('下载链接在新标签页打开，且不发 Referer（noopener noreferrer）', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const link = wrapper.findAll('a').find(node => node.text().includes('下载 peon-hall'))
    expect(link!.attributes('target')).toBe('_blank')
    const rel = link!.attributes('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')

    wrapper.unmount()
  })

  it('黄条正文只有「为什么需要中继」，不再堆 pnpm relay / 安全细节', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const alertText = wrapper.findAll('.ant-alert').map(node => node.text()).join('\n')
    expect(alertText).toContain('浏览器扩展不能直接连接 IMAP')
    // 这几样都不该再出现在界面上（历史遗留文案）
    expect(alertText).not.toContain('pnpm relay')
    expect(alertText).not.toContain('邮箱密码')
    expect(alertText).not.toContain('TLS 握手')
    expect(alertText).not.toContain('通用协议')

    wrapper.unmount()
  })

  it('gmail 没有 downloadHint → 不渲染下载链接', async () => {
    // 把 provider 换成 gmail（`availability: 'ready'` → 连黄条都不该有）
    mocks.providerOverride = {
      providers: [
        {
          value: 'gmail',
          label: 'Gmail',
          hint: '推荐。浏览器原生支持，不需要中继',
          availability: 'ready',
          fields: [{ key: 'clientId', label: 'Client ID', type: 'text', required: true }],
        },
      ],
    }

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const link = wrapper.findAll('a').find(node => node.text().includes('下载 peon-hall'))
    expect(link).toBeUndefined()
    // availability === 'ready' → 黄条不出现
    expect(wrapper.findAll('.ant-alert').some(node => node.text().includes('中继'))).toBe(false)

    wrapper.unmount()
  })
})

/*
 * IMAP 预设下拉 —— 见 `providers/imap/index.ts` 的 `presets` 字段。
 *
 * ⚠️ 断的是「**选预设时一并回填 host / port / tls**」三件事：
 *   - 只填 host 是常见 bug（用户改了 host，端口和加密没动 → 「测试连接」报
 *     "中继不可达" 让人困惑）；
 *   - 测这一条比测"下拉是否渲染"更有意义 —— 下拉渲染了不证明联动对，
 *     联动错了用户照样填不出能用的账号。
 *
 * ⚠️ 测试读字段值走 DOM（`input.element.value` / `switcher[aria-checked]`），
 *   不走组件内部的 `fieldValue`/`fieldNumber`/`fieldBool` —— 后者在 setup 里，
 *   测试模块拿不到。这样也更接近用户视角。
 */
describe('iMAP host 预设下拉', () => {
  beforeEach(() => {
    mocks.accounts = ref([])
    mocks.clipboardText = null
    mocks.clipboardError = false
    mocks.providerOverride = null
    vi.unstubAllGlobals()
  })

  /**
   * 读「当前正在编辑的账号」的 config（组件里的 `editing` ref）。
   *
   * ⚠️ 为什么不从 DOM 读：`a-auto-complete` / `a-input-number` / `a-switch` 各自
   *   包了好几层 div，按 label 反查 input 又依赖 antd 内部 class 名 ——
   *   换个 antd 小版本就可能红，而红的理由跟被测行为无关。
   *   `editing` 在 `<script setup>` 里是顶层绑定，dev 模式下 `wrapper.vm` 直接可达。
   */
  function editingConfig(wrapper: ReturnType<typeof mount>): Record<string, unknown> {
    const vm = wrapper.vm as unknown as { editing?: { config: Record<string, unknown> } }
    return vm.editing?.config ?? {}
  }

  /**
   * 取 host 字段那个下拉。
   *
   * ⚠️ 不能直接 `wrapper.findComponent({ name: 'ASelect' })` —— 表单里「协议」
   *   也是 `a-select`，那样拿到的是第一个（协议），emit 出来的 change 走的是
   *   `onProviderChange`，被测的东西整个跑偏。限定在 `.host-field` 里找才唯一。
   */
  function hostSelect(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('.host-field').findComponent({ name: 'ASelect' })
  }

  it('选中「QQ 邮箱」预设 → host / port / tls 三字段一并回填', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    expect(select.exists()).toBe(true)

    // 模拟用户在下拉里挑中 QQ 邮箱
    select.vm.$emit('change', 'imap.qq.com')
    await flush()

    // 三个字段**一并**回填 —— 只填 host 是常见 bug
    expect(editingConfig(wrapper).host).toBe('imap.qq.com')
    expect(editingConfig(wrapper).port).toBe(993)
    expect(editingConfig(wrapper).tls).toBe(true)

    wrapper.unmount()
  })

  it('下拉最后一条是「自定义…」—— 选了才出现输入框', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    const options = select.props('options') as Array<{ value: string, label: string }>

    // 预设在前、「自定义…」在最后
    expect(options.at(-1)).toEqual({ value: '__custom__', label: '自定义…' })
    expect(options.length).toBeGreaterThan(1)

    // 下拉里**不含** note —— 见 hostSelectOptions 的说明（antd 会把额外字段铺到 DOM）
    for (const option of options)
      expect(Object.keys(option).sort()).toEqual(['label', 'value'])

    // 还没选「自定义」时，输入框不出现
    expect(wrapper.find('.host-field input[placeholder="mail.example.com"]').exists()).toBe(false)

    // 选了「自定义…」→ 出现输入框，且 host 被清空等用户填
    select.vm.$emit('change', '__custom__')
    await flush()
    expect(wrapper.find('.host-field input[placeholder="mail.example.com"]').exists()).toBe(true)
    expect(editingConfig(wrapper).host).toBe('')

    wrapper.unmount()
  })

  it('「自定义」输入框里填的值会写进 host —— 且不动 port / tls', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    select.vm.$emit('change', '__custom__')
    await flush()

    const input = wrapper.find('.host-field input[placeholder="mail.example.com"]')
    await input.setValue('mail.corporate.internal')
    await flush()

    expect(editingConfig(wrapper).host).toBe('mail.corporate.internal')
    // port / tls 保持默认，不被自定义输入改写
    expect(editingConfig(wrapper).port).toBe(993)
    expect(editingConfig(wrapper).tls).toBe(true)

    wrapper.unmount()
  })

  it('从「自定义」切回预设 → 输入框收起，host / port / tls 被预设覆盖', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    select.vm.$emit('change', '__custom__')
    await flush()
    await wrapper.find('.host-field input[placeholder="mail.example.com"]').setValue('mail.corporate.internal')
    await flush()

    select.vm.$emit('change', 'imap.163.com')
    await flush()

    expect(wrapper.find('.host-field input[placeholder="mail.example.com"]').exists()).toBe(false)
    expect(editingConfig(wrapper).host).toBe('imap.163.com')
    expect(editingConfig(wrapper).port).toBe(993)
    expect(editingConfig(wrapper).tls).toBe(true)

    wrapper.unmount()
  })

  it('打开一个 host 不在预设里的账号 → 下拉显示「自定义…」并亮出输入框', async () => {
    // 这是回显的关键：数据上 host 只是个字符串，「是预设还是自己填的」推不出来，
    // 靠 syncCustomHostFields 反查。查错的话用户会以为自己的配置丢了。
    mocks.accounts = ref([account({ config: {
      host: 'mail.corporate.internal',
      port: 993,
      user: 'me@example.com',
      pass: 'x',
      relayUrl: 'ws://127.0.0.1:41316/',
    } })])

    const wrapper = await mountPage()
    await button(wrapper, '编辑').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    expect(select.props('value')).toBe('__custom__')
    // 输入框出现，且带着已保存的值
    const input = wrapper.find('.host-field input[placeholder="mail.example.com"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('mail.corporate.internal')

    wrapper.unmount()
  })

  it('打开一个 host 命中预设的账号 → 下拉回显那一条，输入框不出现', async () => {
    // 默认 account() 的 host 就是 imap.qq.com，正好在预设里
    mocks.accounts = ref([account()])

    const wrapper = await mountPage()
    await button(wrapper, '编辑').trigger('click')
    await flush()

    const select = hostSelect(wrapper)
    expect(select.props('value')).toBe('imap.qq.com')
    expect(wrapper.find('.host-field input[placeholder="mail.example.com"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('预设没带 port / tls → 沿用表单当前值（不强写）', async () => {
    // 这条 preset 只有 host + tls，**没有 port** —— 验证「字段缺失 = 不动」
    mocks.providerOverride = {
      providers: [{
        ...DEPS.providers[0],
        fields: [
          {
            key: 'host',
            label: 'IMAP 服务器',
            type: 'text',
            required: true,
            presets: [{ label: '只有 TLS 的主机', value: 'mail.example.com', tls: true }],
          },
          { key: 'port', label: '端口', type: 'number', default: 993 },
          { key: 'tls', label: '使用 TLS', type: 'toggle', default: true },
          { key: 'relayUrl', label: 'WebSocket 中继地址', type: 'text', required: true },
        ],
      }],
    }

    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    hostSelect(wrapper).vm.$emit('change', 'mail.example.com')
    await flush()

    expect(editingConfig(wrapper).host).toBe('mail.example.com')
    expect(editingConfig(wrapper).tls).toBe(true)
    // port 没被动过 —— 仍是新建账号时的默认值 993
    expect(editingConfig(wrapper).port).toBe(993)

    wrapper.unmount()
  })

  it('下拉列出预设清单，且每条带 value（host）—— 用户能挑', async () => {
    const wrapper = await mountPage()
    await button(wrapper, '新增账号').trigger('click')
    await flush()

    const options = hostSelect(wrapper).props('options') as Array<{ value: string, label: string }>
    const values = options.map(o => o.value)

    // 至少覆盖用户点名的 QQ / 网易
    expect(values).toContain('imap.qq.com')
    expect(values).toContain('imap.163.com')

    // 每条都得有 value（写进 host 的）与 label（显示的）
    for (const option of options) {
      expect(option.value).toBeTruthy()
      expect(option.label).toBeTruthy()
    }

    // 避坑提示确实渲染在选项里（QQ 那条带「授权码」）
    const qq = options.find(o => o.value === 'imap.qq.com')
    expect(qq).toBeDefined()
    // note 不进 options（避免漏成 DOM 属性），由 presetNote 按 value 反查
    expect('note' in qq!).toBe(false)

    wrapper.unmount()
  })
})
