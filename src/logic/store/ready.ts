import { runMigration } from '~/logic/store/legacy'
import { normalizeAppSettings } from '~/logic/store/migrations'
import { pruneMails } from '~/logic/store/prune'
import { readRawSetting } from '~/logic/store/settings'
import { openDb, runTx } from '~/platform/idb/database'

/**
 * 初始化门闸。
 *
 * **所有存储读写都必须先过这道门**（各仓库的对外函数都套了 `withReady`）。做这件事
 * 的意义：
 *
 *  - 消除「读到迁移跑了一半」的窗口；
 *  - 把「开库 → 请求持久化 → 一次性迁移 → 启动淘汰」的顺序固定在一处，
 *    谁先谁后不用再猜。
 *
 * 失败**不缓存**：下一次调用会重新走一遍初始化（含迁移重试）。迁移失败时这里会抛 ——
 * 宁可让操作失败得明确，也不要让用户面对一个空库却以为数据没了。
 *
 * ⚠⚠ **门闸内部绝对不能调用任何套了 `withReady` 的函数**。
 *
 *   这是一个真实的死锁（写这一版时踩到了）：`init()` 曾经调用 `pruneMailsNow()`，
 *   而它套了 `withReady` → 它 `await ensureStoreReady()` → 拿到的是**正在执行的
 *   这个 `readyPromise`** → 等自己。整个插件永远卡在初始化：不报错、不响应、
 *   连 UI 都是空白。
 *
 *   所以门闸内部只允许用两类东西：`platform/idb` 的原语，以及**没有**
 *   `withReady` 的裸函数（`readRawSetting` / `runMigration` / `normalizeAppSettings`）。
 */
let readyPromise: Promise<void> | null = null

export function ensureStoreReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

async function init(): Promise<void> {
  await openDb()
  await requestPersistence()

  const result = await runMigration()
  if (result.status === 'failed')
    throw new Error(`存储迁移失败：${result.error ?? '未知原因'}`)

  await pruneMailsOnStartup()
}

/**
 * 启动时按保留策略清一次邮件。
 *
 * 放在初始化而不是写入路径：这是「按设置上限」的清理，跟着每次写入跑没有意义
 * （写入路径本来就带淘汰），而初始化在每个上下文只做一次。
 *
 * 两件事都是刻意的：
 *   - **不用 `pruneMailsNow()`**（那个套了门闸，会死锁，见文件头）；
 *   - **失败不抛**：它只是清理，不是数据完整性的一部分。为它让整个插件起不来
 *     是本末倒置。
 */
async function pruneMailsOnStartup(): Promise<void> {
  try {
    const app = normalizeAppSettings(await readRawSetting('app'))
    // 极简模式的实际上限写死 50（见 `design/minimal-mode.md § 3.5`）
    const retention = app.minimalMode ? 50 : app.mailRetention
    if (retention === 'unlimited')
      return

    await runTx(['mails'], 'readwrite', ctx => pruneMails(ctx, retention))
  }
  catch (error) {
    console.warn('[mail-peon] 启动淘汰失败（不影响使用）', error)
  }
}

/**
 * 请求持久化存储。
 *
 * IndexedDB 在磁盘压力下**可能被浏览器回收**，`persist()` 能挡住这件事。
 * 拿不到也没关系（返回值可能为 false），所以全程不抛错、不影响功能。
 * 刻意不申请 `unlimitedStorage` 权限：IDB 配额本就远大于旧存储的 10MB，
 * 而那个权限会加宽安装提示。
 *
 * ⚠ **必须带超时**。`navigator.storage.persist()` 的 promise 在某些环境里
 *   **永远不 settle**（jsdom 就是这样；真机上也有报告说用户在权限弹窗上不做选择时
 *   它会一直挂着）。而这里在 `ensureStoreReady()` 的关键路径上 —— 一个不 settle 的
 *   promise 会让整个插件永远卡在初始化，症状是「什么都没反应，也不报错」，
 *   比慢一点糟糕得多。
 *
 *   超时 1 秒：它只是「尽量争取持久化」的优化，不值得为它等更久。
 */
const PERSIST_TIMEOUT_MS = 1000

async function requestPersistence(): Promise<void> {
  const storage = globalThis.navigator?.storage
  if (!storage?.persist)
    return

  try {
    await Promise.race([
      storage.persist(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, PERSIST_TIMEOUT_MS)
      }),
    ])
  }
  catch {
    // 不支持 / 被拒绝 / 抛错都算了
  }
}

/**
 * 仅供测试：清掉「已就绪」的缓存，让下一次调用重新初始化。
 *
 * 生产代码不该调用它 —— 初始化只做一次是这里的全部意义。
 */
export function resetStoreReadyForTests(): void {
  readyPromise = null
}

/**
 * 把「先过门闸」这件事**焊进函数本身**，而不是靠每个调用方记得写。
 *
 * 设计文档要求「所有读写函数的第一行都必须是 `await ensureStoreReady()`」。
 * 手写那句话的问题是**它是一条约定，不是一个保证**：漏写一处不会有任何编译错误
 * 或测试失败，症状是线上偶发读到一半的迁移（本地开发几乎不可能复现）。用这个
 * 包装把契约变成机制之后，「漏写」在代码里根本表达不出来。
 *
 * ⚠ 类型上刻意**不**写成 `(...args: A) => Promise<R>`：TS 对「返回一个泛型签名」
 *   的函数推断能力很差，参数会退化成 `unknown`，于是每个调用点的实参都要手写类型
 *   注解（`mails.ts` 的 `limit` 就中过这一枪）。改成 `Parameters<F>` 取参之后，
 *   参数类型**原样保留**，调用方看不到任何额外负担。
 *
 * ⚠ 两个使用禁忌（都有真实故障对应）：
 *   1. **门闸内部与仓库内部函数不要套它** —— 会死锁，见文件头；
 *   2. 纯函数（`retentionLimit` / `isFirstSync` 之类）不要套 —— 它们没有 IO，
 *      套上只是白白多一个异步边界。
 */
export function withReady<F extends (...args: never[]) => unknown>(
  fn: F,
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  return async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
    await ensureStoreReady()
    return fn(...args) as Awaited<ReturnType<F>>
  }
}
