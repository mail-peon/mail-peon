import type { MailAccount, SyncCursor } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { clearStore, count, del, get, getAllEntries, iterate, put, runTx } from '~/platform/idb/database'
import { hasNoCursor, normalizeAccount } from './migrations'
import { ensureStoreReady, withReady } from './ready'

/**
 * 账号仓库（`accounts`，外部键 `accountId`）。
 *
 * 外部键是刻意的：`MailAccount` 的字段由 `MAIL_ACCOUNT_FIELDS` 白名单守着，
 * 往记录里塞一个 `key` 字段会被归一化当成未知字段清掉（见 `platform/idb/schema.ts`
 * 的说明）。
 *
 * ⚠ 逻辑上多账号、UI 上单账号（`decisions/open-questions.md` Q6）：这里所有函数
 *   都是「复数」语义，**不允许**为单账号写特判 —— 那是将来加账号切换时最贵的债。
 */

export const readAccount = withReady(async (id: string): Promise<MailAccount | undefined> => {
  const raw = await get<unknown>('accounts', id)
  if (raw === undefined)
    return undefined
  return normalizeAccount(raw, id) ?? undefined
})

/** 读全表（按 `createdAt` 升序，顺序稳定） */
export const listAccounts = withReady(async (): Promise<MailAccount[]> => {
  const entries = await getAllEntries<unknown>('accounts')
  return entries
    .map(({ key, value }) => normalizeAccount(value, String(key)))
    .filter((account): account is MailAccount => account !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
})

/** 只取启用的账号（心跳用） */
export const listEnabledAccounts = withReady(async (): Promise<MailAccount[]> => {
  const accounts = await listAccounts()
  return accounts.filter(account => account.enabled)
})

/** 按邮箱地址查（走 `by-email` 索引） */
export const findAccountByEmail = withReady(async (email: string): Promise<MailAccount | undefined> => {
  const target = email.trim().toLowerCase()
  if (!target)
    return undefined

  let found: MailAccount | undefined
  await iterate<unknown>(
    'accounts',
    { index: 'by-email', range: IDBKeyRange.only(target), limit: 1 },
    (value, key) => {
      found = normalizeAccount(value, String(key)) ?? undefined
    },
  )
  return found
})

export const upsertAccount = withReady(async (account: MailAccount, ctx?: TxContext): Promise<void> => {
  const normalized = normalizeAccount(account, account.id)
  if (!normalized)
    throw new Error('账号缺少 id，无法写入')
  await put('accounts', normalized, normalized.id, ctx)
})

export const deleteAccount = withReady(async (id: string, ctx?: TxContext): Promise<void> => {
  await del('accounts', id, ctx)
})

/**
 * 推进同步游标。
 *
 * 单独一个函数而不是让调用方 `upsertAccount`：心跳每轮都要写游标，而它读到的
 * 账号对象可能已经被别的路径改过（用户在 Options 里改了 label）。只写游标字段，
 * 别的字段原样不动 —— 这样并发改配置不会被游标写入覆盖掉。
 */
export const updateAccountCursor = withReady(async (id: string, cursor: SyncCursor, ctx?: TxContext): Promise<void> => {
  const account = await readAccount(id)
  if (!account)
    return
  await upsertAccount({ ...account, cursor }, ctx)
})

/** 心跳成功：记时间、清错误 */
export const markAccountSynced = withReady(async (id: string, cursor: SyncCursor): Promise<void> => {
  const account = await readAccount(id)
  if (!account)
    return
  await upsertAccount({
    ...account,
    cursor: cursor ?? account.cursor ?? null,
    lastSyncedAt: Date.now(),
    lastError: undefined,
  })
})

/** 心跳失败：只记错误，不动游标（下次重试同一段增量） */
export const markAccountError = withReady(async (id: string, error: string): Promise<void> => {
  const account = await readAccount(id)
  if (!account)
    return
  await upsertAccount({ ...account, lastError: error })
})

export const countAccounts = withReady((): Promise<number> => count('accounts'))

export const clearAccounts = withReady((ctx?: TxContext): Promise<void> => clearStore('accounts', ctx))

/**
 * 「首次同步」判定 —— 设计文档的**核心约束**：首次连上只记游标，不拉任何历史。
 *
 * 暴露出来而不是让编排层自己判 `cursor == null`：这个判定被三处读（心跳、测试连接、
 * UI 提示），散在三处就会有一处写错，而写错的症状是「用户刚加完账号就被灌了
 * 3000 封历史邮件」。
 */
export function isFirstSync(account: Pick<MailAccount, 'cursor'>): boolean {
  return hasNoCursor(account)
}

/** 用事务批量导入（导入设置 / 迁移用） */
export const importAccounts = withReady((accounts: MailAccount[]): Promise<void> => {
  return runTx(['accounts'], 'readwrite', async (ctx) => {
    for (const account of accounts)
      await upsertAccount(account, ctx)
  })
})

export { ensureStoreReady }
