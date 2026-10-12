import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * 不可撤销的操作**失败时必须说出来**。
 *
 * ## 这一组对应一个「界面在撒谎」的缺陷
 *
 * `onClearMails` / `onClearAll` 以前是这样写的：
 *
 * ```ts
 * await send('settings:clear-mails', undefined, { ok: false })
 * uiMessage.success('已清空邮件列表')          // ← 不看返回值
 * ```
 *
 * 而 `send` 在消息失败 / 超时时**不抛错**，它返回第三个参数那个**兜底值**
 * （见 `logic/bridge.ts`）—— 于是「一封都没删掉」和「已清空」在界面上
 * 长得一模一样。这在一个**不可撤销**、而且隐私声明里写着「凭据存在本机」
 * 的场景里，是最不该出错的那种错。
 *
 * ## 测试策略
 *
 * 把 `~/logic/bridge` 与 `~/logic/ui-message` 都 mock 掉，只断言
 * 「哪个级别收到了哪句文案」—— 于是「失败不能走 success」变成可测的。
 */

const mocks = vi.hoisted(() => {
  const message = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    open: vi.fn(),
    destroy: vi.fn(),
  }

  return {
    message,
    /** `settings:clear-mails` / `settings:clear-all` 的返回值，逐个用例改 */
    send: vi.fn(async () => ({ ok: true })),
    setApp: vi.fn(async () => {}),
  }
})

vi.mock('~/logic/ui-message', () => ({
  useAppMessage: () => mocks.message,
  ERROR_DURATION: 8,
  WARNING_DURATION: 6,
}))

vi.mock('~/logic/bridge', () => ({
  onSyncDone: () => () => {},
  onDataChanged: () => () => {},
  send: mocks.send,
  useAccounts: () => ({
    accounts: ref([]),
    syncNow: vi.fn(async () => ({ started: true })),
    syncStatus: vi.fn(async () => null),
    reload: vi.fn(async () => {}),
  }),
  useSettings: () => ({
    app: ref({ minimalMode: false, mailRetention: 100, autoDeleteExpiredCode: true }),
    ai: ref({ apiKey: 'k', platform: 'openai' }),
    setApp: mocks.setApp,
    reload: vi.fn(async () => {}),
  }),
}))

let GeneralPage: import('vue').Component
beforeAll(async () => {
  GeneralPage = (await import('~/options/pages/GeneralPage.vue')).default
})

function mountPage() {
  return mount(GeneralPage, { attachTo: document.body })
}

/** 按可见文字找按钮（antd 会给两个汉字的按钮插空格，所以去空白） */
function button(wrapper: ReturnType<typeof mountPage>, text: string) {
  const found = wrapper.findAll('button').find(node => node.text().replace(/\s+/g, '').includes(text))
  if (!found)
    throw new Error(`没找到「${text}」按钮 —— 模板改了？`)
  return found
}

/** 走完「点按钮 → 确认弹窗 → 点确认」 */
async function runConfirmed(wrapper: ReturnType<typeof mountPage>, label: string) {
  await button(wrapper, label).trigger('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()

  const dialog = wrapper.find('.dialog')
  if (!dialog.exists())
    throw new Error('确认弹窗没出现 —— `ConfirmDialog` 的交互改了？')
  await dialog.find('button.ant-btn-primary').trigger('click')
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 某个级别收到过的全部文案 */
function messageText(level: { mock: { calls: unknown[][] } }): string {
  return level.mock.calls.map(call => String(call[0])).join('\n')
}

beforeEach(() => {
  for (const level of Object.values(mocks.message))
    level.mockClear()
  mocks.send.mockClear()
  mocks.send.mockResolvedValue({ ok: true })
})

describe('清空操作的失败必须说出来', () => {
  it('清空邮件列表成功 → 走 success', async () => {
    const wrapper = mountPage()
    await runConfirmed(wrapper, '清空邮件列表')

    expect(messageText(mocks.message.success)).toContain('已清空邮件列表')
    expect(messageText(mocks.message.error)).toBe('')

    wrapper.unmount()
  })

  it('清空邮件列表失败（send 给兜底值）→ 走 error，绝不能走 success', async () => {
    // `send` 的兜底值就是 `{ ok: false }` —— 这正是「消息失败」在调用方看到的样子
    mocks.send.mockResolvedValue({ ok: false })

    const wrapper = mountPage()
    await runConfirmed(wrapper, '清空邮件列表')

    expect(messageText(mocks.message.error)).toContain('清空邮件列表失败')
    // ⚠ 这一条才是关键：不能报成功
    expect(messageText(mocks.message.success)).toBe('')

    wrapper.unmount()
  })

  it('清空所有数据成功 → 走 success', async () => {
    const wrapper = mountPage()
    await runConfirmed(wrapper, '清空所有数据')

    expect(messageText(mocks.message.success)).toContain('已清空所有数据')
    expect(messageText(mocks.message.error)).toBe('')

    wrapper.unmount()
  })

  it('清空所有数据失败 → 走 error，绝不能走 success', async () => {
    mocks.send.mockResolvedValue({ ok: false })

    const wrapper = mountPage()
    await runConfirmed(wrapper, '清空所有数据')

    expect(messageText(mocks.message.error)).toContain('清空所有数据失败')
    expect(messageText(mocks.message.success)).toBe('')

    wrapper.unmount()
  })
})
