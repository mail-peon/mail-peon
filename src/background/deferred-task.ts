/**
 * 「立刻返回，后台跑异步任务」—— 防 MV3 Service Worker 30 秒空闲回收。
 *
 * ## 为什么需要它
 *
 * MV3 的 Service Worker 在**没有事件** 30 秒后被回收，而一条**正在进行中**的
 * `sendMessage` **不算事件**。所以「点同步 → 等它跑完 → 返回结果」这种写法在
 * 同步超过 30 秒时必然失败 —— worker 被杀，promise 永远不 settle，
 * UI 停在「同步中」不动（真机上就是这么发生的：用户邮箱 3 万多封，
 * 一轮同步跑了 32 秒）。
 *
 * 这个 helper 让 handler 立刻 settle `{started: true}`，真正的同步留在 worker 里
 * 继续（它自己会 `await` 网络与 IDB —— 这些都是事件，能让 worker 保活）。
 *
 * ## 用法
 *
 * ```ts
 * onMessage('accounts:sync-now', async () => {
 *   await ensureStoreReady()
 *   return fireAndForget(async () => {
 *     // 长时间跑的活：
 *     const { value: results } = await syncOnce()
 *     lastSync = { ok: true, results, finishedAt: Date.now() }
 *     broadcastToExtension('sync:done', { ok: true, results, finishedAt: lastSync.finishedAt })
 *   })
 * })
 * ```
 *
 * ## 与 `void promise` 的对比
 *
 * `void promise` 也行，但它捕获错误要写一行 `.catch(...)`，多次出现时就成了重复的
 * 三行模板。这里只**一行**就够：`fireAndForget(work, onError)`。
 */

export interface DeferredTaskResult {
  /** 这条 handler 已经把活交出去了；调用方可以立刻返回。 */
  readonly started: true
}

/**
 * 在微任务上启动 `work`，**立刻**返回 `{started: true}`，不等待 `work` 完成。
 *
 * `work` 是**不是** promise —— 传函数能让 `fireAndForget` 立刻调用而**不**等
 * `work()` 的 promise 落到微任务队列之前。这一点对测试至关重要（见
 * `__tests__/deferred-task.spec.ts`）。
 */
export function fireAndForget(
  work: () => Promise<unknown>,
  onError?: (error: unknown) => void,
): DeferredTaskResult {
  // 启动 promise 但**不 await** —— 调用方立刻返回 `{started: true}`。
  //
  // ⚠️ `work()` 自己**可能同步抛**（参数漏 / 序列化错 / 测试 stub）——
  //   不能让它成为调用方的 unhandled error。包一层 try/catch：
  let promise: Promise<unknown>
  try {
    promise = work()
  }
  catch (error) {
    onError?.(error)
    return { started: true as const }
  }
  // `void` 前缀告诉 ESLint「这是故意的，我们不要 await」；
  // `.then(undefined, onError)` 在 promise 拒绝时给个落地处（默认静默，调试时不应静默）。
  void promise.then(undefined, (error) => {
    onError?.(error)
  })
  return { started: true as const }
}
