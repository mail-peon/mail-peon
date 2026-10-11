import { describe, expect, it, vi } from 'vitest'
import { createSingleFlight } from '../single-flight'

/**
 * 单飞闸门的回归测试。
 *
 * ## 这一组在防什么
 *
 * 它对应一个**真金白银**的缺陷：`background/main.ts` 的同步周期有三个互不协调的入口
 * （watch 推送 / 兜底 `alarm` / 手动「立即同步」），而每轮同步都会重新读游标；
 * 两轮重叠 = 同一批邮件被拉两次 → 每封各调一次 AI → **重复计费**。
 *
 * 所以这里断言的不是「函数被调用了几次」这种实现细节，而是那个不变量：
 *
 *   - 在途时 `run` **不**启动第二次任务（并发请求合并成一次）；
 *   - 在途时 `chain` 真的还会再跑一轮（手动点「立即同步」不能变成空操作），
 *     但**同时只排一条**（用户连点不会堆成一串）；
 *   - 失败不粘连：一次任务抛错不能把闸门永久卡在「在途」状态
 *     （否则之后**所有**同步都被当成搭车、永远不执行 —— 那比重复计费更严重）。
 *
 * 单独测这个模块而不是测 `main.ts`：那里一 import 就会起 watch 连接、装定时器、
 * 注册一大堆消息 handler，测不动。
 */

/** 一个能手动控制何时完成的 promise */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让所有已排队的微任务跑完 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('createSingleFlight', () => {
  it('并发调用 run：任务只执行一次，第二个调用复用第一个的结果', async () => {
    const flight = createSingleFlight()
    const gate = deferred<string>()
    const task = vi.fn(() => gate.promise)

    const first = flight.run(task)
    const second = flight.run(task)
    const third = flight.run(task)

    gate.resolve('done')
    const results = await Promise.all([first, second, third])

    expect(task).toHaveBeenCalledTimes(1)
    // 只有第一个是「真的跑了」，另外两个是搭车
    expect(results.map(result => result.started)).toEqual([true, false, false])
    expect(results.map(result => result.value)).toEqual(['done', 'done', 'done'])
  })

  it('前一轮结束后再 run：会真的开始新的一轮（闸门没被卡住）', async () => {
    const flight = createSingleFlight()
    const task = vi.fn(async () => 'ok')

    await flight.run(task)
    await flight.run(task)

    expect(task).toHaveBeenCalledTimes(2)
    expect(flight.active).toBe(false)
  })

  it('任务抛错：错误原样抛给调用方，且闸门能继续用', async () => {
    const flight = createSingleFlight()
    const failing = vi.fn(async () => {
      throw new Error('同步炸了')
    })
    const ok = vi.fn(async () => 'ok')

    await expect(flight.run(failing)).rejects.toThrow('同步炸了')
    expect(flight.active).toBe(false)

    // ⚠ 关键断言：失败之后必须还能跑。否则一次网络错误会让同步永久失效
    await expect(flight.run(ok)).resolves.toEqual({ value: 'ok', started: true })
  })

  it('在途时多个 run 都失败：每个搭车者都拿到那个错误，闸门仍然释放', async () => {
    const flight = createSingleFlight()
    const gate = deferred()
    const failing = vi.fn(() => gate.promise)

    const first = flight.run(failing)
    const second = flight.run(failing)
    gate.reject(new Error('连接被拒'))

    await expect(first).rejects.toThrow('连接被拒')
    await expect(second).rejects.toThrow('连接被拒')
    expect(failing).toHaveBeenCalledTimes(1)
    expect(flight.active).toBe(false)
  })

  it('chain 在空闲时就是直接执行', async () => {
    const flight = createSingleFlight()
    const task = vi.fn(async () => 'ok')

    await expect(flight.chain(task)).resolves.toBe('ok')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('chain 在途时排到本轮之后执行，且只排一条（连点不会堆成一串）', async () => {
    const flight = createSingleFlight()
    const firstGate = deferred()
    const order: string[] = []
    const firstTask = vi.fn(async () => {
      order.push('第一轮开始')
      await firstGate.promise
      order.push('第一轮结束')
      return 'first'
    })
    const tailTask = vi.fn(async () => {
      order.push('尾巴开始')
      return 'tail'
    })

    const running = flight.run(firstTask)
    // 「用户在同步跑到一半时连点了三次立即同步」
    const tail1 = flight.chain(tailTask)
    const tail2 = flight.chain(tailTask)
    const tail3 = flight.chain(tailTask)

    firstGate.resolve()
    await running
    const tailResults = await Promise.all([tail1, tail2, tail3])

    /*
     * ⚠ 这是本用例的核心：三次点击只换来**一轮**尾巴。
     *   堆成一串的话，「推送刷屏 + 用户连点」会让邮箱连接被反复占用。
     */
    expect(tailTask).toHaveBeenCalledTimes(1)
    // 顺序必须严格是「第一轮结束 → 尾巴开始」，不能重叠
    expect(order).toEqual(['第一轮开始', '第一轮结束', '尾巴开始'])
    expect(tailResults).toEqual(['tail', 'tail', 'tail'])
  })

  it('chain 的尾巴跑完后，再 chain 会排新的（尾巴登记被正确注销）', async () => {
    const flight = createSingleFlight()
    const tailTask = vi.fn(async () => 'tail')

    await flight.chain(tailTask)
    await flush()
    await flight.chain(tailTask)

    expect(tailTask).toHaveBeenCalledTimes(2)
  })

  it('前一轮抛错时，排队的尾巴仍然执行（一轮失败不该吃掉后面的请求）', async () => {
    const flight = createSingleFlight()
    const gate = deferred()
    const failing = vi.fn(() => gate.promise)
    const tailTask = vi.fn(async () => 'tail')

    const running = flight.run(failing)
    const tail = flight.chain(tailTask)
    gate.reject(new Error('第一轮失败'))

    await expect(running).rejects.toThrow('第一轮失败')
    await expect(tail).resolves.toBe('tail')
    expect(tailTask).toHaveBeenCalledTimes(1)
  })
})
