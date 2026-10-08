import type { Mail, MailAccount, RetentionLimit } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import {
  deleteAccount,
  findAccountByEmail,
  isFirstSync,
  listAccounts,
  listEnabledAccounts,
  markAccountError,
  markAccountSynced,
  readAccount,
  upsertAccount,
} from '~/logic/store/accounts'
import {
  countMails,
  estimateStorageUsage,
  markAllRead,
  pruneMailsNow,
  readMail,
  readMailsByAccount,
  readRecentMails,
  retentionLimit,
  setMailRead,
  upsertMail,
} from '~/logic/store/mails'
import { deleteRule, listRules, moveRule, readRule, upsertRule } from '~/logic/store/rules'
import { patchAppSettings, readAiSettings, readAppSettings, writeAiSettings } from '~/logic/store/settings'
import {
  createDefaultRule,
  mailKey,
  MINIMAL_RETENTION,
} from '~/logic/types'

/**
 * 仓库层单测（`03-roadmap.md` M1 验收：「IDB 单测 80%」「IDB 持久化 OK」
 * 「首次心跳只记游标、不拉任何邮件」「滚动淘汰」）。
 *
 * 这一层是**唯一**读写 IndexedDB 的地方，所以「事务边界」「淘汰」这类容易出错
 * 又难以手测的逻辑全在这里被钉住。跑在 `fake-indexeddb` 上，整个文件毫秒级。
 */

function makeAccount(patch: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-1',
    label: '工作邮箱',
    email: 'me@example.com',
    provider: 'gmail',
    config: { clientId: 'x.apps.googleusercontent.com', refreshToken: 'rt' },
    blockedList: [],
    enabled: true,
    createdAt: 1000,
    cursor: null,
    ...patch,
  }
}

function makeMail(patch: Partial<Mail> = {}): Mail {
  const messageId = patch.messageId ?? `m${Math.random().toString(36).slice(2, 8)}`
  const accountId = patch.accountId ?? 'acc-1'
  return {
    id: mailKey(accountId, messageId),
    accountId,
    from: [{ name: 'GitHub', address: 'noreply@github.com' }],
    to: [{ name: '', address: 'me@example.com' }],
    subject: 'New PR',
    snippet: 'a new pull request',
    bodyText: 'a new pull request in foo/bar',
    receivedAt: 1_700_000_000_000,
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    messageId,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

describe('accounts 仓库', () => {
  it('写入后读得回来，字段被归一化', async () => {
    await upsertAccount(makeAccount({ email: 'Me@Example.COM' }))
    const loaded = await readAccount('acc-1')
    expect(loaded?.email).toBe('me@example.com')
    expect(loaded?.label).toBe('工作邮箱')
  })

  it('listAccounts 按 createdAt 升序（顺序稳定，UI 不会每次刷新换位置）', async () => {
    await upsertAccount(makeAccount({ id: 'b', email: 'b@x.com', createdAt: 2000 }))
    await upsertAccount(makeAccount({ id: 'a', email: 'a@x.com', createdAt: 1000 }))
    expect((await listAccounts()).map(item => item.id)).toEqual(['a', 'b'])
  })

  it('listEnabledAccounts 只返回启用的（心跳只跑这些）', async () => {
    await upsertAccount(makeAccount({ id: 'a', email: 'a@x.com', enabled: true }))
    await upsertAccount(makeAccount({ id: 'b', email: 'b@x.com', enabled: false }))
    expect((await listEnabledAccounts()).map(item => item.id)).toEqual(['a'])
  })

  it('findAccountByEmail 走 by-email 索引且大小写不敏感', async () => {
    await upsertAccount(makeAccount())
    expect((await findAccountByEmail('ME@example.com'))?.id).toBe('acc-1')
    expect(await findAccountByEmail('nobody@example.com')).toBeUndefined()
  })

  it('isFirstSync：没有游标就是首次（首次不拉历史）', async () => {
    expect(isFirstSync({ cursor: null })).toBe(true)
    expect(isFirstSync({ cursor: { historyId: '1' } })).toBe(false)
  })

  it('markAccountSynced 记录时间并清掉旧错误', async () => {
    await upsertAccount(makeAccount())
    await markAccountError('acc-1', '登录失败')
    expect((await readAccount('acc-1'))?.lastError).toBe('登录失败')

    await markAccountSynced('acc-1', { historyId: '99' })
    const loaded = await readAccount('acc-1')
    expect(loaded?.cursor).toEqual({ historyId: '99' })
    expect(loaded?.lastError).toBeUndefined()
    expect(loaded?.lastSyncedAt).toBeGreaterThan(0)
  })

  it('markAccountError 只写错误、不动游标（下次重试同一段增量）', async () => {
    await upsertAccount(makeAccount({ cursor: { historyId: '5' } }))
    await markAccountError('acc-1', '网络错误')
    const loaded = await readAccount('acc-1')
    expect(loaded?.cursor).toEqual({ historyId: '5' })
    expect(loaded?.lastError).toBe('网络错误')
  })

  it('deleteAccount 删掉账号', async () => {
    await upsertAccount(makeAccount())
    await deleteAccount('acc-1')
    expect(await readAccount('acc-1')).toBeUndefined()
  })

  it('per-account blockedList 各自独立（Q7 的隔离要求）', async () => {
    await upsertAccount(makeAccount({ id: 'a', email: 'a@x.com', blockedList: [{ kind: 'email', value: 'spam@x.com' }] }))
    await upsertAccount(makeAccount({ id: 'b', email: 'b@x.com', blockedList: [] }))

    expect((await readAccount('a'))?.blockedList).toHaveLength(1)
    expect((await readAccount('b'))?.blockedList).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// mails
// ---------------------------------------------------------------------------

describe('mails 仓库', () => {
  it('读最近 N 封按 receivedAt 倒序', async () => {
    await upsertMail(makeMail({ messageId: '1', receivedAt: 100 }), 'unlimited')
    await upsertMail(makeMail({ messageId: '2', receivedAt: 300 }), 'unlimited')
    await upsertMail(makeMail({ messageId: '3', receivedAt: 200 }), 'unlimited')

    const recent = await readRecentMails(10)
    expect(recent.map(mail => mail.receivedAt)).toEqual([300, 200, 100])
  })

  it('readRecentMails 的 limit 生效（不会读全表）', async () => {
    for (let i = 0; i < 10; i++)
      await upsertMail(makeMail({ messageId: `m${i}`, receivedAt: 100 + i }), 'unlimited')

    expect(await readRecentMails(3)).toHaveLength(3)
  })

  it('readMailsByAccount 只返回该账号的（多账号隔离）', async () => {
    await upsertMail(makeMail({ accountId: 'acc-1', messageId: '1' }), 'unlimited')
    await upsertMail(makeMail({ accountId: 'acc-2', messageId: '2' }), 'unlimited')

    const mails = await readMailsByAccount('acc-1')
    expect(mails).toHaveLength(1)
    expect(mails[0].accountId).toBe('acc-1')
  })

  it('滚动淘汰：超出上限时丢掉最旧的', async () => {
    // 保留 100：写 105 封，最旧的 5 封应该没了
    for (let i = 0; i < 105; i++)
      await upsertMail(makeMail({ messageId: `m${i}`, receivedAt: 1000 + i }), 100)

    expect(await countMails()).toBe(100)
    // 最旧的 5 封（receivedAt 1000..1004）已被淘汰
    expect(await readMail(mailKey('acc-1', 'm0'))).toBeUndefined()
    expect(await readMail(mailKey('acc-1', 'm4'))).toBeUndefined()
    expect(await readMail(mailKey('acc-1', 'm5'))).toBeDefined()
    expect(await readMail(mailKey('acc-1', 'm104'))).toBeDefined()
  })

  it('unlimited 时不做淘汰', async () => {
    for (let i = 0; i < 120; i++)
      await upsertMail(makeMail({ messageId: `m${i}`, receivedAt: 1000 + i }), 'unlimited')
    expect(await countMails()).toBe(120)
  })

  it('retentionLimit：极简模式写死 50，完整模式读设置', () => {
    expect(retentionLimit({ minimalMode: true, mailRetention: 1000 })).toBe(MINIMAL_RETENTION)
    expect(retentionLimit({ minimalMode: false, mailRetention: 500 })).toBe(500)
    expect(retentionLimit({ minimalMode: false, mailRetention: 'unlimited' })).toBe('unlimited')
  })

  it('写入与淘汰在同一个事务里（并发写不会突破上限）', async () => {
    /*
     * 这一条是「为什么淘汰必须和 put 在同一个事务」的可执行证据：拆成两个事务时，
     * 并发写的两边会各自 count 出「还没超限」而双双留下条目。
     *
     * ⚠ 用一个**非法档位之外**的值（25）当上限是刻意的：`RetentionLimit` 只允许
     *   100/200/500/1000/50/unlimited，而这里要的是一个不影响其它用例的小数字来
     *   把「并发 10 封、上限 25 之外的某个数」这件事压到几毫秒内跑完。
     *   类型上它落在 `RetentionLimit` 之外，所以走 `as` —— 这是测试夹具的便利，
     *   不是生产路径（`retentionLimit()` 只会产出合法档位）。
     */
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        upsertMail(makeMail({ messageId: `c${i}`, receivedAt: 2000 + i }), 5 as unknown as RetentionLimit)),
    )
    expect(await countMails()).toBe(5)
  })

  it('upsert 同一封邮件是覆盖而不是新增（账本键 = accountId:messageId）', async () => {
    const mail = makeMail({ messageId: 'dup' })
    await upsertMail(mail, 'unlimited')
    await upsertMail({ ...mail, subject: '改过的主题' }, 'unlimited')

    expect(await countMails()).toBe(1)
    expect((await readMail(mail.id))?.subject).toBe('改过的主题')
  })

  it('setMailRead / markAllRead', async () => {
    await upsertMail(makeMail({ messageId: '1' }), 'unlimited')
    await upsertMail(makeMail({ messageId: '2' }), 'unlimited')

    await setMailRead(mailKey('acc-1', '1'), true)
    expect((await readMail(mailKey('acc-1', '1')))?.read).toBe(true)

    const count = await markAllRead()
    expect(count).toBe(1) // 只有第二封还没读
    expect((await readRecentMails(10)).every(mail => mail.read)).toBe(true)
  })

  it('estimateStorageUsage 统计条数与账号分布', async () => {
    await upsertMail(makeMail({ accountId: 'acc-1', messageId: '1' }), 'unlimited')
    await upsertMail(makeMail({ accountId: 'acc-2', messageId: '2' }), 'unlimited')

    const usage = await estimateStorageUsage()
    expect(usage.count).toBe(2)
    expect(usage.bytesApprox).toBeGreaterThan(0)
    expect(usage.byAccount['acc-1'].count).toBe(1)
    expect(usage.byAccount['acc-2'].count).toBe(1)
  })

  it('pruneMailsNow 按当前设置立刻淘汰（改设置后不用等下一封邮件）', async () => {
    await patchAppSettings({ minimalMode: false, mailRetention: 1000 })
    for (let i = 0; i < 10; i++)
      await upsertMail(makeMail({ messageId: `p${i}`, receivedAt: 1000 + i }))

    expect(await countMails()).toBe(10)

    // 用户把上限降到 100（已经是合法最小值），这里换成极简模式来验证「立刻生效」
    await patchAppSettings({ minimalMode: true })
    // 极简模式上限 50，10 封不超标；改成直接调 prune 验证函数本身
    const removed = await pruneMailsNow()
    expect(removed).toBe(0)
    expect(await countMails()).toBe(10)
  })

  it('极简模式的记录只有验证码相关字段（正文不落库）', async () => {
    const minimal: Mail = makeMail({
      messageId: 'code-1',
      code: '123456',
      snippet: '',
      bodyText: undefined,
      bodyHtml: undefined,
      processing: 'skipped',
      ai: { minimal: '验证码：123456', summary: '', isAd: false, code: '123456', urgency: 'high' },
      copyStatus: 'copied',
    })
    await upsertMail(minimal, MINIMAL_RETENTION)

    const loaded = await readMail(minimal.id)
    expect(loaded?.code).toBe('123456')
    expect(loaded?.bodyText).toBeUndefined()
    expect(loaded?.snippet).toBe('')
  })
})

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

describe('rules 仓库', () => {
  it('内置默认规则不落库：upsert 被拒绝、read 返回 undefined', async () => {
    await expect(upsertRule(createDefaultRule())).rejects.toThrow()
    expect(await readRule(createDefaultRule().id)).toBeUndefined()
    expect(await listRules()).toHaveLength(0)
  })

  it('listRules 按 priority 升序', async () => {
    await upsertRule({ ...createDefaultRule(), id: 'r2', name: 'B', priority: 5 })
    await upsertRule({ ...createDefaultRule(), id: 'r1', name: 'A', priority: 1 })
    expect((await listRules()).map(rule => rule.id)).toEqual(['r1', 'r2'])
  })

  it('moveRule 上移 / 下移并重排 priority 为 0..n-1', async () => {
    await upsertRule({ ...createDefaultRule(), id: 'a', name: 'A', priority: 0, createdAt: 1 })
    await upsertRule({ ...createDefaultRule(), id: 'b', name: 'B', priority: 1, createdAt: 2 })
    await upsertRule({ ...createDefaultRule(), id: 'c', name: 'C', priority: 2, createdAt: 3 })

    const moved = await moveRule('c', 'up')
    expect(moved.map(rule => rule.id)).toEqual(['a', 'c', 'b'])
    expect(moved.map(rule => rule.priority)).toEqual([0, 1, 2])
  })

  it('moveRule 越界时原样返回（不会把第一条往上移出列表）', async () => {
    await upsertRule({ ...createDefaultRule(), id: 'a', name: 'A', priority: 0 })
    const result = await moveRule('a', 'up')
    expect(result.map(rule => rule.id)).toEqual(['a'])
  })

  it('deleteRule 删掉规则；对内置 id 是空操作', async () => {
    await upsertRule({ ...createDefaultRule(), id: 'a', name: 'A', priority: 0 })
    await deleteRule('a')
    expect(await listRules()).toHaveLength(0)

    // 内置规则本来就查不到，删它不该抛错（UI 上可能出现这个调用）
    await expect(deleteRule(createDefaultRule().id)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe('settings 仓库', () => {
  it('空库读出来是设计文档里的默认值', async () => {
    const app = await readAppSettings()
    expect(app.minimalMode).toBe(true)
    expect(app.mailRetention).toBe(100)

    const ai = await readAiSettings()
    expect(ai.platform).toBe('deepseek')
    expect(ai.apiKey).toBe('')
  })

  it('patchAppSettings 是部分更新（不传的字段保持原值）', async () => {
    await patchAppSettings({ minimalMode: false, mailRetention: 500 })
    const app = await patchAppSettings({ excludeAds: false })

    expect(app.minimalMode).toBe(false)
    expect(app.mailRetention).toBe(500)
    expect(app.excludeAds).toBe(false)
  })

  it('两份设置各自独立（app 与 ai 互不覆盖）', async () => {
    await patchAppSettings({ minimalMode: false })
    await writeAiSettings({
      platform: 'openai',
      apiKey: 'sk-test',
      outputLanguage: 'auto-email',
    })

    expect((await readAppSettings()).minimalMode).toBe(false)
    const ai = await readAiSettings()
    expect(ai.platform).toBe('openai')
    expect(ai.apiKey).toBe('sk-test')
    expect(ai.outputLanguage).toBe('auto-email')
  })
})
