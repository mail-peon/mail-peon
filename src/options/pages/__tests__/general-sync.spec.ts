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
 *
 * ⚠ 结果提示走**全局 message**（`logic/ui-message.ts`）而不是页面里的一行文字，
 *   所以这里也把那个模块 mock 掉，断言的是「哪个级别收到了哪句文案」——
 *   这样「故障必须是警告色而不是成功色」才是可测的（见最后两条用例）。
 */

/** 被测组件用到的那些 composable 的假实现 */
const mocks = vi.hoisted(() => {
  /** `onSyncDone` 注册进来的监听器 —— 测试可以决定要不要调用它们 */
  const syncListeners: Array<(result: { ok: boolean, results: unknown[], error?: string }) => void> = []
  const dataListeners: Array<() => void> = []

  /** `accounts:sync-status` 会被问到的结果队列（每次调用弹一个） */
  const statusQueue: unknown[] = []

  /**
   * 全局轻提示的假实现。
   *
   * ⚠ 结果**不在页面里**了（原来是一个 `a-alert`），所以断言的对象从
   *   `wrapper.text()` 变成「调了哪个级别、文案是什么」。这让「颜色对不对」
   *   变成可测的：`无法连接中继` 必须走 `warning` 而不是 `success`。
   */
  const message = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    open: vi.fn(),
    destroy: vi.fn(),
  }

  return {
    syncListeners,
    dataListeners,
    statusQueue,
    message,
    syncNow: vi.fn(async () => ({ started: true, startedAt: Date.now() })),
    syncStatus: vi.fn(async () => statusQueue.shift() ?? null),
    reloadAccounts: vi.fn(async () => {}),
    send: vi.fn(async () => ({ usage: { count: 0, bytesApprox: 0 } })),
    setApp: vi.fn(async () => {}),
  }
})

vi.mock('~/logic/ui-message', () => ({
  useAppMessage: () => mocks.message,
  // 时长常量照抄真实值：它们只是「停多久」，不影响这里的断言
  ERROR_DURATION: 8,
  WARNING_DURATION: 6,
}))

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

/**
 * 某个提示级别**收到过的全部文案**（拼成一段，方便 `toContain`）。
 *
 * ⚠ 用「哪些文案走过哪一级」来断言，而不是去查页面文本：结果提示已经不在页面里了
 *   （全局 message），而且这样能顺带守住「故障不能走 success」这件事。
 */
function messageText(level: { mock: { calls: unknown[][] } }): string {
  return level.mock.calls.map(call => String(call[0])).join('\n')
}

describe('同步中一定会结束', () => {
  beforeEach(() => {
    mocks.syncListeners.length = 0
    mocks.dataListeners.length = 0
    mocks.statusQueue.length = 0
    mocks.syncNow.mockClear()
    mocks.syncStatus.mockClear()
    for (const level of Object.values(mocks.message))
      level.mockClear()
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

    expect(messageText(mocks.message.success)).toContain('拉取 3 封')
    expect(messageText(mocks.message.error)).toBe('')

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
    expect(messageText(mocks.message.success)).toContain('拉取 5 封')
    // 按钮回到可点状态（不再停在「同步中」）
    expect(wrapper.text()).not.toContain('同步中')

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

    expect(messageText(mocks.message.success)).not.toContain('拉取 99 封')
    // 仍在等：下一次轮询要有东西可拿
    mocks.statusQueue.push({ ok: true, results: [summary({ fetched: 2 })], finishedAt: Date.now() + 1 })
    await vi.advanceTimersByTimeAsync(1600)
    await flush()

    expect(messageText(mocks.message.success)).toContain('拉取 2 封')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('后台报错时用危险色如实说原因，而不是「没有启用的账号」', async () => {
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

    expect(messageText(mocks.message.error)).toContain('同步失败')
    expect(messageText(mocks.message.error)).toContain('IMAP 服务器响应超时')
    // 这句话只该在「真的没有启用账号」时出现，不能拿来当万能兜底
    expect(messageText(mocks.message.warning)).not.toContain('请先在「账号」页添加')
    // 也不该同时报一次「成功」
    expect(messageText(mocks.message.success)).toBe('')

    wrapper.unmount()
    vi.useRealTimers()
  })

  /*
   * ⚠⚠ 用户报过的那一条：`无法连接中继：ws://…` 曾经是**绿色**的。
   *
   * 原因有两个，这里一次把两个都钉住：
   *   1. 这类文案走的是 `SyncSummary.warning`（`adapters/mail/mailbox.ts` 在连接
   *      抛错时把错误塞进 `warning`），而它当时跟「拉取 N 封」拼在同一段里；
   *   2. 那一段整体按 `type="success"` 渲染 ⇒ 故障报成了好消息。
   */
  it('账号级故障走警告色，不会混进成功提示', async () => {
    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    mocks.syncListeners[0]({
      ok: true,
      results: [summary({ warning: '无法连接中继：ws://127.0.0.1:8787/imap.qq.com:993?tls=1' })],
    })
    await flush()

    expect(messageText(mocks.message.warning)).toContain('无法连接中继')
    // 账号名要带上：多账号时才知道该去修哪一个
    expect(messageText(mocks.message.warning)).toContain('个人邮箱')
    expect(messageText(mocks.message.success)).not.toContain('无法连接中继')

    wrapper.unmount()
  })

  it('有邮件失败时不用成功色（「拉取 3 封」和「失败 1 封」是同一句话）', async () => {
    const wrapper = mountPage()
    await flush()

    await syncButton(wrapper).trigger('click')
    await flush()

    mocks.syncListeners[0]({ ok: true, results: [summary({ fetched: 3, failed: 1 })] })
    await flush()

    expect(messageText(mocks.message.warning)).toContain('失败 1 封')
    expect(messageText(mocks.message.success)).toBe('')

    wrapper.unmount()
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

    expect(messageText(mocks.message.error)).toContain('仍未返回')
    expect(wrapper.text()).not.toContain('同步中')

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
