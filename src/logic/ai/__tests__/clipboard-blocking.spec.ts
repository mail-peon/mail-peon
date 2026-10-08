import type { Notifier } from '~/logic/notification/types'
import type { Mail, MailAccount } from '~/logic/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMailPipeline } from '~/logic/ai/pipeline'

/**
 * 「剪贴板挂住会让邮件永远不入库」的回归测试。
 *
 * ## 真机故障
 *
 * background 日志停在 `提取到验证码：… → 34949`，**既没有「已入库」也没有任何报错**，
 * 界面上新邮件就是不出现。
 *
 * 根因：`processMinimal` 里的调用链是
 *
 * ```ts
 * const copied = await notifier.copyToClipboard(code)   // ← 挂在这里
 * await upsertMail(minimalMail, MINIMAL_RETENTION)      // ← 永远走不到
 * ```
 *
 * 而 `copyToClipboard` 的第二级降级（交给 content script 写）会
 * `sendMessage(…, { context: 'content-script', tabId })`。用户当时开着的
 * **设置页**是 `chrome-extension://` 页面，content script **不会注入它** ——
 * 于是那个 promise **永不 resolve**，整个处理流程挂死。
 *
 * ## 这一组守什么
 *
 * **剪贴板是锦上添花，绝不该阻塞入库。** 所以哪怕复制永远不返回，
 * 邮件也必须被写进库，且 `copyStatus` 记成失败（UI 给「点击复制」按钮兜底）。
 */

const mocks = vi.hoisted(() => ({
  /*
   * ⚠ 这个 mock 的签名要**显式声明参数**（`vi.fn(async (_mail: Mail) => {})`），
   *   不能写成 `vi.fn(async () => {})`。
   *
   *   后者会让 TS 把 `mock.calls` 推成 `[][]`（零参数元组），
   *   于是 `mock.calls[0][0]` 报「Tuple type '[]' of length '0' has no element at index '0'」
   *   —— 那个错误看起来像「测试写错了」，其实只是 mock 类型没描述真实调用形状。
   */
  upsertMail: vi.fn(async (_mail: Mail, _retention?: unknown) => {}),
  readAiSettings: vi.fn(async () => ({ apiKey: 'k', platform: 'openai', model: 'm' })),
  extractCodeOnly: vi.fn(async (_mail: Mail, _settings: unknown, _options?: unknown) => ({ code: '34949', validForSeconds: 300 })),
  copyToClipboard: vi.fn(async (_code: string) => true),
  showToast: vi.fn(async (_payload: unknown) => {}),
  notifyMailUpdated: vi.fn((_mailId: string) => {}),
}))

vi.mock('~/logic/store/mails', () => ({
  upsertMail: mocks.upsertMail,
  MINIMAL_RETENTION: 50,
}))

vi.mock('~/logic/store/settings', () => ({
  readAiSettings: mocks.readAiSettings,
  /*
   * ⚠ `process()` 第一步就读 `readAppSettings()` 来决定走极简还是完整分支
   *   （见 `pipeline.ts` 的 `process`）。不桩它的话，它返回 `undefined`，
   *   报错是 `Cannot read properties of undefined (reading 'minimalMode')` ——
   *   那个错误指向 `minimalMode`，看不出真正原因是「settings 没被桩住」。
   */
  readAppSettings: vi.fn(async () => ({ minimalMode: true, blockedEnabled: false })),
  patchAiSettings: vi.fn(),
  patchAppSettings: vi.fn(),
}))

vi.mock('~/logic/ai/summarize', () => ({
  extractCodeOnly: mocks.extractCodeOnly,
  summarize: vi.fn(),
  testAiConnection: vi.fn(),
}))

function mail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'a1:m1',
    accountId: 'a1',
    from: [{ name: '发件人', address: 'from@example.com' }],
    to: [],
    // 含「验证码」，让极简模式的预筛放行
    subject: '测试验证码',
    snippet: '您的验证码是 34949',
    bodyText: '您的账户安全验证码是: 34949\n\n此验证码将在 5 分钟内有效。',
    receivedAt: Date.now(),
    processing: 'pending',
    copyStatus: 'none',
    read: false,
    ...patch,
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

/** 只实现被测路径用到的那些方法 */
function notifier(overrides: Partial<Notifier> = {}): Notifier {
  return {
    updateBadge: vi.fn(async () => {}),
    showToast: mocks.showToast,
    copyToClipboard: mocks.copyToClipboard,
    notifyMailUpdated: mocks.notifyMailUpdated,
    ...overrides,
  } as unknown as Notifier
}

describe('剪贴板不阻塞入库', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.extractCodeOnly.mockResolvedValue({ code: '34949', validForSeconds: 300 })
    mocks.copyToClipboard.mockResolvedValue(true)
    mocks.upsertMail.mockResolvedValue(undefined)
  })

  it('正常路径：复制成功 → 入库 → copyStatus = copied', async () => {
    const pipeline = createMailPipeline({ notifier: notifier() })
    const outcome = await pipeline.process(mail(), account())

    expect(outcome).toBe('saved')
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)

    const stored = mocks.upsertMail.mock.calls[0][0] as unknown as Mail
    expect(stored.code).toBe('34949')
    expect(stored.codeExpiresAt).toBeTypeOf('number')
    expect(stored.copyStatus).toBe('copied')
  })

  /*
   * ⚠ 核心断言：复制**永远不返回**时，入库仍必须发生。
   */
  it('复制永不返回时仍然入库（copyStatus = failed）', async () => {
    // 一个永不 settle 的 promise —— 精确复刻真机上那个挂死的 sendMessage
    mocks.copyToClipboard.mockImplementation(() => new Promise<boolean>(() => {}))

    const pipeline = createMailPipeline({ notifier: notifier() })

    /*
     * ⚠ 这里**不能**直接 `await pipeline.process(...)` —— 那会永远挂住测试。
     *
     *   修复前它确实会挂住；修复后 `copyToClipboard` 自己带超时，
     *   所以这个 await 会在 2.5 秒内返回。
     *   外面再套一层「最多 5 秒」的保险：万一将来有人把超时删了，
     *   这条测试会**失败**（而不是把整个测试进程挂死）—— 失败的测试有用，
     *   挂死的测试只会让人以为 CI 卡了。
     */
    const result = await Promise.race([
      pipeline.process(mail(), account()),
      new Promise<'timeout'>(resolve => setTimeout(resolve, 5000, 'timeout')),
    ])

    expect(result).not.toBe('timeout')
    expect(result).toBe('saved')

    // 入库照常发生 —— 这是本测试的全部意义
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)
    const stored = mocks.upsertMail.mock.calls[0][0] as unknown as Mail
    expect(stored.copyStatus).toBe('failed')
    expect(stored.code).toBe('34949')
  }, 10000)

  it('复制抛错时也入库（复制失败不该导致收不到验证码）', async () => {
    mocks.copyToClipboard.mockRejectedValue(new Error('剪贴板被拒绝'))

    const pipeline = createMailPipeline({ notifier: notifier() })
    const outcome = await pipeline.process(mail(), account())

    /*
     * ⚠ 修之前这里会**抛出**，一路冒到 `mailbox.ts` 的 catch ——
     *   那一封被记成 `failed` 且**不入库**。
     *   也就是说「剪贴板被拒绝」会让用户收不到验证码，而这两件事本该无关。
     *   现在复制失败只影响 `copyStatus`，邮件照常入库。
     */
    expect(outcome).toBe('saved')
    expect(mocks.upsertMail).toHaveBeenCalledTimes(1)

    const stored = mocks.upsertMail.mock.calls[0]?.[0] as unknown as Mail
    expect(stored.copyStatus).toBe('failed')
    expect(stored.code).toBe('34949')
  })
})
