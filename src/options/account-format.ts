import type { SyncCursor } from '~/logic/types'
import { t } from '~/logic/strings'

/** 描述同步游标（让用户知道「同步到哪了」，而不只是一个时间） */
export function describeCursor(cursor: SyncCursor | undefined): string {
  if (!cursor)
    return '未建立'
  if (typeof cursor.historyId === 'string')
    return `historyId ${cursor.historyId.slice(0, 10)}…`
  if (typeof cursor.uid === 'number')
    return `UID ${cursor.uid}`
  return '已建立'
}

export function relativeTime(ts: number | undefined): string {
  if (!ts)
    return t('accounts.never')
  const diff = Date.now() - ts
  if (diff < 60_000)
    return t('common.justNow')
  if (diff < 3_600_000)
    return t('common.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000)
    return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return new Date(ts).toLocaleString('zh-CN')
}
