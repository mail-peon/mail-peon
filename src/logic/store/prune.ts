import type { RetentionLimit } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { del, iterate } from '~/platform/idb/database'

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
 * 回收站里的邮件**不参与滚动淘汰**。
 *
 * ⚠ 这一点很重要，不是遗漏：
 *
 *   - 回收站的存在意义就是「用户以为删了、其实还能找回来」。
 *     如果滚动淘汰会把回收站里的东西顺手删掉，那它就不是回收站，而是
 *     一个「过一会儿自己清空」的假回收站 —— 用户根本来不及反悔。
 *   - 所以回收站只能由**用户显式动作**清空（`emptyTrash` / 单条彻底删除），
 *     或者由「失效验证码自动删除」推进去，绝不会被保留数量挤掉。
 *
 * 代价是回收站会一直占着空间。这是**有意**的：占用是可见的（回收站页有计数），
 * 而「东西悄悄没了」是不可见的。前者用户能处理，后者不能。
 */
export async function pruneMails(ctx: TxContext, retention: RetentionLimit): Promise<number> {
  if (retention === 'unlimited')
    return 0

  /*
   * ⚠ 计数要把回收站**排除掉**，否则「保留 100 封」会被回收站里的邮件虚占名额 ——
   *   用户看到主列表只剩 60 封，而回收站里躺着 40 封，却不知道两者有关系。
   *   这里逐条数而不是 `count('mails')`：后者是整表条数。
   */
  let live = 0
  await iterate<unknown>('mails', {}, (value) => {
    const mail = value as { trashedAt?: unknown } | null
    if (mail && typeof mail === 'object' && mail.trashedAt === undefined)
      live++
  }, ctx)

  const overflow = live - retention
  if (overflow <= 0)
    return 0

  let removed = 0
  let skippedTrashed = 0

  /*
   * ⚠ 这里**不能**给 `limit: overflow`。
   *
   *   游标要跳过回收站里的条目，而跳过是不计入删除数的 ——
   *   如果按 overflow 提前停，最旧的几封恰好在回收站里时就会「删不够」，
   *   于是调用方以为还超限、下一轮又跑一遍。
   *   代价是最坏情况多遍历一些条目，换来「一次就删到位」。
   */
  await iterate<unknown>(
    'mails',
    { index: RETENTION_INDEX, direction: 'next' },
    (value, key) => {
      if (removed >= overflow)
        return

      const mail = value as { trashedAt?: unknown } | null
      if (mail && typeof mail === 'object' && mail.trashedAt !== undefined) {
        skippedTrashed++
        return
      }

      void del('mails', key, ctx)
      removed++
    },
    ctx,
  )

  if (removed > 0) {
    console.warn(
      `[mail-peon] 邮件超过 ${retention} 封，已丢弃最旧的 ${removed} 封`
      + `${skippedTrashed ? `（跳过回收站里的 ${skippedTrashed} 封）` : ''}`,
    )
  }

  return removed
}
