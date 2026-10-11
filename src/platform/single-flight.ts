/**
 * 单飞（single-flight）：把**并发**的同类请求合并成一次真实执行；并发期间新来的
 * 请求可以选择「搭车复用」或「排到本轮之后再跑一轮」。
 *
 * ## 为什么需要它（不是顺手加个优化）
 *
 * `background/main.ts` 的同步周期有三个互不协调的入口 —— watch 推送、兜底 `alarm`、
 * 手动「立即同步」—— 而同步本身会**从库里读游标**（`adapters/mail/mailbox.ts`），
 * 整轮也没有「这封已经处理过」的判据。两轮重叠的后果是具体的：
 *
 *   1. 两轮读到同一个游标 → 同一批邮件被拉两次；
 *   2. 每封邮件各调一次 AI（`logic/ai/pipeline.ts`）→ 重复计费；
 *   3. 同一封邮件重复 toast。
 *
 * 这不是理论风险：推送是「新邮件一到立刻发」的，而一轮同步可能跑几十秒（真机上有
 * 3 万多封的邮箱），所以「推送撞上在途同步」是常态而不是边界情况。
 *
 * ## 两个语义，别混
 *
 *   - `run(task)`：**合并**。在途时直接复用那一轮的 promise（同一批邮件只处理一次）。
 *   - `chain(task)`：**排到本轮之后**。在途时把它挂到当前轮的尾巴上（本轮结束后
 *     串行执行），于是「手动点一下立即同步」不会退化成空操作 —— 它会真的再跑一轮，
 *     只是不会和当前那轮抢同一批邮件。
 *
 *     ⚠ `chain` 同一时刻只保留一条尾巴：在途期间调 N 次也只会多跑一轮。
 *       不这么做的话，「用户连点」或「推送刷屏」会把同步请求堆成一串，
 *       那正是这个模块要消灭的东西。
 *
 * ## 为什么单独一个模块
 *
 * 它的正确性（合并、排队、失败不粘连）完全可以用假计时器 + 假 promise 断言，
 * 而埋在 `background/main.ts` 里就测不动了 —— 那里一 import 就会起 watch 连接、
 * 装定时器、注册一大堆消息 handler。
 */

/** `run` 的结果：到底是自己跑的，还是搭了在途那一轮的车 */
export interface SingleFlightResult<T> {
  /** 真实执行的结果（搭车时是**别人那一轮**的结果） */
  value: T
  /** `true` = 本次调用真的执行了任务；`false` = 复用了在途的那次 */
  started: boolean
}

export interface SingleFlight {
  /**
   * 跑一次；在途时复用那一轮的 promise。
   *
   * @param task 要执行的任务
   * @returns 结果与「本次是否真的执行了」
   */
  run: <T>(task: () => Promise<T>) => Promise<SingleFlightResult<T>>
  /**
   * 把任务排到**当前轮结束之后**串行执行；没有在途任务时就是立即执行。
   *
   * 在途期间多次调用只会多跑一轮（见文件头）。返回的 promise 就是那一轮的结果。
   *
   * @param task 要执行的任务
   */
  chain: <T>(task: () => Promise<T>) => Promise<T>
  /** 是否有任务正在跑（诊断 / 测试用） */
  readonly active: boolean
}

export function createSingleFlight(): SingleFlight {
  /** 在途的那一轮；`null` = 空闲 */
  let inFlight: Promise<unknown> | null = null
  /** 排在本轮之后的尾巴（同时只留一条） */
  let chained: Promise<unknown> | null = null

  /**
   * 收尾。
   *
   * ⚠ 用 `.then(cleanup, cleanup)` 而不是 `.finally()`：这里的 `inFlight` 是别人
   *   那一轮的 promise，它**可能 reject**（同步失败是正常路径），而 `.finally()`
   *   会把 reject 继续往下传 —— 于是「搭车者」收到的是上一轮的异常，
   *   连 `run` 的 `started` 判定都执行不到。两边都清、都不改判。
   */
  function clearInFlight(): void {
    inFlight = null
  }

  /**
   * 清掉尾巴。
   *
   * ⚠ 必须**带身份判断**（只清自己那一条）：清空动作是在微任务里跑的，而那一瞬间
   *   可能有 `chain` 又挂了新尾巴 —— 无条件置 `null` 会把新尾巴的登记抹掉，
   *   于是它既不会被复用、也不会阻止再挂一条。
   *
   * @param promise 已经结束的那条尾巴
   */
  function clearChained(promise: Promise<unknown>): void {
    if (chained === promise)
      chained = null
  }

  async function run<T>(task: () => Promise<T>): Promise<SingleFlightResult<T>> {
    if (inFlight)
      return { value: await (inFlight as Promise<T>), started: false }

    const promise = task()
    inFlight = promise
    // 先挂收尾（而不是 await 之后才挂）：任务同步抛错时也不会把状态卡住
    promise.then(clearInFlight, clearInFlight)
    return { value: await promise, started: true }
  }

  function chain<T>(task: () => Promise<T>): Promise<T> {
    if (!inFlight && !chained)
      return task()

    /*
     * 尾巴只保留一条，**且登记的是整条尾巴**（含任务本身）：
     *
     *   - 只登记「排在前面那一轮」的话，任务一执行完登记就没了 ——
     *     于是任务还在跑的期间再调 `chain`，会依据「登记为空」再挂一条，
     *     两条尾巴并行 → 又回到重复处理；
     *   - 登记整条，且在**它自己结束后**才注销（见 `clearChained`），
     *     就保证了「同时只有一条尾巴」这个不变量。
     *
     * ⚠ 这里刻意**不用** `run`：`run` 的语义是「复用当前轮的**结果**」，
     *   而 `chain` 要的是「等价于一轮新的同步」——它必须真的去调一次
     *   `fetchSince`，否则用户点了「立即同步」而游标在点击之前就被推过，
     *   新邮件要等下一次推送才进来。
     */
    if (!chained) {
      const previous = (inFlight ?? Promise.resolve()) as Promise<unknown>
      const tail = previous.then(task, task)
      chained = tail
      tail.then(() => clearChained(tail), () => clearChained(tail))
    }
    return chained as Promise<T>
  }

  return {
    run,
    chain,
    get active() {
      return inFlight !== null
    },
  }
}
