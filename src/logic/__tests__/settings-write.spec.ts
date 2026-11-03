import { beforeEach, expect, it, vi } from 'vitest'
import { settingsApp, useSettings } from '../bridge/settings'
import { createDefaultAppSettings } from '../types'

const mocks = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('~/logic/bridge/transport', () => ({ send: mocks.send }))

beforeEach(() => {
  mocks.send.mockReset()
  settingsApp.value = createDefaultAppSettings()
})

it('设置写入失败时返回失败并恢复原值', async () => {
  mocks.send.mockResolvedValue(null)
  const { app, setApp } = useSettings()
  const previous = app.value
  const saving = setApp({ minimalMode: false })
  expect(app.value?.minimalMode).toBe(false)
  expect(await saving).toBe(false)
  expect(app.value).toBe(previous)
})

it('写入失败不会覆盖等待期间到达的新设置', async () => {
  let finish!: (value: null) => void
  mocks.send.mockReturnValue(new Promise((resolve) => {
    finish = resolve
  }))
  const { app, setApp } = useSettings()
  const saving = setApp({ minimalMode: false })
  app.value = { ...createDefaultAppSettings(), checkIntervalMinutes: 20 }
  const broadcast = app.value
  finish(null)
  expect(await saving).toBe(false)
  expect(app.value).toBe(broadcast)
})

it('保存成功以后台返回的规范化值为准', async () => {
  const saved = { ...createDefaultAppSettings(), checkIntervalMinutes: 10 }
  mocks.send.mockResolvedValue({ app: saved })
  const { app, setApp } = useSettings()
  expect(await setApp({ checkIntervalMinutes: 11 })).toBe(true)
  expect(app.value?.checkIntervalMinutes).toBe(10)
})
