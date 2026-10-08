import type { AppSettings, SyncSummary } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「同步中」必须**一定会结束** —— 哪怕 `sync:done` 广播丢了。
 *
 * ## 这一组对应一个真机故障
 *
 * 现象：点「立即同步增量」后界面永远停在「同步中」，**没有任何错误**；
 * 而中继日志显示同步其实是成功的（`LOGIN` → `SELECT` → `UID SEARCH` → `LOGOUT`）。
 *
 * 根因：结束后只通过 `sync:done` **广播**通知 UI，而广播的送达依赖 background 侧
 * `connMap` 里有没有对应端点 —— 那个条目只在对方握手完成后才有。于是
 * 「页面在 background 重载之前就连上了」「同一 context 有多个连接」「端点名对不上」
 * 这三种情况都会让消息**静默消失**，`busy` 就永远停在 `true`。
 *
 * 修法：点击之后一边等广播、一边按间隔问 `accounts:sync-status`（轮询兜底）。
 *
 * ## 测试策略
 *
 * 这里刻意**不去**模拟整个 `webext-bridge` 往返（那会把测试变成对库的测试），
 * 而是把 `~/logic/bridge` 整个 mock 掉，只保留它的**接口语义**：
 * `syncNow()` 立即返回、`onSyncDone()` 注册监听、`syncStatus()` 问一次。
 * 于是「广播丢了会怎样」变成一句话：**注册的监听器不调用**。
 */

/** 被测组件用到的那些 composable 的假实现 */
const mocks = vi.hoisted(() => {
  /** `onSyncDone` 注册进来的监听器 —— 测试可以决定要不要调用它们 */
  const syncListeners: Array<(result: { ok: boolean, results: unknown[], error?: string }) => void> = []
  const dataListeners: Array<() => void> = []

  /** `accounts:sync-status` 会被问到的结果队列（每次调用弹一个） */
  const statusQueue: unknown[] = []

  return {
    syncListeners,
    dataListeners,
    statusQueue,
    syncNow: vi.fn(async () => ({ started: true, startedAt: Date.now() })),
    syncStatus: vi.fn(async () => statusQueue.shift() ?? null),
    reloadAccounts: vi.fn(async () => {}),
    send: vi.fn(async () => ({ usage: { count: 0, bytesApprox: 0 } })),
    setApp: vi.fn(async () => {}),
  }
})

vi.mock('~/logic/bridge', () => ({
  onSyncDone: (listener: (result: { ok: boolean, results: unknown[], error?: string }) => void) => {
    mocks.syncListeners.push(listener)
    return () => {
      const index = mocks.syncListeners.indexOf(listener)
      if (index >= 0)
        mocks.syncListeners.splice(index, 1)
    }
  },
  onDataChanged: (listener: () => void) => {
    mocks.dataListeners.push(listener)
    return () => {}
  },
  send: mocks.send,
  useAccounts: () => ({
    accounts: { value: [{ id: 'a1', label: '个人邮箱', enabled: true }] },
    syncNow: mocks.syncNow,
    syncStatus: mocks.syncStatus,
    reload: mocks.reloadAccounts,
  }),
  useSettings: () => ({
    app: { value: { minimalMode: false, mailRetention: 100 } as AppSettings },
    ai: { value: { apiKey: 'k', platform: 'openai' } },
    setApp: mocks.setApp,
    reload: vi.fn(async () => {}),
  }),
}))

/**
 * 被测组件必须在 `vi.mock` **之后**才 import —— `vi.mock` 是提升的，但静态
 * `import` 也会被提升到它前面，所以这里用 `beforeAll` 里的动态 import
 * 把顺序钉死。
 *
 * ⚠ 不用顶层 `await`：那要求 tsconfig 的 `target` 至少 es2017，
 *   而产物代码的 target 是 es2016（要兼容浏览器），不该为了一个测试文件改它。
 */
let GeneralPage: import('vue').Component
beforeAll(async () => {
  GeneralPage = (await import('~/options/pages/GeneralPage.vue')).default
})

function summary(patch: Partial<SyncSummary> = {}): SyncSummary {
  return { accountId: 'a1', label: '个人邮箱', firstSync: false, fetched: 0, blocked: 0, failed: 0, ...patch }
}

/** 挂在 `document.body` 上而不是游离节点：组件里用了 `window.setInterval` */
function mountPage() {
  return mount(GeneralPage, { attachTo: document.body })
}

/** 找到「立即同步增量」按钮 */
function syncButton(wrapper: ReturnType<typeof mountPage>) {
  const button = wrapper.findAll('button').find(item => item.text().includes('立即同步'))
  if (!button)
    throw new Error('没找到「立即同步」按钮 —— 模板改了？')
  return button
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++)
    await Promise.resolve()
}

describe('同步中一定会结束', () => {
  beforeEach(() => {
    mocks.syncListeners.length = 0
    mocks.dataListeners.length = 0
    mocks.statusQueue.length = 0
    mocks.syncNow.mockClear()
    mocks.syncStatus.mockClear()
    vi.useRealTimers()
  })

  it('广播正常到达：显示结果，且不再轮询', async () => {
    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    expect(mocks.syncNow).toHaveBeenCalled()
    expect(mocks.syncListeners).toHaveLength(1)

    // 后台广播结果
    mocks.syncListeners[0]({ ok: true, results: [summary({ fetched: 3 })] })
    await flush()

    const text = wrapper.text()
    expect(text).toContain('拉取 3 封')
    expect(text).not.toContain('同步失败')

    wrapper.unmount()
  })

  /*
   * ⚠ 这一条是本次修复的核心断言。
   *
   * 「广播丢了」在测试里就是：注册的监听器**不调用**。
   * 修之前，这种情况下 `busy` 永远是 true，界面永远显示「同步中」。
   */
  it('广播丢失：轮询兜底仍然把「同步中」结束掉', async () => {
    vi.useFakeTimers()

    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    // 后台已经完成，但**不**调监听器（模拟广播静默消失）
    mocks.statusQueue.push({
      ok: true,
      results: [summary({ fetched: 5 })],
      finishedAt: Date.now() + 1,
    })

    // 推进到第一次轮询
    await vi.advanceTimersByTimeAsync(1600)
    await flush()

    expect(mocks.syncStatus).toHaveBeenCalled()
    const text = wrapper.text()
    expect(text).toContain('拉取 5 封')
    expect(text).not.toContain('同步中')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('上一轮的结果不算数（finishedAt 早于本次点击时继续等）', async () => {
    vi.useFakeTimers()

    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    /*
     * ⚠ 这条守卫很重要：`accounts:sync-status` 返回的是**最近一轮**的结果。
     *   本次点击的同步还没跑完时，它会给到上一轮的 —— 直接拿它收尾会让界面
     *   显示过期的数字，而用户以为那是刚才那次的结果。
     */
    mocks.statusQueue.push({
      ok: true,
      results: [summary({ fetched: 99 })],
      finishedAt: 1, // 远古时刻
    })

    await vi.advanceTimersByTimeAsync(1600)
    await flush()

    expect(wrapper.text()).not.toContain('拉取 99 封')
    // 仍在等：下一次轮询要有东西可拿
    mocks.statusQueue.push({ ok: true, results: [summary({ fetched: 2 })], finishedAt: Date.now() + 1 })
    await vi.advanceTimersByTimeAsync(1600)
    await flush()

    expect(wrapper.text()).toContain('拉取 2 封')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('后台报错时如实显示原因，而不是「没有启用的账号」', async () => {
    vi.useFakeTimers()

    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    mocks.statusQueue.push({
      ok: false,
      results: [],
      error: 'IMAP 服务器响应超时',
      finishedAt: Date.now() + 1,
    })

    await vi.advanceTimersByTimeAsync(1600)
    await flush()

    const text = wrapper.text()
    expect(text).toContain('同步失败')
    expect(text).toContain('IMAP 服务器响应超时')
    // 这句话只该在「真的没有启用账号」时出现，不能拿来当万能兜底
    expect(text).not.toContain('请先在「账号」页添加')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('超过 6 分钟仍未返回：给出超时提示并结束「同步中」', async () => {
    vi.useFakeTimers()

    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    // 一直不返回
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 3000)
    await flush()

    const text = wrapper.text()
    expect(text).toContain('仍未返回')
    expect(text).not.toContain('同步中')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('组件卸载后停止轮询（不会一直问下去）', async () => {
    vi.useFakeTimers()

    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    const callsBeforeUnmount = mocks.syncStatus.mock.calls.length
    wrapper.unmount()

    await vi.advanceTimersByTimeAsync(10000)
    await flush()

    expect(mocks.syncStatus.mock.calls.length).toBe(callsBeforeUnmount)
    vi.useRealTimers()
  })
})
