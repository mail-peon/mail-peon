import { beforeEach, expect, it, vi } from 'vitest'

type Handler = (message: { data: unknown }) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  installed: vi.fn(),
  startup: vi.fn(),
  alarm: vi.fn(),
  ensure: vi.fn(),
  watch: vi.fn(),
  purge: vi.fn(),
  sync: vi.fn(),
  chain: vi.fn(),
  ready: vi.fn(),
  broadcast: vi.fn(),
}))
vi.mock('webext-bridge/background', () => ({ onMessage: (name: string, handler: Handler) => mocks.handlers.set(name, handler) }))
vi.mock('../contentScriptHMR', () => ({}))
vi.mock('webextension-polyfill', () => ({ default: {
  runtime: { onInstalled: { addListener: mocks.installed }, onStartup: { addListener: mocks.startup } },
  alarms: { onAlarm: { addListener: mocks.alarm } },
} }))
vi.mock('../runtime/maintenance', () => ({ ensureAlarm: mocks.ensure, purgeExpiredCodes: mocks.purge, SYNC_ALARM: 'mail-peon:sync' }))
vi.mock('../runtime/watch', () => ({ restartWatchChannels: mocks.watch }))
vi.mock('../runtime/sync', () => ({ syncOnce: mocks.sync, syncAfterCurrent: mocks.chain }))
vi.mock('../runtime/pipeline', () => ({ hooksFor: vi.fn(), ruleCache: { invalidate: vi.fn() } }))
vi.mock('~/logic/store/ready', () => ({ ensureStoreReady: mocks.ready, resetStoreReadyForTests: vi.fn(), withReady: (fn: unknown) => fn }))
vi.mock('~/logic/notification/badge', () => ({ refreshBadge: vi.fn(), clearBadge: vi.fn() }))
vi.mock('~/logic/messaging', () => ({ broadcastToExtension: mocks.broadcast }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.ready.mockResolvedValue(undefined)
  mocks.chain.mockResolvedValue({ started: true, value: [] })
})

it('registers all request and lifecycle listeners before cold start recovery', async () => {
  const names = ['mail:list', 'mail:dismiss', 'mail:mark-all-read', 'mail:copy-code', 'mail:manual-copy-result', 'trash:list', 'trash:trash', 'trash:restore', 'trash:delete', 'trash:empty', 'accounts:list', 'accounts:upsert', 'accounts:delete', 'accounts:test', 'accounts:reset-cursor', 'accounts:sync-now', 'accounts:sync-status', 'accounts:gmail-authorize', 'rules:list', 'rules:upsert', 'rules:delete', 'rules:move', 'mail-types:list', 'mail-types:update', 'mail-types:create', 'mail-types:delete', 'mail-types:reset', 'mail-types:move', 'settings:get', 'settings:set-app', 'settings:set-ai', 'settings:usage', 'settings:clear-mails', 'settings:clear-all', 'ai:test', 'ai:platforms', 'mail:providers']
  mocks.watch.mockImplementation(() => {
    expect([...mocks.handlers.keys()].sort()).toEqual(names.sort())
    expect(mocks.startup).toHaveBeenCalledTimes(1)
    expect(mocks.alarm).toHaveBeenCalledTimes(1)
    return new Promise<void>(() => {})
  })
  await import('../main')
  expect(mocks.watch).toHaveBeenCalledTimes(1)
  expect(mocks.ensure).toHaveBeenCalledTimes(1)
  mocks.startup.mock.calls[0][0]()
  mocks.installed.mock.calls[0][0]()
  expect(mocks.watch).toHaveBeenCalledTimes(3)
  mocks.alarm.mock.calls[0][0]({ name: 'other' })
  expect(mocks.chain).not.toHaveBeenCalled()
  mocks.alarm.mock.calls[0][0]({ name: 'mail-peon:sync' })
  expect(mocks.chain).toHaveBeenCalledTimes(1)
  expect(mocks.purge).toHaveBeenCalledTimes(1)
})

it('acknowledges manual sync immediately and exposes its eventual result for polling', async () => {
  let finish!: (value: { value: string[] }) => void
  mocks.sync.mockReturnValue(new Promise((resolve) => {
    finish = resolve
  }))
  await import('../main')
  const invoke = (name: string) => mocks.handlers.get(name)!({ data: undefined })
  expect(await invoke('accounts:sync-status')).toBeNull()
  expect(await invoke('accounts:sync-now')).toEqual({ started: true })
  expect(await invoke('accounts:sync-status')).toBeNull()
  finish({ value: ['done'] })
  await vi.waitFor(() => expect(mocks.broadcast).toHaveBeenCalledWith('sync:done', expect.objectContaining({ ok: true, results: ['done'] })))
  expect(await invoke('accounts:sync-status')).toEqual({ ok: true, results: ['done'], finishedAt: expect.any(Number) })
})
