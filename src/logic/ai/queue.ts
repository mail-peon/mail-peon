/**
 * 极简的并发闸门。
 *
 * `features/02-ai-summary.md § 4` 要求「在 background 用一个简单的 in-memory 队列，
 * 默认 3 并发」。刻意**不引入 `p-limit`**：这是一段二十行的代码，而它的正确性
 * 完全可以被单测覆盖；为它加一个依赖，换来的是「升级依赖时要重新审一遍这段逻辑」。
 *
 * ⚠ 为什么需要闸门（不是「顺手加个优化」）：
 *   一轮心跳可能拉到 50 封邮件（`MAX_MESSAGES_PER_SYNC`），全部并发发出去会：
 *   1. 撞上 AI 平台的并发限流（429），而我们**没有**做 429 退避重试；
 *   2. 在 MV3 的 SW 里同时开着 50 个 fetch，SW 被回收时全都变成孤儿请求；
 *   3. 内存峰值不可控（每封邮件带着完整正文）。
 */
export function createLimiter(concurrency: number) {
  const limit = Math.max(1, Math.floor(concurrency) || 1)

  let active = 0
  const waiting: Array<() => void> = []

  async function acquire(): Promise<void> {
    if (active < limit) {
      active++
      return
    }
    await new Promise<void>(resolve => waiting.push(resolve))
    active++
  }

  function release(): void {
    active--
    const next = waiting.shift()
    if (next)
      next()
  }

  /** 排队跑一个任务；任务的失败会原样抛给调用方（不吞掉） */
  async function run<T>(task: () => Promise<T>): Promise<T> {
    await acquire()
    try {
      return await task()
    }
    finally {
      release()
    }
  }

  return {
    run,
    /** 当前运行中的任务数（诊断用） */
    get active() {
      return active
    },
    /** 排队中的任务数（诊断用） */
    get pending() {
      return waiting.length
    },
  }
}

export type Limiter = ReturnType<typeof createLimiter>

/** 跑一批任务，限制并发；**保持输入顺序**返回结果（失败的项为 `null`） */
export async function mapWithLimit<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const limiter = createLimiter(concurrency)
  return Promise.all(items.map((item, index) => limiter.run(() => task(item, index)).catch(() => null)))
}
