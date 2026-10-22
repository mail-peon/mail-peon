import type { MailTypeRecord } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { BUILTIN_ADAPTERS } from '~/logic/mail-types/catalog'
import { clearStore, del, get, getAllEntries, put, runTx } from '~/platform/idb/database'
import { normalizeMailTypeRecord } from './migrations'
import { withReady } from './ready'

/**
 * 邮件类型适配器仓库（`mailTypes`，外部键 id）。
 *
 * ## 内置不落库
 *
 * 内置定义在 `logic/mail-types/catalog.ts`；这张表只存：
 *   - 内置的**用户覆盖**：`enabled` / `userPrompt`；
 *   - **自定义**适配器：整条记录。
 *
 * 于是「恢复默认」= 删掉那条 override；「清空所有数据」= 删库后重新初始化，
 * 内置自动还在。代价是列表读取时要与 catalog 合并（`resolveMailTypeAdapters`）。
 */

const BUILTIN_IDS = new Set(BUILTIN_ADAPTERS.map(def => def.id))

export function isBuiltinMailTypeId(id: string): boolean {
  return BUILTIN_IDS.has(id as never)
}

export const listMailTypeRecords = withReady(async (): Promise<MailTypeRecord[]> => {
  const entries = await getAllEntries<unknown>('mailTypes')
  return entries
    .map(({ key, value }) => normalizeMailTypeRecord(value, String(key)))
    .filter((record): record is MailTypeRecord => record !== null)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt - b.createdAt)
})

export const readMailTypeRecord = withReady(async (id: string): Promise<MailTypeRecord | undefined> => {
  const raw = await get<unknown>('mailTypes', id)
  if (raw === undefined)
    return undefined
  return normalizeMailTypeRecord(raw, id) ?? undefined
})

export const upsertMailTypeRecord = withReady(async (
  record: MailTypeRecord,
  ctx?: TxContext,
): Promise<void> => {
  const normalized = normalizeMailTypeRecord(record, record.id)
  if (!normalized)
    throw new Error('适配器缺少 id，无法写入')
  await put('mailTypes', normalized, normalized.id, ctx)
})

/** 删除记录（内置 = 恢复默认，自定义 = 真删除） */
export const deleteMailTypeRecord = withReady(async (id: string, ctx?: TxContext): Promise<void> => {
  await del('mailTypes', id, ctx)
})

/**
 * 上下移动自定义适配器。
 *
 * 与规则同一套实现：重排整组后批量写 priority（0..n-1 的间隔 10），
 * 而不是交换两个值 —— 交换在「priority 重复」时会变成空操作。
 * 内置适配器的 priority 固定，不参与重排。
 */
export const moveCustomMailType = withReady(async (
  id: string,
  direction: 'up' | 'down',
): Promise<MailTypeRecord[]> => {
  const records = await listMailTypeRecords()
  const custom = records.filter(record => record.kind === 'custom')
  const index = custom.findIndex(record => record.id === id)
  if (index === -1)
    return records

  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= custom.length)
    return records

  const reordered = [...custom]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(target, 0, moved)

  const now = Date.now()
  const stamped = reordered.map((record, position) => ({
    ...record,
    priority: 100 + position * 10,
    updatedAt: now,
  }))

  await runTx(['mailTypes'], 'readwrite', async (ctx) => {
    for (const record of stamped)
      await upsertMailTypeRecord(record, ctx)
  })

  return stamped
})

export const clearMailTypes = withReady((ctx?: TxContext): Promise<void> => clearStore('mailTypes', ctx))

/** 自定义适配器的下一个 priority（落在确认邮件之后、总结之前） */
export function nextCustomPriority(records: MailTypeRecord[]): number {
  const custom = records.filter(record => record.kind === 'custom')
  if (!custom.length)
    return 100
  return Math.max(...custom.map(record => record.priority ?? 0)) + 10
}
