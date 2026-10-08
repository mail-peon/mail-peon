import type { RetentionLimit } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { count, del, iterate } from '~/platform/idb/database'

/**
 * 邮件滚动淘汰。
 *
 * ⚠ 单独一个模块（而不是放在 `mails.ts` 里）是**为了打断一个循环依赖**：
 *
 *   `ready.ts`（初始化门闸）需要淘汰能力，而 `mails.ts` 需要 `ready.ts` 的
 *   `withReady` 包装。把 `pruneMails` 留在 `mails.ts` 里就形成
 *   `ready → mails → ready`，而 ESM 的循环里 `mails.ts` 顶部那句
 *   `withReady(...)` 可能在 `ready.ts` 还没初始化完时执行 —— 得到
 *   `withReady is not a function`，且只在特定加载顺序下复现。
 *
 *   把淘汰挪到这里之后依赖是单向的：`ready / mails → prune → idb`。
 *
 * 淘汰顺序：`receivedAt`（数字时间戳）升序游标的前 N 条就是最旧的 N 条，
 * 不需要把整表读进内存排序。
 */
export const RETENTION_INDEX = 'by-receivedAt'

/**
 * 删掉最旧的 `overflow` 封，返回实际删掉的条数。
 *
 * ⚠ 必须跑在调用方的 readwrite 事务里（通过 `ctx`）。淘汰要先 `count` 再删，
 *   拆成两个事务的话，两个上下文并发写时会各自数出「还没超限」而双双留下条目 ——
 *   前者突破上限，后者多删。
 *
 * 关于 `del` 不 await：`iterate` 的回调是**同步**的，而 `del` 在拿到 `ctx` 时是
 * 同步把 `os.delete()` 发出去的 —— 请求落在同一个事务里就够了，事务何时提交由
 * `runTx` 统一等。反过来，回调里若去 await 别的东西，事务会在微任务排空时提前提交
 * （见 `platform/idb/database.ts` 头部第 1 条规矩）。
 */
export async function pruneMails(ctx: TxContext, retention: RetentionLimit): Promise<number> {
  if (retention === 'unlimited')
    return 0

  const total = await count('mails', ctx)
  const overflow = total - retention
  if (overflow <= 0)
    return 0

  let removed = 0
  await iterate<unknown>(
    'mails',
    { index: RETENTION_INDEX, direction: 'next', limit: overflow },
    (_value, key) => {
      void del('mails', key, ctx)
      removed++
    },
    ctx,
  )

  if (removed > 0)
    console.warn(`[mail-peon] 邮件超过 ${retention} 封，已丢弃最旧的 ${removed} 封`)

  return removed
}
