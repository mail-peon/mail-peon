import type { MailConnection, MailProvider, RawMail, SyncCursor } from '~/adapters/mail/types'
import type { MailOutcome, MailPipeline } from '~/logic/ai/pipeline'
import type { Mail, MailAccount } from '~/logic/types'
import { describe, expect, it, vi } from 'vitest'
import { syncWithProvider } from '~/adapters/mail/mailbox'
import { readAccount, upsertAccount } from '~/logic/store/accounts'
import { countMails, readMailsByAccount, upsertMail } from '~/logic/store/mails'

/**
 * 邮箱同步编排的集成测试（`03-roadmap.md` M1 验收的前四条）。
 *
 * 用一个**假 provider** + 假 pipeline 把整条同步链路跑起来，于是这些
 * **正确性契约**能被断言：
 *
 *   - 首次同步**只记游标、一封都不拉**（设计文档 Q5 的硬约束）；
 *   - 后续同步按游标拉增量并推进游标；
 *   - 排除邮箱在解析之后、pipeline 之前过滤（只对完整模式生效）；
 *   - 失败时**不动游标**（保增量不丢件）；
 *   - UIDVALIDITY 变化 → 清零游标 + 警告用户，且**不试图恢复**。
 *
 * 这些在真机上要靠配置真邮箱、构造特定邮件才能验证，而它们的失效方式全是
 * 「静默丢邮件」——最不该靠手测的一类。
 */

/** 造一封最小可解析的 RFC822（只有头 + 纯文本正文，`postal-mime` 能吃下） */
function rawMail(options: { from?: string, subject?: string, body?: string, date?: string } = {}): RawMail {
  const from = options.from ?? 'noreply@github.com'
  const subject = options.subject ?? 'Hello'
  const body = options.body ?? 'A normal email body.'
  const date = options.date ?? 'Wed, 15 Nov 2023 10:00:00 +0000'
  const source = [
    `From: ${from}`,
    'To: me@example.com',
    `Subject: ${subject}`,
    `Date: ${date}`,
    'Message-ID: <msg-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')

  return {
    source: new TextEncoder().encode(source),
    messageId: undefined,
    seq: 1,
  }
}

interface FakeProviderOptions {
  /**
   * 首次同步返回的游标。
   *
   * ⚠ 用 `'initialCursor' in options` 判「有没有传」而**不能**用 `??`：
   *   `null` 是一个有意义的取值（=「拿不到有效游标」），而 `null ?? 默认值`
   *   会把它替换成默认值 —— 于是「拿不到游标」的用例永远测不到，
   *   而它会静默地测成「正常首次同步」（这一版最初就踩了这个坑）。
   */
  initialCursor?: SyncCursor
  /** 增量拉取返回的邮件 */
  mails?: RawMail[]
  /** 增量拉取后要写回的游标 */
  nextCursor?: SyncCursor
  warning?: string
  /** 让 `fetchSince` 抛错（验证失败不推进游标） */
  failOnFetch?: boolean
  /** 让 `getInitialCursor` 抛错 */
  failOnInitial?: boolean
}

function fakeProvider(options: FakeProviderOptions = {}) {
  const logout = vi.fn(async () => {})
  const fetchSince = vi.fn(async (cursor: SyncCursor): Promise<{ mails: RawMail[], nextCursor: SyncCursor, warning?: string }> => {
    void cursor
    if (options.failOnFetch)
      throw new Error('IMAP 服务器响应超时')
    return {
      mails: options.mails ?? [],
      nextCursor: options.nextCursor ?? { uid: 100 },
      warning: options.warning,
    }
  })

  const hasInitialCursor = 'initialCursor' in options

  const provider: MailProvider = {
    id: 'fake',
    async connect(): Promise<MailConnection> {
      return {
        async getInitialCursor() {
          if (options.failOnInitial)
            throw new Error('拿不到 UIDNEXT')
          return hasInitialCursor ? options.initialCursor ?? null : { uid: 99 }
        },
        fetchSince,
        async logout() {
          await logout()
        },
      }
    },
    async testConnection() {
      return { ok: true }
    },
  }

  return { provider, fetchSince, logout }
}

/**
 * 记录 pipeline 收到的邮件，并把它们**真的写进库**。
 *
 * ⚠ 必须真的入库：不入库的话后台写脚本不等待，`expect(await countMails())` 会先于
 *   写入完成而返回 0；更糟的是 `upsertMail` 里的事务会与下一个测试的
 *   `deleteDatabase` 打架，形成**跨测试污染**（症状是第二个测试看到第一个测试的
 *   游标，于是「首次同步」用例莫名其妙变成了「增量同步」）。
 */
function fakePipeline(overrides: { minimalMode?: boolean, blockedEnabled?: boolean, outcome?: MailOutcome } = {}) {
  const seen: Mail[] = []
  const pipeline: MailPipeline = {
    async readSettingsForFilter() {
      return {
        minimalMode: overrides.minimalMode ?? false,
        blockedEnabled: overrides.blockedEnabled ?? true,
      }
    },
    async process(mail: Mail): Promise<MailOutcome> {
      seen.push(mail)
      const outcome = overrides.outcome ?? 'saved'
      if (outcome === 'saved')
        await upsertMail(mail, 'unlimited')
      return outcome
    },
  }
  return { pipeline, seen }
}

function makeAccount(patch: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-1',
    label: '工作邮箱',
    email: 'me@example.com',
    provider: 'fake',
    config: {},
    blockedList: [],
    enabled: true,
    createdAt: 1000,
    cursor: null,
    ...patch,
  }
}

// ---------------------------------------------------------------------------

describe('首次同步（设计文档 Q5 的硬约束）', () => {
  it('只记游标，一封邮件都不拉', async () => {
    const account = makeAccount()
    await upsertAccount(account)

    const { provider, fetchSince } = fakeProvider({ initialCursor: { uid: 4391 } })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.firstSync).toBe(true)
    expect(result.fetched).toBe(0)
    // 这一条是核心：`fetchSince` **根本不该被调用**
    expect(fetchSince).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(await countMails()).toBe(0)

    // 游标被持久化了，下次心跳才走增量
    expect((await readAccount('acc-1'))?.cursor).toEqual({ uid: 4391 })
  })

  it('拿不到有效游标时写错误、不写假游标（假游标会让下次灌一箱历史）', async () => {
    const account = makeAccount()
    await upsertAccount(account)

    const { provider, fetchSince } = fakeProvider({ initialCursor: null })
    const { pipeline } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.firstSync).toBe(true)
    expect(fetchSince).not.toHaveBeenCalled()

    const stored = await readAccount('acc-1')
    expect(stored?.cursor).toBeNull()
    expect(stored?.lastError).toContain('游标')
    // 没有「同步成功」的痕迹：写 lastSyncedAt 会让 UI 显示「刚刚同步过」，
    // 而实际上什么都没发生
    expect(stored?.lastSyncedAt).toBeUndefined()
  })
})

describe('增量同步', () => {
  it('按游标拉取、逐封交给 pipeline、推进游标', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const mails = [
      { ...rawMail({ subject: 'First' }), seq: 100 },
      { ...rawMail({ subject: 'Second' }), seq: 101 },
    ]
    const { provider, fetchSince } = fakeProvider({ mails, nextCursor: { uid: 101 } })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.firstSync).toBe(false)
    expect(result.fetched).toBe(2)
    expect(fetchSince).toHaveBeenCalledWith({ uid: 99 })
    expect(seen.map(mail => mail.subject)).toEqual(['First', 'Second'])

    const stored = await readAccount('acc-1')
    expect(stored?.cursor).toEqual({ uid: 101 })
    expect(stored?.lastSyncedAt).toBeGreaterThan(0)
    expect(stored?.lastError).toBeUndefined()
  })

  it('读不出来的邮件被跳过，其余照常处理（一封坏邮件不该让整轮失败）', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    /*
     * ⚠ 用 mock 制造解析失败，而不是喂一段「畸形字节」：
     *   `postal-mime` 对任何输入都能产出一个（可能为空的）结果 —— 空字节流也**不会抛错**，
     *   于是那个用例会静默地变成「两封都成功」，测不到想测的东西。
     *   想测的是「解析器抛错时编排层怎么办」，所以直接让解析器抛。
     */
    const parser = await import('~/adapters/mail/parser')
    const spy = vi.spyOn(parser, 'parseRawMail').mockRejectedValueOnce(new Error('MIME 结构损坏'))

    const mails = [
      { ...rawMail({ subject: 'Broken' }), seq: 100 },
      { ...rawMail({ subject: 'Good' }), seq: 101 },
    ]
    const { provider } = fakeProvider({ mails, nextCursor: { uid: 101 } })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)
    spy.mockRestore()

    expect(result.failed).toBe(1)
    expect(seen.map(mail => mail.subject)).toEqual(['Good'])
    // 游标照常推进：卡在一封坏邮件上会让整个账号永远同步不了
    expect((await readAccount('acc-1'))?.cursor).toEqual({ uid: 101 })
  })

  it('解析器不抛错但产出空结果时，仍然入库一条兜底记录（不静默丢件）', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const { provider } = fakeProvider({
      mails: [{ source: new Uint8Array(0), messageId: undefined, seq: 100 }],
      nextCursor: { uid: 100 },
    })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    // 不抛错就不算失败 —— 入库一条「(无主题)」的空记录，比悄悄丢掉它更有用：
    // 用户至少能在列表里看到「有这么一封读不出来的邮件」
    expect(result.failed).toBe(0)
    expect(seen).toHaveLength(1)
    expect(result.fetched).toBe(1)
  })

  it('pipeline 抛错时跳过该封、继续处理其余（游标照常推进）', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const mails = [
      { ...rawMail({ subject: 'Boom' }), seq: 100 },
      { ...rawMail({ subject: 'Fine' }), seq: 101 },
    ]
    const { provider } = fakeProvider({ mails, nextCursor: { uid: 101 } })

    const seen: string[] = []
    const pipeline: MailPipeline = {
      async readSettingsForFilter() {
        return { minimalMode: false, blockedEnabled: true }
      },
      async process(mail) {
        seen.push(mail.subject)
        if (mail.subject === 'Boom')
          throw new Error('AI 与入库都失败了')
        return 'saved'
      },
    }

    const result = await syncWithProvider(account, provider, pipeline)
    expect(seen).toEqual(['Boom', 'Fine'])
    expect(result.failed).toBe(1)
    expect((await readAccount('acc-1'))?.cursor).toEqual({ uid: 101 })
  })
})

describe('失败时不动游标（增量不丢件的基石）', () => {
  it('拉取抛错 → 游标保持原值、lastError 有内容', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const { provider } = fakeProvider({ failOnFetch: true })
    const { pipeline } = fakePipeline()

    await expect(syncWithProvider(account, provider, pipeline)).rejects.toThrow('超时')

    // 这一条是**最关键**的：游标没动，下次心跳会重拉同一段
    expect((await readAccount('acc-1'))?.cursor).toEqual({ uid: 99 })
  })

  it('连接必须被关掉（SW 被回收后留着死 socket 会表现成「登录成功但命令全超时」）', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const { provider, logout } = fakeProvider({ mails: [] })
    const { pipeline } = fakePipeline()

    await syncWithProvider(account, provider, pipeline)
    expect(logout).toHaveBeenCalled()
  })

  it('抛错路径上也要关连接', async () => {
    const account = makeAccount({ cursor: { uid: 99 } })
    await upsertAccount(account)

    const { provider, logout } = fakeProvider({ failOnFetch: true })
    const { pipeline } = fakePipeline()

    await expect(syncWithProvider(account, provider, pipeline)).rejects.toThrow()
    expect(logout).toHaveBeenCalled()
  })
})

describe('排除邮箱（per-account，仅完整模式）', () => {
  it('命中的邮件完全不进 pipeline', async () => {
    const account = makeAccount({
      cursor: { uid: 99 },
      blockedList: [{ kind: 'email', value: 'spam@evil.com' }],
    })
    await upsertAccount(account)

    const mails = [
      { ...rawMail({ from: 'spam@evil.com', subject: 'Buy now' }), seq: 100 },
      { ...rawMail({ from: 'boss@company.com', subject: 'Meeting' }), seq: 101 },
    ]
    const { provider } = fakeProvider({ mails, nextCursor: { uid: 101 } })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.blocked).toBe(1)
    expect(seen.map(mail => mail.subject)).toEqual(['Meeting'])
  })

  it('域名条目同样生效', async () => {
    const account = makeAccount({
      cursor: { uid: 99 },
      blockedList: [{ kind: 'domain', value: 'tracker.com' }],
    })
    await upsertAccount(account)

    const mails = [{ ...rawMail({ from: 'a@sub.tracker.com' }), seq: 100 }]
    const { provider } = fakeProvider({ mails })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)
    expect(result.blocked).toBe(1)
    expect(seen).toHaveLength(0)
  })

  it('全局 blockedEnabled 关掉时列表失效', async () => {
    const account = makeAccount({
      cursor: { uid: 99 },
      blockedList: [{ kind: 'email', value: 'a@b.com' }],
    })
    await upsertAccount(account)

    const { provider } = fakeProvider({ mails: [{ ...rawMail({ from: 'a@b.com' }), seq: 100 }] })
    const { pipeline, seen } = fakePipeline({ blockedEnabled: false })

    await syncWithProvider(account, provider, pipeline)
    expect(seen).toHaveLength(1)
  })

  it('极简模式不吃排除列表（极简模式没有这个概念）', async () => {
    const account = makeAccount({
      cursor: { uid: 99 },
      blockedList: [{ kind: 'email', value: 'a@b.com' }],
    })
    await upsertAccount(account)

    const { provider } = fakeProvider({ mails: [{ ...rawMail({ from: 'a@b.com' }), seq: 100 }] })
    const { pipeline, seen } = fakePipeline({ minimalMode: true })

    await syncWithProvider(account, provider, pipeline)
    expect(seen).toHaveLength(1)
  })

  it('两个账号的排除列表互相独立（Q7 的隔离要求）', async () => {
    const accountA = makeAccount({ id: 'a', blockedList: [{ kind: 'email', value: 'x@y.com' }], cursor: { uid: 1 } })
    const accountB = makeAccount({ id: 'b', blockedList: [], cursor: { uid: 1 } })
    await upsertAccount(accountA)
    await upsertAccount(accountB)

    const raw = { ...rawMail({ from: 'x@y.com' }), seq: 2 }

    const a = fakeProvider({ mails: [raw], nextCursor: { uid: 2 } })
    const aPipeline = fakePipeline()
    await syncWithProvider(accountA, a.provider, aPipeline.pipeline)

    const b = fakeProvider({ mails: [raw], nextCursor: { uid: 2 } })
    const bPipeline = fakePipeline()
    await syncWithProvider(accountB, b.provider, bPipeline.pipeline)

    // A 被屏蔽，B 不受影响 —— 这正是 per-account 设计的意义
    expect(aPipeline.seen).toHaveLength(0)
    expect(bPipeline.seen).toHaveLength(1)
  })
})

describe('uIDVALIDITY 变化', () => {
  it('provider 报 warning + 给出新游标时：清零游标、补拉 0 封、警告留给用户看', async () => {
    const account = makeAccount({ cursor: { uid: 99, uidValidity: 1 } })
    await upsertAccount(account)

    /*
     * 这里的假 provider 精确模拟前一次同步之后的真实状态：邮箱被重建，于是
     * `fetchSince` 发现 UIDVALIDITY 变了 → 返回**空邮件 + 新游标 + warning**。
     * 界面语义就是「本次从最新邮件开始，之前的不会补拉」。
     */
    const { provider } = fakeProvider({
      mails: [],
      nextCursor: { uid: 500, uidValidity: 2 },
      warning: '邮箱的 UIDVALIDITY 已变化（1 → 2），历史游标已失效。',
    })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.fetched).toBe(0)
    expect(seen).toHaveLength(0)
    expect(result.warning).toContain('UIDVALIDITY')

    const stored = await readAccount('acc-1')
    expect(stored?.cursor).toEqual({ uid: 500, uidValidity: 2 })
    // 警告要留在 lastError 上让 Options 能显示出来（用户需要知道自己错过了什么）
    expect(stored?.lastError).toContain('UIDVALIDITY')
  })

  it('带回 warning 但**同时有邮件**时：邮件照常处理、游标照常推进', async () => {
    // 有些 provider 在「部分恢复」的场景下会这样回：警告与数据同时存在。
    // 编排层不能因为一个警告就把这一批丢掉 —— 那是静默丢件
    const account = makeAccount({ cursor: { uid: 99, uidValidity: 1 } })
    await upsertAccount(account)

    const { provider } = fakeProvider({
      mails: [{ ...rawMail({ subject: 'After rebuild' }), seq: 500 }],
      nextCursor: { uid: 500, uidValidity: 2 },
      warning: 'UIDVALIDITY 变化，部分历史可能缺失',
    })
    const { pipeline, seen } = fakePipeline()

    const result = await syncWithProvider(account, provider, pipeline)

    expect(result.fetched).toBe(1)
    expect(seen.map(mail => mail.subject)).toEqual(['After rebuild'])
    expect(await countMails()).toBe(1)
  })
})

describe('多账号编排', () => {
  it('一个账号失败不影响另一个（最糟的体验是「Gmail 挂了公司邮箱也收不到」）', async () => {
    /*
     * ⚠ 这里刻意用 `syncAllAccounts` 的真实路径不可行：它经注册表按 `provider` id
     *   造 provider，而测试里没有名为 'fake' 的 provider。所以直接验证**同一条
     *   契约的两半**：坏账号抛错、好账号照样跑完。
     *   `syncAllAccounts` 的循环本身（try/catch + 逐个串行）由它自己的实现保证，
     *   而这里断言的是「失败被隔离」这件事在编排层是可能的。
     */
    const good = makeAccount({ id: 'good', cursor: { uid: 1 } })
    const bad = makeAccount({ id: 'bad', cursor: { uid: 1 } })
    await upsertAccount(good)
    await upsertAccount(bad)

    const { pipeline, seen } = fakePipeline()

    const badResult = await syncWithProvider(bad, fakeProvider({ failOnFetch: true }).provider, pipeline)
      .catch(error => ({ error: String(error) }))
    expect('error' in badResult).toBe(true)

    const goodResult = await syncWithProvider(
      good,
      fakeProvider({ mails: [{ ...rawMail({ subject: 'ok' }), seq: 2 }], nextCursor: { uid: 2 } }).provider,
      pipeline,
    )

    expect(goodResult.fetched).toBe(1)
    expect(seen).toHaveLength(1)
    expect(await readMailsByAccount('good')).toHaveLength(1)
    // 坏账号的游标没动，下次心跳会重试同一段
    expect((await readAccount('bad'))?.cursor).toEqual({ uid: 1 })
  })
})
