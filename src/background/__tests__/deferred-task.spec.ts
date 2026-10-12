import { describe, expect, it, vi } from 'vitest'
import { fireAndForget } from '../deferred-task'

/**
 * `fireAndForget` 的回归测试 —— 守的是 MV3 Service Worker 30 秒空闲回收那条线。
 *
 * 这条断言是**核心**：
 * 「调用 `fireAndForget(slowWork)` 后**立刻**拿到 `{started: true}`」——
 * 证明 handler 不会 await 那条耗时 5 分钟的活。
 *
 * ⚠️ 真机上踩过这个坑：第二轮实现把 `await syncOnce()` 留在 handler 里，
 *   用户的 3 万封邮箱一轮同步 32 秒就触发 MV3 SW 回收（30 秒空闲就杀），
 *   promise 永远不 settle，UI 永远停在「同步中」。
 *   —— 见 `background/main.ts:630-670` 的注释（这条测试守的是那里的语义）。
 */

describe('fireAndForget', () => {
  it('立刻返回 started:true，不等 work 完成', () => {
    let resolveWork: (value: string) => void = () => {}
    const slowWork = vi.fn(() => new Promise<string>((resolve) => {
      resolveWork = resolve
    }))

    // 关键：**同步**路径上就拿到返回值（不等微任务）
    const result = fireAndForget(slowWork)
    expect(result).toEqual({ started: true })
    expect(slowWork).toHaveBeenCalledTimes(1)

    // 现在让 work 解决（5 分钟的活现在变 0 分钟，不影响本测试）
    resolveWork('done')
  })

  it('work 完成后正常 settle，不抛到调用方', async () => {
    const work = vi.fn(async () => 'ok')
    fireAndForget(work)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('work 拒绝时把错误传给 onError，不抛到调用方', async () => {
    const onError = vi.fn()
    const failure = new Error('sync crashed')

    fireAndForget(async () => {
      throw failure
    }, onError)

    // 给微任务机会跑
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('work 拒绝且无 onError 时静默吃掉（不破坏 MV3 worker）', async () => {
    /*
     * ⚠️ 这是关键安全网 —— 如果用户忘了传 onError，错误应该**静默**，而不是
     *   冒泡到 worker 的 unhandled rejection 通道（那样反而会被 Chrome 报错）。
     */
    fireAndForget(async () => {
      throw new Error('boom')
    })
    // 给微任务机会跑
    await new Promise(resolve => setTimeout(resolve, 10))
    // 没崩就是成功
  })

  it('多次调用 → 多次启动 work（互不阻塞）', () => {
    const work = vi.fn(() => new Promise<never>(() => {}))
    fireAndForget(work)
    fireAndForget(work)
    fireAndForget(work)
    expect(work).toHaveBeenCalledTimes(3)
  })

  it('work 内部抛同步异常也走 onError', async () => {
    const onError = vi.fn()
    fireAndForget(() => {
      throw new Error('sync-throw')
    }, onError)

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync-throw' }))
  })
})
