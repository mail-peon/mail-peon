import type { MailAccount } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { createDefaultAiSettings, createDefaultAppSettings } from '~/logic/types'
import { createSettingsBackup, parseSettingsBackup } from '../settings-backup'

const account: MailAccount = {
  id: 'original',
  email: 'me@example.com',
  label: 'mail',
  provider: 'imap',
  config: { pass: 'password', refreshToken: 'refresh', accessToken: 'access', host: 'imap.example.com' },
  cursor: { uid: 77 },
  lastSyncedAt: 100,
  lastError: 'old error',
  blockedList: [],
  enabled: true,
  createdAt: 1,
}

it('导出去掉凭据和本机同步位置并保留原账号', () => {
  const backup = createSettingsBackup(createDefaultAppSettings(), { ...createDefaultAiSettings(), apiKey: 'key' }, [account])
  expect(backup.ai.apiKey).toBe('')
  expect(backup.accounts[0].config).toEqual({ host: 'imap.example.com' })
  expect(backup.accounts[0].cursor).toBeNull()
  expect(backup.accounts[0].lastError).toBeUndefined()
  expect(account.config.pass).toBe('password')
  expect(account.cursor).toEqual({ uid: 77 })
})

it('旧版文件支持局部设置且不会补写未提供的默认项', () => {
  const backup = parseSettingsBackup({ kind: 'mail-peon-settings', app: { notifyOnNew: false }, accounts: [account] })
  expect(backup.app).toEqual({ notifyOnNew: false })
  expect(backup.accounts[0].id).toBe('original')
})

describe('备份边界校验', () => {
  it.each([
    null,
    { kind: 'other' },
    { kind: 'mail-peon-settings', version: 2 },
    { kind: 'mail-peon-settings', app: null },
    { kind: 'mail-peon-settings', app: { notifyOnNew: 'false' } },
    { kind: 'mail-peon-settings', accounts: {} },
    { kind: 'mail-peon-settings', accounts: [{ ...account, email: 42 }] },
    { kind: 'mail-peon-settings', accounts: [{ ...account, config: [] }] },
  ])('拒绝无法安全导入的数据 %#', (raw) => {
    expect(() => parseSettingsBackup(raw)).toThrow()
  })
})
