import type { AiSettings, AppSettings, MailAccount } from '~/logic/types'
import { normalizeAccount, normalizeAppSettings } from '~/logic/store/migrations'
import { createDefaultAppSettings, MAIL_RETENTION_OPTIONS } from '~/logic/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stripSecrets(config: MailAccount['config']) {
  const result = { ...config }
  for (const key of ['pass', 'refreshToken', 'accessToken', 'apiKey'])
    delete (result as Record<string, unknown>)[key]
  return result
}

export function createSettingsBackup(app: AppSettings, ai: AiSettings, accounts: MailAccount[]) {
  return {
    kind: 'mail-peon-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    app,
    ai: { ...ai, apiKey: '' },
    accounts: accounts.map(account => ({
      ...account,
      config: stripSecrets(account.config),
      cursor: null,
      lastSyncedAt: undefined,
      lastError: undefined,
    })),
  }
}

/** Validate the entire backup before any settings or accounts are written. */
export function parseSettingsBackup(raw: unknown): { app?: Partial<AppSettings>, accounts: MailAccount[] } {
  if (!isRecord(raw) || raw.kind !== 'mail-peon-settings')
    throw new Error('这个文件不是 mail-peon 导出的设置')
  if (raw.version !== undefined && raw.version !== 1)
    throw new Error('不支持这个设置文件的版本')
  let app: Partial<AppSettings> | undefined
  if (raw.app !== undefined) {
    if (!isRecord(raw.app))
      throw new Error('设置内容格式不正确')
    const rawApp = raw.app
    const defaults = createDefaultAppSettings()
    for (const [key, value] of Object.entries(rawApp)) {
      if (!Object.hasOwn(defaults, key))
        continue
      if (key === 'mailRetention') {
        if (!MAIL_RETENTION_OPTIONS.includes(value as AppSettings['mailRetention']))
          throw new Error('邮件保留数量格式不正确')
      }
      else if (typeof value !== typeof defaults[key as keyof AppSettings] || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`设置字段「${key}」格式不正确`)
      }
    }
    const normalized = normalizeAppSettings(rawApp)
    app = Object.fromEntries(Object.entries(normalized).filter(([key]) => Object.hasOwn(rawApp, key)))
  }
  if (raw.accounts !== undefined && !Array.isArray(raw.accounts))
    throw new Error('账号列表格式不正确')
  const accounts = (raw.accounts ?? []).map((value: unknown, index: number) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
      || typeof value.email !== 'string' || !value.email.trim()
      || (value.config !== undefined && !isRecord(value.config))) {
      throw new Error(`第 ${index + 1} 个账号格式不正确`)
    }
    const account = normalizeAccount(value)
    if (!account)
      throw new Error(`第 ${index + 1} 个账号格式不正确`)
    return account
  })
  return { app, accounts }
}
