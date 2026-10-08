import type { Notifier } from '~/logic/notification/types'

import type { Mail, MailAccount } from '~/logic/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMailPipeline } from '~/logic/ai/pipeline'

/**
 * 「辅助动作不该阻塞 / 拖垮主流程」的回归测试 —— **toast 投递**这一侧。
 *
 * ## 真机故障
 *
 * background 控制台反复出现：
 *
 * ```
 * Error in event handler: TypeError: Cannot read properties of undefined (reading 'fingerprint')
 * ```
 *
 * 根因是 `toActiveTab`（toast 投递）向一个**没有注册端点**的目标发消息。
 * `webext-bridge` 的 background 侧**无条件**读 `connMap.get(dest).fingerprint`
 * （`dist/background.js` 的 `deliver()`），目标不存在时那是 `undefined`。
 *
 * 两个放大伤害的因素：
 *
 *   1. **它抛在异步回调里**（等 `oncePortConnected`），所以异常逃出
 *      `sendMessage` 的 try/catch，被 Chrome 报成「Error in event handler」——
 *      看起来像 background 崩了；
 *   2. 触发场景极其常见：用户开着**设置页 / Popup**，而它们**没有 content script**。
 *
 * 而 `showToast` 是在 `pipeline.process()` 里被 `await` 的 ——
 * 一次投递失败就足以打断整封邮件的处理。
 *
 * ## 这一组守什么
 *
 * **投 toast 失败不该影响邮件入库。** 邮件已经写进库了，toast 只是锦上添花。
 */

const mocks = vi.hoisted(() => ({
  upsertMail: vi.fn(async (_mail: unknown, _retention?: unknown) => {}),
  extractCodeOnly: vi.fn(async (_mail: unknown, _settings: unknown, _options?: unknown) => ({ code: '34949', validForSeconds: 300 })),
  copyToClipboard: vi.fn(async (_code: string) => true),
  showToast: vi.fn(async (_payload: unknown) => {}),
  notifyMailUpdated: vi.fn((_mailId: string) => {}),
}))

vi.mock('~/logic/store/mails', () => ({
  upsertMail: mocks.upsertMail,
  MINIMAL_RETENTION: 50,
}))

vi.mock('~/logic/store/settings', () => ({
  readAiSettings: vi.fn(async () => ({ apiKey: 'k', platform: 'openai', model: 'm' })),
  readAppSettings: vi.fn(async () => ({ minimalMode: true, blockedEnabled: false })),
  patchAiSettings: vi.fn(),
  patchAppSettings: vi.fn(),
}))

vi.mock('~/logic/ai/summarize', () => ({
  extractCodeOnly: mocks.extractCodeOnly,
  summarize: vi.fn(),
  testAiConnection: vi.fn(),
}))

function mail(): Mail {
  return {
    id: 'a1:m1',
    accountId: 'a1',
    from: [{ name: '发件人', address: 'from@example.com' }],
    to: [],
    subject: '测试邮件',
    snippet: '您的验证码是 34949',
    bodyText: '您的账户安全验证码是: 34949',
    receivedAt: Date.now(),
    processing: 'pending',
    copyStatus: 'none',
    read: false,
  }
}

function account(): MailAccount {
  return {
    id: 'a1',
    label: '测试邮箱',
    email: 'me@example.com',
    provider: 'imap',
    config: {},
    blockedList: [],
    enabled: true,
    createdAt: 1,
    cursor: null,
  }
}

function notifier(overrides: Partial<Notifier> = {}): Notifier {
  return {
    updateBadge: vi.fn(async () => {}),
    showToast: mocks.showToast,
    copyToClipboard: mocks.copyToClipboard,
    notifyMailUpdated: mocks.notifyMailUpdated,
    ...overrides,
  } as unknown as Notifier
}

describe('toast 投递失败不阻塞入库', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.extractCodeOnly.mockResolvedValue({ code: '34949', validForSeconds: 300 })
    mocks.copyToClipboard.mockResolvedValue(true)
    mocks.upsertMail.mockResolvedValue(undefined)
    mocks.showToast.mockResolvedValue(undefined)
  })

  it('正常路径：入库 → toast → 通知界面', async () => {
    const pipeline = createMailPipeline({ notifier: notifier() })
    const outcome = await pipeline.process(mail(), account())

    expect(outcome).toBe('saved')
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.notifyMailUpdated).toHaveBeenCalledTimes(1)
  })

  /*
   * ⚠ 核心断言：toast 抛错时邮件仍必须入库。
   *
   *   这一条守的是「辅助动作不得拖垮主流程」。
   *   修之前它会把异常冒到 `mailbox.ts` 的 catch，那一封被记成 failed 且**不入库** ——
   *   也就是说「投 toast 失败」会导致用户**收不到验证码**，而这两件事本该无关。
   */
  it('toast 抛错时仍然入库', async () => {
    mocks.showToast.mockRejectedValue(new Error('Cannot read properties of undefined'))

    const pipeline = createMailPipeline({ notifier: notifier() })
    const outcome = await pipeline.process(mail(), account())

    expect(outcome).toBe('saved')
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)

    const stored = mocks.upsertMail.mock.calls[0]?.[0] as unknown as Mail
    expect(stored.code).toBe('34949')
  })

  it('toast 永不返回时仍然入库（投递挂住不该挂住整个流程）', async () => {
    mocks.showToast.mockImplementation(() => new Promise<void>(() => {}))

    const pipeline = createMailPipeline({ notifier: notifier() })

    /*
     * ⚠ 套一层外层超时：修复前这里会**永远挂住**。
     *   外面的保险让「超时」表现为**测试失败**而不是把测试进程挂死 ——
     *   失败的测试有用，挂死的测试只会让人以为 CI 卡了。
     */
    const outcome = await Promise.race([
      pipeline.process(mail(), account()),
      new Promise<'timeout'>(resolve => setTimeout(resolve, 5000, 'timeout')),
    ])

    expect(outcome).toBe('saved')
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)
  }, 10000)
})
