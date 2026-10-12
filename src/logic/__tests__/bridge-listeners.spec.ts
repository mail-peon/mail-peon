import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `installBridgeListener()` 必须把**每一条**广播通道都注册上。
 *
 * ## 这一组守的是一个「发送端有、接收端没有」的缺陷类别
 *
 * `mail:focus` 曾经就是这样：内容脚本点击 toast 时老老实实
 * `sendToBackground('mail:focus', …)`，`shim.d.ts` 里也登记着，
 * 注释还写着「让已经打开的 Popup 滚过去」—— 但 `installBridgeListener()`
 * 里**没有这一条**，全项目没有一个 `onMessage('mail:focus')`。
 * 于是那半句承诺从来没兑现过，而且完全无声：
 * 没有报错、没有类型问题（`shim.d.ts` 只登记通道存在，不保证有人听）。
 *
 * `webext-bridge` 的失败本来就是静默的（拼错消息名 → 谁都不响应 →
 * 调用方永远等下去），所以「注册了哪些通道」这件事值得直接断言。
 */

const mocks = vi.hoisted(() => {
  /** `onMessage` 被注册过的通道名 */
  const registered: string[] = []
  return {
    registered,
    onMessage: vi.fn((channel: string) => {
      registered.push(channel)
    }),
    sendMessage: vi.fn(async () => undefined),
  }
})

vi.mock('webext-bridge/popup', () => ({
  onMessage: mocks.onMessage,
  sendMessage: mocks.sendMessage,
}))

vi.mock('~/logic/copy-feedback', () => ({
  useCopyFeedback: () => ({ justCopied: { value: new Set<string>() }, markCopied: vi.fn() }),
}))

beforeEach(() => {
  vi.resetModules()
  mocks.registered.length = 0
  mocks.onMessage.mockClear()
})

describe('bridge 的广播监听注册', () => {
  it('注册了 mail:focus —— 否则点 toast 定位邮件是空的', async () => {
    const { onMailFocus } = await import('~/logic/bridge')

    onMailFocus(() => {})

    expect(mocks.registered).toContain('mail:focus')
  })

  it('四条广播通道一条都不能少（mail:updated / data:changed / settings:changed / sync:done）', async () => {
    const { onMailFocus } = await import('~/logic/bridge')

    // 任意一个订阅入口都会触发 `installBridgeListener()`，用其中最简单的一个
    onMailFocus(() => {})

    expect(mocks.registered).toEqual(
      expect.arrayContaining(['mail:updated', 'data:changed', 'settings:changed', 'sync:done']),
    )
  })

  it('只装一次 —— 重复订阅不会把同一条通道注册多遍', async () => {
    const { onMailFocus } = await import('~/logic/bridge')

    onMailFocus(() => {})
    onMailFocus(() => {})
    onMailFocus(() => {})

    expect(mocks.registered.filter(channel => channel === 'mail:focus')).toHaveLength(1)
  })
})
