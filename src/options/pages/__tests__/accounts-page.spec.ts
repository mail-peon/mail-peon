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
      availabilityNote: '',
      fields: [
        { key: 'host', label: 'IMAP 服务器', type: 'text', required: true },
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
    config: { host: 'imap.qq.com', relayUrl: 'ws://127.0.0.1:8787/' },
    blockedList: [],
    enabled: true,
    createdAt: Date.now(),
    lastSyncedAt: Date.now() - 3_600_000,
    cursor: { uid: 37744 },
    ...patch,
  }
}

const mocks = vi.hoisted(() => ({
  accounts: null as unknown as { value: import('~/logic/types').MailAccount[] },
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
  send: vi.fn(async () => DEPS),
}))

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

/** 按文字找一个按钮 */
function button(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll('button').find(node => node.text().includes(text))
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
