import type { MailConnectionHooks } from '~/adapters/mail/types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { MailAccount, SyncSummary } from '~/logic/types'
import { syncAllAccounts } from '~/adapters/mail/mailbox'
import { refreshBadge } from '~/logic/notification/badge'
import { listEnabledAccounts } from '~/logic/store/accounts'

/**
 * 一轮同步：取账号 → 逐个拉取 → 刷 badge。
 *
 * 单独一个模块（而不是内联在 `background/main.ts`）的唯一理由：**心跳与
 * 「立即同步」按钮必须走同一条路径**。分成两份的话，差别会表现为
 * 「手动同步能拉到邮件，自动同步拉不到」—— 这种 bug 在真机上极难排查，
 * 因为两边看起来都「成功」了。
 */

export interface SyncCycleDeps {
  pipeline: MailPipeline
  hooksFor: (account: MailAccount) => MailConnectionHooks
}

export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncSummary[]> {
  const accounts = await listEnabledAccounts()

  if (!accounts.length) {
    console.warn('[mail-peon] 同步结束：没有启用的账号')
    return []
  }

  const results = await syncAllAccounts(accounts, deps.pipeline, { hooksFor: deps.hooksFor })

  // badge 在整轮结束后算一次，而不是每封邮件算一次：
  // `badgeCount` 要遍历邮件表，50 封邮件就是 50 次全表扫描
  await refreshBadge()

  /*
   * ⚠ 这一行的作用是「分清两种 0」：
   *
   *   - `拉取 0 封` + 这条日志 → 真的没有新邮件（游标已是最新）；
   *   - 拉到了 N 封、但界面上什么都没有 → 问题在**处理链路**
   *     （预筛 / AI / 入库），而不是抓取。后面几条日志就是为这种情况准备的。
   *
   *   没有它的话，「中继日志显示抓到了邮件、界面却是空的」这件事
   *   在插件侧完全没有线索。
   */
  console.warn(
    `[mail-peon] 同步结束：${results.map(r => `${r.accountId} 拉取 ${r.fetched} 封（屏蔽 ${r.blocked}，失败 ${r.failed}）`).join('；') || '无结果'}`,
  )

  return results.map((result, index) => ({
    accountId: result.accountId,
    label: accounts[index]?.label ?? result.accountId,
    firstSync: result.firstSync,
    fetched: result.fetched,
    blocked: result.blocked,
    failed: result.failed,
    warning: result.warning,
  }))
}
