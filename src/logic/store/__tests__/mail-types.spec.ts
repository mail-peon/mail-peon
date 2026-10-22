import type { MailTypeRecord } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import {
  deleteMailTypeRecord,
  listMailTypeRecords,
  moveCustomMailType,
  nextCustomPriority,
  readMailTypeRecord,
  upsertMailTypeRecord,
} from '~/logic/store/mail-types'
import {
  BUILTIN_CODE_ID,
  BUILTIN_CONFIRM_ID,
  BUILTIN_SUMMARY_ID,
} from '~/logic/types'

/**
 * 适配器仓库（`mailTypes`）的读写契约。
 *
 * 这一层要守住的三件事：
 *   1. 内置适配器**不落库**：只存 override，删掉就恢复默认；
 *   2. 自定义类型整条存，排序按 priority；
 *   3. 极简模式是**生效层覆盖**，不修改保存的状态。
 */

function custom(patch: Partial<MailTypeRecord> = {}): MailTypeRecord {
  return {
    id: 'custom:budget',
    kind: 'custom',
    name: '账单提醒',
    prompt: '如果邮件是账单，告诉我金额与到期日。',
    enabled: true,
    priority: 100,
    fallback: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  }
}

describe('mailTypes 仓库', () => {
  it('自定义类型写入后读得回来', async () => {
    await upsertMailTypeRecord(custom())

    const loaded = await readMailTypeRecord('custom:budget')
    expect(loaded?.name).toBe('账单提醒')
    expect(loaded?.kind).toBe('custom')
    expect(loaded?.priority).toBe(100)
  })

  it('内置 override 只保存 enabled / userPrompt', async () => {
    await upsertMailTypeRecord({
      id: BUILTIN_CODE_ID,
      kind: 'builtin',
      enabled: false,
      userPrompt: '两个验证码时只用 A',
      createdAt: 1,
      updatedAt: 1,
    })

    const loaded = await readMailTypeRecord(BUILTIN_CODE_ID)
    expect(loaded?.kind).toBe('builtin')
    expect(loaded?.enabled).toBe(false)
    expect(loaded?.userPrompt).toBe('两个验证码时只用 A')
    // 内置的名称 / 提示词 / 优先级不进记录
    expect(loaded?.name).toBeUndefined()
    expect(loaded?.priority).toBeUndefined()
  })

  it('删掉内置 override = 恢复默认', async () => {
    await upsertMailTypeRecord({
      id: BUILTIN_SUMMARY_ID,
      kind: 'builtin',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    })

    const customMode = resolveMailTypeAdapters(await listMailTypeRecords(), { minimalMode: false, lang: 'zh' })
    expect(customMode.find(adapter => adapter.id === BUILTIN_SUMMARY_ID)?.enabled).toBe(false)

    await deleteMailTypeRecord(BUILTIN_SUMMARY_ID)
    const after = resolveMailTypeAdapters(await listMailTypeRecords(), { minimalMode: false, lang: 'zh' })
    expect(after.find(adapter => adapter.id === BUILTIN_SUMMARY_ID)?.enabled).toBe(true)
  })

  it('极简模式强制只生效 code + confirm（不修改保存的状态）', async () => {
    await upsertMailTypeRecord(custom())
    await upsertMailTypeRecord({
      id: BUILTIN_CODE_ID,
      kind: 'builtin',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    })

    const records = await listMailTypeRecords()
    const minimal = resolveMailTypeAdapters(records, { minimalMode: true, lang: 'zh' })
    expect(minimal.find(adapter => adapter.id === BUILTIN_CODE_ID)?.enabled).toBe(true)
    expect(minimal.find(adapter => adapter.id === BUILTIN_CONFIRM_ID)?.enabled).toBe(true)
    expect(minimal.find(adapter => adapter.id === BUILTIN_SUMMARY_ID)?.enabled).toBe(false)
    expect(minimal.find(adapter => adapter.id === 'custom:budget')?.enabled).toBe(false)

    // 切回自定义：之前保存的「验证码关闭」还在
    const customMode = resolveMailTypeAdapters(records, { minimalMode: false, lang: 'zh' })
    expect(customMode.find(adapter => adapter.id === BUILTIN_CODE_ID)?.enabled).toBe(false)
  })

  it('自定义类型上下移动会重排 priority', async () => {
    await upsertMailTypeRecord(custom({ id: 'custom:a', priority: 100, createdAt: 1 }))
    await upsertMailTypeRecord(custom({ id: 'custom:b', priority: 110, createdAt: 2 }))
    await upsertMailTypeRecord(custom({ id: 'custom:c', priority: 120, createdAt: 3 }))

    await moveCustomMailType('custom:c', 'up')

    const records = await listMailTypeRecords()
    expect(records.filter(record => record.kind === 'custom').map(record => record.id))
      .toEqual(['custom:a', 'custom:c', 'custom:b'])
  })

  it('nextCustomPriority 接在现有最大值之后', () => {
    expect(nextCustomPriority([])).toBe(100)
    expect(nextCustomPriority([
      custom({ id: 'custom:a', priority: 100 }),
      custom({ id: 'custom:b', priority: 130 }),
    ])).toBe(140)
  })
})
