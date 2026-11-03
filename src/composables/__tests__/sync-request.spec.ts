import type { SyncDonePayload } from '~/logic/types'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { useSyncRequest } from '../useSyncRequest'

const events = vi.hoisted(() => ({
  listener: null as ((result: import('~/logic/types').SyncDonePayload) => void) | null,
  unsubscribe: vi.fn(),
}))
vi.mock('~/logic/bridge', () => ({
  onSyncDone(listener: (result: SyncDonePayload) => void) {
    events.listener = listener
    return events.unsubscribe
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mountRequest(overrides: Partial<Parameters<typeof useSyncRequest>[0]> = {}) {
  const options = {
    start: vi.fn(async () => ({ started: true, startedAt: Date.now() })),
    status: vi.fn(async (): Promise<SyncDonePayload | null> => null),
    timeoutMs: 6000,
    onDone: vi.fn(),
    onTimeout: vi.fn(),
    ...overrides,
  }
  let state!: ReturnType<typeof useSyncRequest>
  const wrapper = mount(defineComponent({
    setup() {
      state = useSyncRequest(options)
      return () => null
    },
  }))
  return { wrapper, state, options }
}

beforeEach(() => {
  vi.useFakeTimers()
  events.unsubscribe.mockClear()
})
afterEach(() => vi.useRealTimers())

it('慢状态请求不会重叠且广播和轮询结果只处理一次', async () => {
  const pending = deferred<SyncDonePayload | null>()
  const status = vi.fn(() => pending.promise)
  const { wrapper, state, options } = mountRequest({ status, timeoutMs: 30_000 })
  await state.start()
  vi.advanceTimersByTime(1500)
  await flushPromises()
  vi.advanceTimersByTime(5000)
  expect(status).toHaveBeenCalledOnce()
  const result = { ok: true, results: [], finishedAt: Date.now() }
  events.listener?.(result)
  pending.resolve(result)
  await flushPromises()
  expect(options.onDone).toHaveBeenCalledOnce()
  expect(state.syncing.value).toBe(false)
  wrapper.unmount()
})

it('卸载后返回的启动响应不会再安排查询', async () => {
  const pending = deferred<{ started: boolean }>()
  const { wrapper, state, options } = mountRequest({ start: () => pending.promise })
  const starting = state.start()
  wrapper.unmount()
  pending.resolve({ started: true })
  await starting
  vi.advanceTimersByTime(10_000)
  expect(options.status).not.toHaveBeenCalled()
  expect(events.unsubscribe).toHaveBeenCalledOnce()
})

it('旧同步结果不会结束当前请求且等待有时间上限', async () => {
  const { wrapper, state, options } = mountRequest({ timeoutMs: 3000 })
  await state.start()
  events.listener?.({ ok: true, results: [], finishedAt: Date.now() - 1 })
  expect(state.syncing.value).toBe(true)
  vi.advanceTimersByTime(3000)
  await flushPromises()
  expect(state.syncing.value).toBe(false)
  expect(options.onDone).not.toHaveBeenCalled()
  expect(options.onTimeout).toHaveBeenCalledOnce()
  wrapper.unmount()
})

it('启动确认之前到达的结果也能结束等待', async () => {
  const pending = deferred<{ started: boolean }>()
  const { wrapper, state, options } = mountRequest({ start: () => pending.promise })
  const starting = state.start()
  events.listener?.({ ok: true, results: [], finishedAt: Date.now() })
  pending.resolve({ started: true })
  await starting
  vi.advanceTimersByTime(10_000)
  expect(options.status).not.toHaveBeenCalled()
  expect(options.onDone).toHaveBeenCalledOnce()
  wrapper.unmount()
})
