import type { MailAccount } from '~/logic/types'
import type { UiStatusText } from '~/logic/ui-status'
import { t } from '~/logic/strings'

/**
 * 账号卡片的**连接状态**（颜色 + 状态词 + 悬停详情）。
 *
 * ## 为什么单独一个模块
 *
 * 「什么情况显示什么颜色」是这一屏最容易被改坏、又最难在界面上验证的东西：
 * 一个账号停在错误状态时，它和正常账号在 DOM 上长得几乎一样（只差一个 class）。
 * 抽成纯函数之后，颜色策略可以被单测钉住（见 `__tests__/accounts-status.spec.ts`）。
 *
 * ## 三档颜色的语义（产品要求）
 *
 * | 颜色 | 什么时候 |
 * | --- | --- |
 * | 🟡 黄 | **耗时操作进行中**（测试连接 / 重置同步位置）——它表示「正在做，等着」 |
 * | 🔴 红 | 有报错：这次操作失败，或上一次同步留下的 `lastError` |
 * | 🟢 绿 | 已连接（最近一次同步 / 测试是成功的） |
 * | ⚪️ 灰 | 既没连上也没报错：**从未同步**过，或账号已停用 |
 *
 * ⚠ 灰色这一档是**必需的**：一个刚加进来还没同步过的账号显示成绿色
 *   「已连接」就是在撒谎 —— 而它恰恰是用户最需要知道「还没连上」的时刻。
 *
 * ⚠ 优先级是 `进行中 > 刚失败 > 历史错误 > ...`：正在做的事比历史记录更值得看，
 *   而「刚点了一次测试、它失败了」比库里存着的那条旧错误更接近事实。
 *
 * ⚠ 返回值就是 `StatusBadge` 的 props（字段名对齐，见 `logic/ui-status.ts`），
 *   调用方直接 `v-bind` 即可。
 */

/** 一次「测试连接 / 重置同步位置」的结果（`AccountsPage` 的 `testState` 里那种） */
export interface AccountTestState {
  status: 'idle' | 'busy' | 'ok' | 'fail'
  text: string
}

/** 账号的连接状态（= 状态徽标的 props） */
export type AccountStatus = UiStatusText

/**
 * @param account 账号记录（只需要状态相关的字段）
 * @param test 这个账号最近一次操作的结态；没有就是 `undefined`
 * @param meta 已经格式化好的文案（保持本函数是纯的，不在这里算时间 / 解析游标）
 * @param meta.lastSyncText 「上次同步」那一行的文案（例如「14 小时前」）
 * @param meta.cursorText 「同步位置」那一行的文案（例如「UID 37744」）
 */
export function accountStatus(
  account: Pick<MailAccount, 'enabled' | 'lastError' | 'lastSyncedAt'>,
  test: AccountTestState | undefined,
  meta: { lastSyncText: string, cursorText: string },
): AccountStatus {
  // 1. 耗时操作进行中 —— 黄色
  if (test?.status === 'busy')
    return { status: 'warning', label: t('accounts.statusConnecting'), detail: test.text }

  // 2. 刚做过的操作失败了 —— 红色（比历史错误更近）
  if (test?.status === 'fail')
    return { status: 'error', label: t('accounts.statusTestFailed'), detail: test.text }

  // 3. 上一次同步留下的错误 —— 红色
  if (account.lastError) {
    return {
      status: 'error',
      label: t('accounts.statusFailed'),
      // 停用的账号仍可能保留一条历史错误：把它留在 tooltip 里，
      // 但补一句「它现在不参与同步」，否则用户会以为还在反复失败
      detail: account.enabled ? account.lastError : account.lastError + t('accounts.disabledSuffix'),
    }
  }

  // 4. 刚测试通过 —— 绿色（tooltip 给这次的结果，例如「收件箱有 128 封邮件」）
  if (test?.status === 'ok' && test.text)
    return { status: 'success', label: t('accounts.statusConnected'), detail: test.text }

  // 5. 停用 —— 灰色
  if (!account.enabled)
    return { status: 'default', label: t('accounts.statusDisabled'), detail: t('accounts.disabledHint') }

  // 6. 从未同步过 —— 灰色（**不能**是绿色，见文件头）
  if (!account.lastSyncedAt)
    return { status: 'default', label: t('accounts.statusNeverSynced'), detail: t('accounts.neverSyncedHint') }

  // 7. 正常 —— 绿色，tooltip 给「上次同步 + 同步位置」
  return {
    status: 'success',
    label: t('accounts.statusConnected'),
    detail: `${t('accounts.lastSync')}：${meta.lastSyncText} · 同步位置：${meta.cursorText}`,
  }
}
