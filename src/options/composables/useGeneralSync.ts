import type { useAccounts } from '~/logic/bridge'
import type { SyncDonePayload } from '~/logic/types'
import { useSyncRequest } from '~/composables/useSyncRequest'
import { t } from '~/logic/strings'
import { ERROR_DURATION, useAppMessage, WARNING_DURATION } from '~/logic/ui-message'

export function useGeneralSync(options: {
  syncNow: ReturnType<typeof useAccounts>['syncNow']
  syncStatus: ReturnType<typeof useAccounts>['syncStatus']
  reloadUsage: () => Promise<void>
  reloadAccounts: () => Promise<void>
}) {
  const { syncNow, syncStatus, reloadUsage, reloadAccounts } = options
  const uiMessage = useAppMessage()

  const { syncing, start: onSyncNow } = useSyncRequest({
    start: syncNow,
    status: syncStatus,
    timeoutMs: 6 * 60 * 1000,
    onDone: applySyncResult,
    onTimeout() {
      uiMessage.error('同步超过 6 分钟仍未返回。请检查中继是否在运行，然后重试。', ERROR_DURATION)
    },
    onStartFailed() {
      uiMessage.error('无法启动同步：与后台通信失败，请重试', ERROR_DURATION)
    },
  })

  /**
   * 把一轮同步的结果呈现出来（成功与失败都走这里）。
   *
   * ⚠ 抽成函数是因为它有**两个**调用方（广播与轮询兜底），而两边必须给出
   *   完全一致的结果 —— 分成两份实现的话，差别会表现为「有时显示拉取 N 封、
   *   有时什么都不显示」，这种不一致极难排查。
   *
   * ⚠⚠ 这里按**性质**分成四种提示，不能合并成一条：
   *
   *   - 整体失败（`ok: false`）⇒ `error`（红）
   *   - 有账号级故障 / 有邮件失败 ⇒ `warning`（黄）
   *   - 正常拉取 ⇒ `success`（绿）
   *   - 「首次同步只记位置」⇒ `info`（蓝，它不是结果而是说明）
   *
   *   合并成一条 `success` 正是用户报过的问题：「无法连接中继」曾经以绿色出现。
   *
   * @param result 后台给出的一轮同步结果
   */
  function applySyncResult(result: SyncDonePayload) {
    if (!result.ok) {
    // 失败如实说。不要用「没有启用的账号」这种猜测 —— 那是另一个原因，
    // 会把用户引去反复检查一个本来就正常的账号页
      uiMessage.error(`同步失败：${result.error ?? '未知原因'}`, ERROR_DURATION)
      void reloadUsage()
      return
    }

    const summaries = result.results
    if (!summaries.length) {
      uiMessage.warning('没有启用的账号；请先在「账号」页添加（并确认「启用（参与后台同步）」是勾上的）')
      return
    }

    /*
   * 首次同步单独说清楚：用户看到「拉取 0 封」会以为坏了，而实际上这正是
   * 设计文档要求的「首次只记同步位置，不拉历史」。
   */
    const firstSync = summaries.filter(item => item.firstSync)
    const fetched = summaries.reduce((sum, item) => sum + item.fetched, 0)
    const blocked = summaries.reduce((sum, item) => sum + item.blocked, 0)
    const failed = summaries.reduce((sum, item) => sum + item.failed, 0)

    // 「首次同步只记位置」是**说明**，不是结果 —— 用 info（蓝）而不是 success
    if (firstSync.length)
      uiMessage.info(`${firstSync.map(item => item.label).join('、')}：${t('general.syncFirstTime')}`)

    /*
   * ⚠ 有失败就**不能是绿色**：`同步完成：拉取 3 封，失败 1 封` 用绿底显示，
   *   用户会读成「一切正常」，而实际上有个账号根本没拉到信。
   */
    if (fetched || blocked || failed) {
      const text = t('general.syncDone', { fetched, blocked, failed })
      if (failed)
        uiMessage.warning(text, WARNING_DURATION)
      else
        uiMessage.success(text)
    }

    /*
   * 账号级的「这一轮出了事」，例如
   * `无法连接中继：ws://127.0.0.1:41316/imap.qq.com:993?tls=1`。
   *
   * ⚠ 这类文案走的是 `SyncSummary.warning` 字段（见 `adapters/mail/mailbox.ts`：
   *   连接抛错时会把它塞进 `warning`），所以**字段名看着像警告、内容可能是故障**。
   *   之前它跟成功文案拼成一整段、整体按 success 渲染 ⇒ 故障是绿色的。
   *   现在按**警告色**单独提示，并且带上账号名（多账号时才知道该去修哪个）。
   */
    for (const item of summaries.filter(entry => entry.warning))
      uiMessage.warning(`${item.label}：${item.warning}`, WARNING_DURATION)

    void reloadUsage()
    void reloadAccounts()
  }
  return { syncing, onSyncNow }
}
