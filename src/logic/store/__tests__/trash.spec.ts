import type { Mail } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import {
  countTrashedMails,
  deleteMailForever,
  emptyTrash,
  readMail,
  readRecentMails,
  readTrashedMails,
  restoreMail,
  trashExpiredCodes,
  trashMail,
  upsertMail,
} from '~/logic/store/mails'
import { pruneMails } from '~/logic/store/prune'
import { MINIMAL_RETENTION } from '~/logic/types'
import { runTx } from '~/platform/idb/database'

/**
 * 回收站的数据层单测。
 *
 * ## 这里守的三条不变量
 *
 * 1. **回收站是状态变更，不是软删除** —— 移进去时记录本身不动，
 *    所以「恢复」必须能把邮件**原样**送回主列表。
 * 2. **彻底删除是硬删除** —— 从仓库里真的没了，`readMail` 必须返回 `undefined`。
 * 3. **滚动淘汰不许碰回收站** —— 否则它就是个「过一会儿自己清空」的假回收站，
 *    用户来不及反悔。这条最容易在重构里被顺手破坏。
 *
 * 另外还有「失效验证码自动删除」的核心规则：**30 秒宽限期**。
 * 它是个纯时间逻辑，写错了只会表现为「偶尔误删还有效的验证码」——
 * 那种 bug 靠手测基本抓不到，而验证码是一次性的，误删等于用户要重新申请一个。
 */

function makeMail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'acc-1:m1',
    accountId: 'acc-1',
    from: [{ name: '发件人', address: 'from@example.com' }],
    to: [],
    subject: '测试邮件',
    snippet: '验证码 123456',
    receivedAt: 1_700_000_000_000,
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    ...patch,
  }
}

describe('移入回收站 / 恢复', () => {
  it('移入回收站后不在主列表里，但在回收站列表里', async () => {
    await upsertMail(makeMail())
    expect(await readRecentMails()).toHaveLength(1)

    await trashMail('acc-1:m1', 1_700_000_100_000)

    expect(await readRecentMails()).toHaveLength(0)
    const trashed = await readTrashedMails()
    expect(trashed).toHaveLength(1)
    expect(trashed[0].trashedAt).toBe(1_700_000_100_000)
  })

  it('恢复后回到主列表，且 `trashedAt` 被清掉', async () => {
    await upsertMail(makeMail())
    await trashMail('acc-1:m1', 1_700_000_100_000)

    const restored = await restoreMail('acc-1:m1')

    expect(restored?.trashedAt).toBeUndefined()
    expect(await readRecentMails()).toHaveLength(1)
    expect(await readTrashedMails()).toHaveLength(0)
  })

  /*
   * ⚠ 这一条守「回收站是状态变更」这个**语义**：
   *   如果哪天有人把它实现成「复制一份到回收站、或者删掉正文」，
   *   恢复之后邮件就残了 —— 而用户毫无察觉。
   */
  it('移入回收站不会丢字段（正文、AI 结果、验证码都还在）', async () => {
    const original = makeMail({
      bodyText: '完整正文内容',
      code: '123456',
      codeExpiresAt: 1_700_000_300_000,
      snippet: '摘要片段',
      ai: {
        minimal: '验证码：123456',
        summary: 'AI 摘要',
        isAd: false,
        code: '123456',
        validForSeconds: 300,
        urgency: 'high',
      },
    })
    await upsertMail(original)
    await trashMail('acc-1:m1', 1_700_000_100_000)

    const trashed = (await readTrashedMails())[0]

    expect(trashed.bodyText).toBe('完整正文内容')
    expect(trashed.code).toBe('123456')
    expect(trashed.codeExpiresAt).toBe(1_700_000_300_000)
    expect(trashed.ai?.summary).toBe('AI 摘要')
    expect(trashed.snippet).toBe('摘要片段')
  })

  /*
   * 重复点删除不能把排序位置一直往前顶 —— 用户会看到「这封邮件怎么突然跑到最上面」。
   */
  it('重复移入回收站保留**第一次**的时间', async () => {
    await upsertMail(makeMail())
    await trashMail('acc-1:m1', 1_700_000_100_000)
    await trashMail('acc-1:m1', 1_700_000_900_000)

    expect((await readTrashedMails())[0].trashedAt).toBe(1_700_000_100_000)
  })

  it('移入不存在的邮件返回 undefined（不抛错）', async () => {
    expect(await trashMail('acc-1:nope')).toBeUndefined()
    expect(await restoreMail('acc-1:nope')).toBeUndefined()
  })
})

describe('彻底删除（硬删除）', () => {
  it('deleteMailForever 之后记录真的没了', async () => {
    await upsertMail(makeMail())
    await trashMail('acc-1:m1')

    expect(await deleteMailForever('acc-1:m1')).toBe(true)

    expect(await readMail('acc-1:m1')).toBeUndefined()
    expect(await readTrashedMails()).toHaveLength(0)
    // 连主列表也不该有 —— 硬删除就是没了，没有「换个地方还留着」
    expect(await readRecentMails()).toHaveLength(0)
  })

  it('删除不存在的邮件返回 false', async () => {
    expect(await deleteMailForever('acc-1:nope')).toBe(false)
  })

  it('清空回收站只删回收站里的，主列表不受影响', async () => {
    await upsertMail(makeMail({ id: 'acc-1:keep', subject: '保留' }))
    await upsertMail(makeMail({ id: 'acc-1:gone1', subject: '删1' }))
    await upsertMail(makeMail({ id: 'acc-1:gone2', subject: '删2' }))
    await trashMail('acc-1:gone1')
    await trashMail('acc-1:gone2')

    expect(await countTrashedMails()).toBe(2)
    const removed = await emptyTrash()

    expect(removed).toBe(2)
    expect(await readTrashedMails()).toHaveLength(0)
    const remaining = await readRecentMails()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('acc-1:keep')
  })

  it('空回收站清空返回 0（幂等，不报错）', async () => {
    expect(await emptyTrash()).toBe(0)
  })
})

describe('回收站列表按删除时间倒序', () => {
  it('最近删的在最前', async () => {
    await upsertMail(makeMail({ id: 'acc-1:old', subject: '先删的' }))
    await upsertMail(makeMail({ id: 'acc-1:new', subject: '后删的' }))
    await trashMail('acc-1:old', 1_000)
    await trashMail('acc-1:new', 2_000)

    const list = await readTrashedMails()

    expect(list.map(m => m.id)).toEqual(['acc-1:new', 'acc-1:old'])
  })

  it('limit 生效', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertMail(makeMail({ id: `acc-1:m${i}` }))
      await trashMail(`acc-1:m${i}`, 1000 + i)
    }

    expect(await readTrashedMails(2)).toHaveLength(2)
  })
})

describe('失效验证码自动删除：30 秒宽限期', () => {
  const NOW = 1_700_000_000_000
  const GRACE = 30_000

  it('刚失效但还在宽限期内 → **不动它**（防误删还有效的验证码）', async () => {
    // 失效时刻 = NOW - 10 秒，宽限期 30 秒 → 还没到该动的时候
    await upsertMail(makeMail({ id: 'acc-1:m1', codeExpiresAt: NOW - 10_000 }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(0)
    expect(await readRecentMails()).toHaveLength(1)
  })

  /*
   * ⚠ 这一条是边界：**恰好**过了宽限期就该动手，
   *   而不是「再多等一轮」。差一毫秒的实现会让删除晚一分钟（alarm 周期），
   *   在用户看来就是「说好的 30 秒怎么等了两分钟」。
   */
  it('刚好越过宽限期 → 移入回收站', async () => {
    await upsertMail(makeMail({ id: 'acc-1:m1', codeExpiresAt: NOW - GRACE }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(1)
    expect(await readRecentMails()).toHaveLength(0)
    expect(await readTrashedMails()).toHaveLength(1)
  })

  it('还完全有效的验证码不动', async () => {
    await upsertMail(makeMail({ id: 'acc-1:m1', codeExpiresAt: NOW + 60_000 }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(0)
    expect(await readRecentMails()).toHaveLength(1)
  })

  /*
   * ⚠ 「不知道什么时候失效」≠「已经失效」。
   *   没有明确有效期的验证码邮件（AI 没读到时长）必须留着 ——
   *   删掉它就是删掉一封可能还能用的验证码。
   */
  it('没有 codeExpiresAt 的邮件**永远不自动删**', async () => {
    await upsertMail(makeMail({ id: 'acc-1:m1', code: '999999' }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(0)
    expect(await readRecentMails()).toHaveLength(1)
  })

  it('普通邮件（没有验证码）不受影响', async () => {
    await upsertMail(makeMail({ id: 'acc-1:m1', subject: '周报', code: undefined }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(0)
  })

  /*
   * ⚠ 幂等性：alarm 每分钟跑一次，而「已失效」这个条件会**持续成立**。
   *   不跳过已在回收站里的邮件，每一轮都会重写一遍 ——
   *   那会让 `trashedAt` 一直被刷新（排序乱掉），还会白白触发广播。
   */
  it('已经在回收站里的不会被重复处理（trashedAt 不被刷新）', async () => {
    await upsertMail(makeMail({ id: 'acc-1:m1', codeExpiresAt: NOW - 60_000 }))
    await trashMail('acc-1:m1', 5_000)

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(0)
    expect((await readTrashedMails())[0].trashedAt).toBe(5_000)
  })

  it('一次处理多封，只动该动的', async () => {
    await upsertMail(makeMail({ id: 'acc-1:expired1', codeExpiresAt: NOW - 60_000 }))
    await upsertMail(makeMail({ id: 'acc-1:expired2', codeExpiresAt: NOW - 120_000 }))
    await upsertMail(makeMail({ id: 'acc-1:valid', codeExpiresAt: NOW + 60_000 }))
    await upsertMail(makeMail({ id: 'acc-1:none' }))

    expect(await trashExpiredCodes(GRACE, NOW)).toBe(2)

    const kept = await readRecentMails()
    expect(kept.map(m => m.id).sort()).toEqual(['acc-1:none', 'acc-1:valid'])
  })
})

describe('滚动淘汰不碰回收站', () => {
  /*
   * ⚠ 这条如果被破坏，回收站就变成了「过一会儿自己清空」的假回收站 ——
   *   用户根本来不及反悔。而它非常容易被顺手改坏：
   *   `pruneMails` 原来就是「数整表条数、删最旧的 N 封」，回收站里的会被一起数进去、
   *   一起删掉。
   *
   * ⚠ 这里**直接调 `pruneMails`** 而不是走 `patchAppSettings` + `pruneMailsNow`：
   *   `AppSettings.mailRetention` 被约束成 `{100, 200, 500, 1000, 'unlimited'}`
   *   （`RETENTION_VALUES`），设不成很小的值 —— 而这条用例需要一个小到能手工
   *   构造的上限。用 `MINIMAL_RETENTION`（50，极简模式那个写死的值）刚好。
   */
  const LIMIT = MINIMAL_RETENTION

  /** 造 `n` 封活跃邮件（`receivedAt` 递增，所以序号越大越新） */
  async function seedLive(n: number, offset = 0) {
    for (let i = 0; i < n; i++) {
      await upsertMail(
        makeMail({ id: `acc-1:live-${offset + i}`, receivedAt: offset + i + 1 }),
        /*
         * ⚠ 写入时要把上限设成 `'unlimited'`，否则 `upsertMail` 自己就会
         *   按默认上限（极简模式写死 `MINIMAL_RETENTION`）**边写边淘汰** ——
         *   种子数据还没铺完就已经被削到上限，后面那次 `pruneMails` 自然无事可做。
         *
         *   这条用例要验的是「**稍后**的一次淘汰会不会误伤回收站」
         *   （alarm 兜底、用户改上限后手动触发），所以必须先把超限的状态造出来。
         */
        'unlimited',
      )
    }
  }

  it('超限时删的是最旧的**活跃**邮件，回收站里的留着', async () => {
    // 最旧的两封先进回收站（它们**不该**占保留名额）
    await upsertMail(makeMail({ id: 'acc-1:trashed-a', receivedAt: 1 }))
    await upsertMail(makeMail({ id: 'acc-1:trashed-b', receivedAt: 2 }))
    await trashMail('acc-1:trashed-a', 100)
    await trashMail('acc-1:trashed-b', 200)

    // LIMIT + 1 封活跃邮件 → 超出 1 封
    await seedLive(LIMIT + 1, 10)

    const removed = await runTx(['mails'], 'readwrite', ctx => pruneMails(ctx, LIMIT))
    expect(removed).toBe(1)

    // 活跃的正好剩 LIMIT 封
    expect(await readRecentMails(LIMIT + 10)).toHaveLength(LIMIT)

    // 回收站里的两封**一封都不能少** —— 这是本用例的全部意义
    expect(await countTrashedMails()).toBe(2)
    expect((await readTrashedMails()).map(m => m.id).sort())
      .toEqual(['acc-1:trashed-a', 'acc-1:trashed-b'])
  })

  /*
   * ⚠ 这一条守的是「回收站不占保留名额」这个**语义**：
   *   如果 `pruneMails` 把回收站里的也算进 `live` 计数，
   *   用户会看到「上限 100，主列表却只有 60 封」，而回收站里躺着 40 封 ——
   *   两者的关系完全看不出来。
   */
  it('回收站里的邮件不占保留名额', async () => {
    // 20 封全进回收站
    for (let i = 0; i < 20; i++) {
      await upsertMail(makeMail({ id: `acc-1:t${i}`, receivedAt: i + 1 }))
      await trashMail(`acc-1:t${i}`, 100 + i)
    }
    // 活跃恰好 LIMIT 封
    await seedLive(LIMIT, 1000)

    // 活跃数 == 上限 → 一封都不该删（回收站那 20 封不算数）
    expect(await runTx(['mails'], 'readwrite', ctx => pruneMails(ctx, LIMIT))).toBe(0)
    expect(await countTrashedMails()).toBe(20)
    expect(await readRecentMails(LIMIT + 10)).toHaveLength(LIMIT)
  })
})
