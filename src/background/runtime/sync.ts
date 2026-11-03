import { createSingleFlight } from '~/platform/single-flight'
import { runSyncCycle } from '../sync'
import { buildPipeline, hooksFor } from './pipeline'

/**
 * 同步周期的**单飞闸门**（见 `platform/single-flight.ts`）。
 *
 * ⚠ 为什么必须有它：同步周期有三个**互不协调**的入口 —— watch 推送（`openWatchChannel`
 *   的回调）、自动检查 `alarm`、手动「立即同步」—— 而 `runSyncCycle` 每轮都会**重新从库里
 *   读游标**（`adapters/mail/mailbox.ts`），整条链路上也没有「这封已经处理过」的判据。
 *   两轮重叠的后果是具体的：
 *
 *     1. 两轮读到同一个游标 → 同一批邮件被拉两次；
 *     2. 每封邮件各调一次 AI（`logic/ai/pipeline.ts`）→ **重复计费**；
 *     3. 同一封邮件重复弹 toast。
 *
 *   而这不是边界情况：推送是「新邮件一到立刻发」的，一轮同步又可能跑几十秒
 *   （真机上有 3 万多封的邮箱跑过 32 秒），所以「推送撞上在途同步」是常态。
 *   同一份文件里 `watchRestartInFlight` 处理的是同一类竞态（见它的说明）。
 */
const syncFlight = createSingleFlight()

/**
 * 跑一轮同步（心跳与「立即同步」按钮共用）。
 *
 * 共用是有意的：分成两条路径的话，差别会表现为「手动同步能拉到、自动同步拉不到」，
 * 而这种 bug 在真机上极难排查 —— 两边看起来都「成功」了。
 */
async function runSyncCycleNow() {
  return runSyncCycle({ pipeline: buildPipeline(), hooksFor })
}

/**
 * 跑一轮同步，且**不与在途的那一轮重叠**（搭车复用）。
 *
 * 推送与手动「立即同步」都用它。`started === false` 表示本次没有真的跑 ——
 * 已经有一轮在途，而那一轮的抓取范围（游标之后的所有邮件）本来就覆盖了本次的诉求。
 *
 * @returns 那一轮的结果，以及本次是否真的执行了
 */
export async function syncOnce() {
  return syncFlight.run(runSyncCycleNow)
}

/**
 * 跑一轮同步，并且保证**至少有一轮是在「现在」之后开始的**。
 *
 * 只给自动检查 `alarm` 用：它按用户配置的周期跑，语义是「每一跳都必须真的去问一次邮箱」，
 * 于是它排到在途那一轮**之后**按顺序执行。
 *
 * ⚠ 刻意**不**给 watch 推送用：推送的诉求（游标之后的邮件）已经被在途那一轮覆盖，
 *   再排一轮只是白连一次邮箱（腾讯对同账号的并发 / 频率连接数有限制，见
 *   `ai-docs/decisions/imap-testing.md § 11`）。真在那一瞬间到的邮件由下一跳兜底 ——
 *   而它本来就是这个定时器存在的意义（推送失效时的兜底）。
 *
 * ⚠ 也不给手动「立即同步」用：那会让 `sendMessage` 的 promise 挂上两整轮同步的时间，
 *   而「一条未完成的 `sendMessage` 不算事件」会让 MV3 的 SW 在 30 秒后被回收 ——
 *   这正是 `accounts:sync-now` 立刻返回、结果走轮询的原因（见它的说明）。
 */
export async function syncAfterCurrent() {
  return syncFlight.chain(runSyncCycleNow)
}
