import type { Ref } from 'vue'
import type { AppSettings, StorageUsage } from '~/logic/types'
import { computed, ref } from 'vue'
import { send } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { t } from '~/logic/strings'
import { ERROR_DURATION, useAppMessage } from '~/logic/ui-message'

export function useGeneralData(options: {
  app: Ref<AppSettings | null>
  reloadSettings: () => Promise<unknown>
  reloadAccounts: () => Promise<void>
}) {
  const { app, reloadSettings, reloadAccounts } = options
  const minimalMode = computed(() => app.value?.minimalMode ?? true)
  const uiMessage = useAppMessage()

  /**
   * 「正在跑一个会改数据的操作」（清空邮件列表 / 清空所有数据）。
   *
   * 它与同步状态分别记录，只用来**禁用**这些按钮，不驱动任何 loading ——
   * 因为它们的进度没有可展示的东西，禁用 + 结果提示就够了。
   */
  const clearing = ref(false)

  /**
   * 用量文字里要显示的**实际上限**，由后台给（`settings:usage` 的 `retention`）。
   *
   * ⚠ 以前这里是本地算的：`minimalMode ? 50 : app.mailRetention` ——
   *   而「极简模式的实际上限是写死的 50」这条规则**后台也写了一遍**
   *   （见 `background/main.ts` 的 `settings:usage`，它还特意注释说
   *   「UI 要显示真实值而不是用户配置里的那个」）。
   *
   *   同一件事写在两处就会漂：改一处忘另一处，界面显示的上限和实际生效的对不上，
   *   而用户唯一的判断依据就是这个数字。所以以**后台给的为准**。
   */
  const retentionLimit = ref<number | 'unlimited'>(100)

  const usage = ref<{ count: number, bytesApprox: number } | null>(null)

  async function reloadUsage() {
  /*
   * ⚠ 显式写出真正会读的字段。
   *
   *   这里以前写的是 `send<{ usage: StorageUsage } | null>(…)` —— 一个**比实际载荷窄**
   *   的类型。后果是编译器（以及读代码的人）都不会提醒你「后台还给了 retention」，
   *   于是那个字段被白白算出来、送过来、然后丢掉。
   */
    const result = await send<{ usage: StorageUsage, retention: number | 'unlimited' } | null>(
      'settings:usage',
      undefined,
      null,
    )
    if (!result?.usage)
      return

    usage.value = { count: result.usage.count, bytesApprox: result.usage.bytesApprox }
    // 上限以**后台**为准 —— 理由见 `retentionLimit` 的说明
    if (result.retention !== undefined)
      retentionLimit.value = result.retention
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024)
      return `${bytes} B`
    if (bytes < 1024 * 1024)
      return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const usageText = computed(() => {
    const count = usage.value?.count ?? 0
    const size = formatBytes(usage.value?.bytesApprox ?? 0)
    if (minimalMode.value)
      return t('general.usageUnlimitedText', { count, size })
    return t('general.usageText', { count, limit: retentionLimit.value, size })
  })

  /**
   * 待确认的破坏性操作（两个动作共用）。
   *
   * ⚠ 从「`window.confirm` + `if (!confirm()) return`」改成**弹窗组件 + 待办动作**
   *   之后，流程变成两段：点击只登记「想做什么」，真正的动作在弹窗的确认回调里跑。
   *   这么改是因为原生 `confirm` 的样式与产品完全脱节（深色主题下尤其突兀），
   *   而这里的两个动作（清空邮件列表 / 清空所有数据）都不可撤销，
   *   正需要弹窗把后果写清楚。
   *
   * ⚠ 必须**解构**（理由见 `confirm-action.ts` 的文件头）。
   */
  const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

  /**
   * 清空邮件列表（不可撤销）。
   *
   * ⚠ 必须看返回值。`send` 在消息失败 / 超时时返回的是**兜底值**（这里 `{ ok: false }`），
   *   它不会抛错（见 `logic/bridge.ts` 的 `send`）—— 所以「不看返回值就报成功」
   *   会让「一封都没删掉」和「已清空」在界面上完全一样。
   */
  function onClearMails() {
    askConfirm({
      title: t('general.clearMails'),
      message: t('general.confirmClearMails'),
      confirmText: t('general.clearMails'),
      run: async () => {
        clearing.value = true
        try {
          const result = await send<{ ok: boolean }>('settings:clear-mails', undefined, { ok: false })
          if (!result.ok) {
            uiMessage.error(t('general.clearMailsFailed'), ERROR_DURATION)
            return
          }
          uiMessage.success(t('general.clearMailsDone'))
          await reloadUsage()
        }
        finally {
          clearing.value = false
        }
      },
    })
  }

  /** 清空所有数据（不可撤销）—— 返回值处理同 `onClearMails` */
  function onClearAll() {
    askConfirm({
      title: t('general.clearAll'),
      message: t('general.confirmClearAll'),
      confirmText: t('general.clearAll'),
      run: async () => {
        clearing.value = true
        try {
          const result = await send<{ ok: boolean }>('settings:clear-all', undefined, { ok: false })
          if (!result.ok) {
            uiMessage.error(t('general.clearAllFailed'), ERROR_DURATION)
            return
          }
          uiMessage.success(t('general.clearAllDone'))
          await Promise.all([reloadSettings(), reloadUsage(), reloadAccounts()])
        }
        finally {
          clearing.value = false
        }
      },
    })
  }
  return { clearing, usageText, reloadUsage, pending, cancelConfirm, runPending, onClearMails, onClearAll }
}
