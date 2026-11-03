import type { MailAccount, MailProviderId, SyncCursor } from '~/logic/types'
import { asObject, bool, num, optionalStr, str } from './common'
import { normalizeBlockedList } from './matching'
// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

export const KNOWN_PROVIDERS: readonly string[] = ['imap', 'gmail', 'outlook', 'eml']

export function normalizeAccount(raw: unknown, fallbackKey?: string): MailAccount | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '')
  if (!id)
    return null

  const provider = str(value.provider, 'imap')
  const config = asObject(value.config)

  return {
    id,
    label: str(value.label) || str(value.email).trim().toLowerCase(),
    // 邮箱一律小写：`by-email` 索引与「按邮箱查账号」都依赖这个规范化。
    // 不做的话，用户填 `Me@Example.COM` 之后按小写查不到自己的账号
    email: str(value.email).trim().toLowerCase(),
    provider: (KNOWN_PROVIDERS.includes(provider) ? provider : 'imap') as MailProviderId,
    config: {
      host: optionalStr(config.host),
      port: config.port === undefined ? undefined : num(config.port, 993),
      tls: config.tls === undefined ? undefined : bool(config.tls, true),
      user: optionalStr(config.user),
      pass: optionalStr(config.pass),
      relayUrl: optionalStr(config.relayUrl),
      clientId: optionalStr(config.clientId),
      refreshToken: optionalStr(config.refreshToken),
      accessToken: optionalStr(config.accessToken),
      expiresAt: config.expiresAt === undefined ? undefined : num(config.expiresAt, 0),
      tenantId: optionalStr(config.tenantId),
    },
    blockedList: normalizeBlockedList(value.blockedList),
    enabled: bool(value.enabled, true),
    createdAt: num(value.createdAt, Date.now()),
    lastSyncedAt: value.lastSyncedAt === undefined ? undefined : num(value.lastSyncedAt, 0),
    lastError: optionalStr(value.lastError),
    cursor: normalizeCursor(value.cursor),
  }
}

/**
 * 游标归一。
 *
 * 兼容设计文档早期形状：`lastSeenUid` / `uidValidity` 曾经是 `MailAccount` 的
 * **顶层字段**，现在收进 `cursor`。存量数据要把它们搬进去，否则老账号第一次
 * 心跳就会被当成「从未同步过」而重新记游标（丢掉一段增量）。
 */
export function normalizeCursor(raw: unknown, legacy?: { lastSeenUid?: unknown, uidValidity?: unknown }): SyncCursor {
  const value = raw === undefined || raw === null ? {} : asObject(raw)
  const cursor: Record<string, unknown> = {}

  const uid = num(value.uid, Number.NaN)
  if (Number.isFinite(uid))
    cursor.uid = uid

  const uidValidity = num(value.uidValidity, Number.NaN)
  if (Number.isFinite(uidValidity))
    cursor.uidValidity = uidValidity

  if (typeof value.historyId === 'string' && value.historyId)
    cursor.historyId = value.historyId

  // 顶层旧字段迁移
  if (legacy) {
    if (cursor.uid === undefined) {
      const legacyUid = num(legacy.lastSeenUid, Number.NaN)
      if (Number.isFinite(legacyUid))
        cursor.uid = legacyUid
    }
    if (cursor.uidValidity === undefined) {
      const legacyValidity = num(legacy.uidValidity, Number.NaN)
      if (Number.isFinite(legacyValidity))
        cursor.uidValidity = legacyValidity
    }
  }

  return Object.keys(cursor).length > 0 ? cursor : null
}

/** 账号是否「没有游标」（首次同步） */
export function hasNoCursor(account: Pick<MailAccount, 'cursor'>): boolean {
  const cursor = account.cursor
  if (!cursor)
    return true
  return Object.keys(cursor).length === 0
}
