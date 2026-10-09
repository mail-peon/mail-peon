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
 * ## 四档颜色的语义（产品要求）
 *
 * | 颜色 | 什么时候 |
 * | --- | --- |
 * | 🟡 黄 | **耗时操作进行中**（测试连接 / 重置同步位置）——它表示「正在做，等着」 |
 * | 🔴 红 | 有报错：这次探测失败，或上一次同步留下的 `lastError` |
 * | 🟢 绿 | 已连接（最近一次同步 / 探测是成功的） |
 * | ⚪️ 灰 | 既没连上也没报错：**从未同步**过，或账号已停用 |
 *
 * ⚠ 灰色这一档是**必需的**：一个刚加进来还没同步过的账号显示成绿色
 *   「已连接」就是在撒谎 —— 而它恰恰是用户最需要知道「还没连上」的时刻。
 *
 * ⚠ 优先级是 `进行中 > 刚失败 > 历史错误 > ...`：正在做的事比历史记录更值得看，
 *   而「刚点了一次测试、它失败了」比库里存着的那条旧错误更接近事实。
 *
 * ## ⚠⚠ 「正在做什么」与「做完了怎么样」是两个输入
 *
 * 这里刻意收**两个**参数：`busy`（进行中的操作种类）与 `probe`（最近一次连接探测的结果）。
 *
 * 曾经它们合用一个 `{ status: 'busy' | 'ok' | 'fail' }` 槽位，于是有两个后果：
 *
 *   1. **按钮转错**：「重置同步位置」在跑的时候，`status === 'busy'` 让**测试连接**
 *      那个按钮转圈（真机上就是这么被发现的）；
 *   2. **状态词撒谎**：黄灯只能说「连接中…」，而当时根本没在连接，是在重置。
 *
 * 现在 `busy` 带上**种类**（`test` / `reset`），两件事就分得开了 ——
 * 按钮的 loading 判据也从这里取，不再靠「谁写了那个槽位」去猜。
 *
 * ⚠ 返回值就是 `StatusBadge` 的 props（字段名对齐，见 `logic/ui-status.ts`），
 *   调用方直接 `v-bind` 即可。
 */

/** 这个账号上正在跑的**耗时操作**（同一时刻只可能有一个） */
export type AccountBusyKind = 'test' | 'reset'

/**
 * 最近一次**连接探测**的结果。
 *
 * ⚠ 只有「测试连接」会写它 —— 它是**健康度**信息（能不能连上这个邮箱）。
 *   「重置同步位置」这种一次性操作的回执走全局 message，不往这里塞：
 *   否则一次成功的重置会让卡片一直显示一个和维护动作有关的 tooltip。
 *   （重置**失败**时会由 background 写进 `lastError`，那一档本来就会变红。）
 */
export interface AccountProbeResult {
  ok: boolean
  text: string
}

/** 账号的连接状态（= 状态徽标的 props） */
export type AccountStatus = UiStatusText

export interface AccountStatusInput {
  /** 账号记录（只需要状态相关的字段） */
  account: Pick<MailAccount, 'enabled' | 'lastError' | 'lastSyncedAt'>
  /** 最近一次「测试连接」的结果；没测过就是 `undefined` */
  probe?: AccountProbeResult
  /** 正在进行的耗时操作；没有就是 `undefined` */
  busy?: AccountBusyKind
  /** 已经格式化好的文案（保持本函数是纯的，不在这里算时间 / 解析游标） */
  meta: {
    /** 「上次同步」那一行的文案（例如「14 小时前」） */
    lastSyncText: string
    /** 「同步位置」那一行的文案（例如「UID 37744」） */
    cursorText: string
  }
}

export function accountStatus(input: AccountStatusInput): AccountStatus {
  const { account, probe, busy, meta } = input

  // 1. 耗时操作进行中 —— 黄色。**状态词要说出在做什么**：
  //    「连接中…」用在重置上就是错的（那时没在连接），而用户正是靠这几个字
  //    判断「刚才那一下点到没有、现在能不能再点」。
  if (busy) {
    return busy === 'test'
      ? { status: 'warning', label: t('accounts.testing'), detail: t('accounts.testing') }
      : { status: 'warning', label: t('accounts.resetting'), detail: t('accounts.resetting') }
  }

  // 2. 探测失败 —— 红色（比历史错误更近）
  if (probe && !probe.ok)
    return { status: 'error', label: t('accounts.statusTestFailed'), detail: probe.text }

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

  // 4. 探测通过 —— 绿色（tooltip 给这次的结果，例如「收件箱有 128 封邮件」）
  if (probe?.text)
    return { status: 'success', label: t('accounts.statusConnected'), detail: probe.text }

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
