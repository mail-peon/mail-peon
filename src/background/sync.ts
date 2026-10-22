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

  if (!accounts.length)
    return []

  const results = await syncAllAccounts(accounts, deps.pipeline, { hooksFor: deps.hooksFor })

  // badge 在整轮结束后算一次，而不是每封邮件算一次：
  // `badgeCount` 要遍历邮件表，50 封邮件就是 50 次全表扫描
  await refreshBadge()

  /*
   * ⚠ 只在**这一轮真的碰到了邮件**时才打印。
   *
   *   自动检查每隔几分钟跑一轮，绝大多数轮次是 `拉取 0 封（屏蔽 0，失败 0）`；
   *   把这种「什么都没发生」的轮次也打出来，只会把真正需要看的几行淹掉。
   *
   *   它要解释的是「拉到了 N 封、界面却是空的」—— 那时问题在**处理链路**
   *   （预筛 / AI / 入库），而不是抓取，后面几条日志就是为这种情况准备的。
   */
  const touched = results.some(r => r.fetched || r.blocked || r.failed)
  if (touched) {
    console.warn(
      `[mail-peon] 同步结束：${results.map(r => `${r.accountId} 拉取 ${r.fetched} 封（屏蔽 ${r.blocked}，失败 ${r.failed}）`).join('；')}`,
    )
  }

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
