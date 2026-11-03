import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cycle: vi.fn(),
  buildPipeline: vi.fn(() => ({ process: vi.fn() })),
  hooksFor: vi.fn(),
}))
vi.mock('../sync', () => ({ runSyncCycle: mocks.cycle }))
vi.mock('../runtime/pipeline', () => ({ buildPipeline: mocks.buildPipeline, hooksFor: mocks.hooksFor }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

it('watch and manual requests reuse the running cycle while an alarm queues a later cycle', async () => {
  let finish!: (value: string[]) => void
  mocks.cycle.mockReturnValueOnce(new Promise<string[]>((resolve) => {
    finish = resolve
  })).mockResolvedValueOnce(['next'])
  const { syncOnce, syncAfterCurrent } = await import('../runtime/sync')
  const manual = syncOnce()
  const watch = syncOnce()
  const alarm = syncAfterCurrent()
  expect(mocks.cycle).toHaveBeenCalledTimes(1)
  expect(mocks.cycle).toHaveBeenCalledWith({ pipeline: mocks.buildPipeline.mock.results[0].value, hooksFor: mocks.hooksFor })
  finish(['current'])
  expect(await manual).toEqual({ started: true, value: ['current'] })
  expect(await watch).toEqual({ started: false, value: ['current'] })
  expect(await alarm).toEqual(['next'])
  expect(mocks.cycle).toHaveBeenCalledTimes(2)
})

it('a failed cycle releases the gate for the next request', async () => {
  mocks.cycle.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
  const { syncOnce } = await import('../runtime/sync')
  await expect(syncOnce()).rejects.toThrow('offline')
  await expect(syncOnce()).resolves.toEqual({ started: true, value: [] })
})
