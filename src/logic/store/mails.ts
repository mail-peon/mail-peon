import type { AppSettings, Mail, RetentionLimit, StorageUsage } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { accountIdOfMailKey, MINIMAL_RETENTION } from '~/logic/types'
import { clearStore, count, del, get, iterate, put, runTx } from '~/platform/idb/database'
import { normalizeMail } from './migrations'
import { pruneMails, RETENTION_INDEX } from './prune'
import { withReady } from './ready'
import { readAppSettings } from './settings'

/**
 * 邮件仓库（`mails`，外部键 `<accountId>:<messageId>`）。
 *
 * 两条契约写在文件头，因为它们是这个仓库全部复杂度的来源：
 *
 * 1. **滚动淘汰**：超出保留数量就删最旧的。上限 = `AppSettings.mailRetention`，
 *    但极简模式**写死** `MINIMAL_RETENTION`（50 条验证码）—— 极简模式不暴露这个
 *    设置项（`design/minimal-mode.md § 3.5`）。
 * 2. **写入与淘汰必须在同一个事务里**，见 `upsertMail`。
 *
 * 淘汰的实现本身在 `./prune.ts`（单独一个模块是为了打断与 `ready.ts` 的循环依赖，
 * 那里有详细说明）。
 */

/** 真实保留上限（区分两种模式） */
export function retentionLimit(app: Pick<AppSettings, 'minimalMode' | 'mailRetention'>): RetentionLimit {
  return app.minimalMode ? MINIMAL_RETENTION : app.mailRetention
}

export const readMail = withReady(async (id: string): Promise<Mail | undefined> => {
  const raw = await get<unknown>('mails', id)
  if (raw === undefined)
    return undefined
  return normalizeMail(raw, id) ?? undefined
})

/**
 * 读最近 N 封（按 `receivedAt` 倒序）。
 *
 * 用 `by-receivedAt` 索引倒序游标 + `limit`：邮件量大时只碰需要的那些条目，
 * 不会把整表读进内存再排序。
 */
export const readRecentMails = withReady(async (limit = 200): Promise<Mail[]> => {
  const out: Mail[] = []
  await iterate<unknown>(
    'mails',
    { index: RETENTION_INDEX, direction: 'prev', limit },
    (value, key) => {
      const mail = normalizeMail(value, String(key))
      if (mail)
        out.push(mail)
    },
  )
  return out
})

/** 读某个账号的邮件（走 `by-accountId` 索引），同样按时间倒序 */
export const readMailsByAccount = withReady(async (accountId: string, limit = 200): Promise<Mail[]> => {
  const out: Mail[] = []
  await iterate<unknown>(
    'mails',
    { index: 'by-accountId', range: IDBKeyRange.only(accountId) },
    (value, key) => {
      const mail = normalizeMail(value, String(key))
      if (mail)
        out.push(mail)
    },
  )
  return out.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit)
})

/**
 * 写入一封邮件并在**同一个事务**里滚动淘汰。
 *
 * ⚠ `readAppSettings()` 必须在事务**外**读（见 `platform/idb/database.ts` 头部
 *   第 1 条规矩）：事务里读 IDB 会自己开一个新事务，外层 readwrite 随即失活，
 *   紧接着带 `ctx` 的写就抛 `InvalidStateError`。
 *
 * `retentionOverride` 让调用方（极简流水线）显式指定上限；不传则按当前设置算。
 */
export const upsertMail = withReady(async (mail: Mail, retentionOverride?: RetentionLimit): Promise<void> => {
  const normalized = normalizeMail(mail, mail.id)
  if (!normalized)
    throw new Error('邮件缺少 id / accountId，无法写入')

  const retention = retentionOverride ?? retentionLimit(await readAppSettings())

  await runTx(['mails'], 'readwrite', async (ctx) => {
    await put('mails', normalized, normalized.id, ctx)
    await pruneMails(ctx, retention)
  })
})

/**
 * 滚动淘汰（实现在 `./prune.ts`）。
 *
 * 这里只做转发，让 `mails.ts` 的调用方不用知道它住在哪个文件 —— 它是这个仓库的
 * 一部分，只是物理上被挪走了（为了打断循环依赖）。
 */
export { pruneMails }

/**
 * 按当前设置淘汰一次（Options 里「调整保留数量 → 立刻生效」用）。
 *
 * 设计文档说「调整上限时下次写才触发淘汰」，同时允许在应用按钮里手动调一次 ——
 * 这个函数就是那个手动入口。
 */
export const pruneMailsNow = withReady(async (): Promise<number> => {
  const app = await readAppSettings()
  return runTx(['mails'], 'readwrite', ctx => pruneMails(ctx, retentionLimit(app)))
})

/** 标记已读 / 未读 */
export const setMailRead = withReady(async (id: string, read: boolean): Promise<Mail | undefined> => {
  const mail = await readMail(id)
  if (!mail)
    return undefined
  const next: Mail = { ...mail, read }
  await runTx(['mails'], 'readwrite', ctx => put('mails', next, next.id, ctx))
  return next
})

/** 用户标记「不再显示」 */
export const dismissMail = withReady(async (id: string): Promise<Mail | undefined> => {
  const mail = await readMail(id)
  if (!mail)
    return undefined
  const next: Mail = { ...mail, dismissed: true, read: true }
  await runTx(['mails'], 'readwrite', ctx => put('mails', next, next.id, ctx))
  return next
})

/** 把当前窗口里所有未读标为已读（打开 Popup 时 badge 归零用） */
export const markAllRead = withReady(async (ids?: string[]): Promise<number> => {
  const mails = ids?.length
    ? (await Promise.all(ids.map(id => readMail(id)))).filter((mail): mail is Mail => !!mail)
    : await readRecentMails(1000)

  const unread = mails.filter(mail => !mail.read)
  if (!unread.length)
    return 0

  await runTx(['mails'], 'readwrite', async (ctx) => {
    for (const mail of unread)
      await put('mails', { ...mail, read: true }, mail.id, ctx)
  })
  return unread.length
})

/** 记录验证码复制结果（「再复制一次」成功后回写） */
export const setCopyStatus = withReady(async (id: string, copyStatus: Mail['copyStatus']): Promise<Mail | undefined> => {
  const mail = await readMail(id)
  if (!mail)
    return undefined
  const next: Mail = { ...mail, copyStatus }
  await runTx(['mails'], 'readwrite', ctx => put('mails', next, next.id, ctx))
  return next
})

export const countMails = withReady((): Promise<number> => count('mails'))

export const clearMails = withReady((ctx?: TxContext): Promise<void> => clearStore('mails', ctx))

/**
 * 存储用量估算（Options · 通用设置展示「X 条 / Y 上限，约 Z MB」）。
 *
 * **不是真实占用**，但数量级正确；真实值要 `navigator.storage.estimate()`
 * （见 `realQuota`）。按 UTF-16 长度 × 2 估：IDB 里字符串本身按 UTF-16 存，
 * 这个估算对中文邮件尤其接近。
 */
export const estimateStorageUsage = withReady(async (): Promise<StorageUsage> => {
  const usage: StorageUsage = { count: 0, bytesApprox: 0, byAccount: {} }
  await iterate<unknown>('mails', {}, (value, key) => {
    const mail = normalizeMail(value, String(key))
    if (!mail)
      return
    const size = (mail.subject.length * 2)
      + ((mail.bodyText?.length ?? 0) * 2)
      + (mail.snippet.length * 2)
      + JSON.stringify(mail).length
    usage.count++
    usage.bytesApprox += size
    const bucket = usage.byAccount[mail.accountId] ??= { count: 0, bytesApprox: 0 }
    bucket.count++
    bucket.bytesApprox += size
  })
  return usage
})

/** 真实磁盘占用（可选增强；IDB 结构化克隆 + 索引开销让它比上面的估算大） */
export async function realQuota(): Promise<{ usage: number, quota: number } | null> {
  if (!globalThis.navigator?.storage?.estimate)
    return null
  try {
    const estimate = await navigator.storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  }
  catch {
    return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 清空某个账号的邮件（删除账号时连带清）。
 *
 * 走 `by-accountId` 索引而不是全表扫描 —— 多账号时全表扫会把别的账号的邮件
 * 也读进来判断，纯属浪费。
 */
export const clearMailsByAccount = withReady(async (accountId: string): Promise<number> => {
  let removed = 0
  await runTx(['mails'], 'readwrite', async (ctx) => {
    await iterate<Mail>(
      'mails',
      { index: 'by-accountId', range: IDBKeyRange.only(accountId) },
      (_value, key) => {
        void del('mails', key, ctx)
        removed++
      },
      ctx,
    )
  })
  return removed
})

/** 兜底去重：server 没给 messageId 时同一封邮件可能被拉两次（subject + receivedAt 相同） */
export const findMailBySubjectTime = withReady(async (accountId: string, subject: string, receivedAt: number): Promise<Mail | undefined> => {
  const mails = await readMailsByAccount(accountId)
  return mails.find(mail => mail.subject === subject && Math.abs(mail.receivedAt - receivedAt) < 60_000)
})

export { accountIdOfMailKey }
