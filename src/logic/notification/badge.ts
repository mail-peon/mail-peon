import type { AppSettings } from '~/logic/types'
import { readRecentMails } from '~/logic/store/mails'
import { readAppSettings } from '~/logic/store/settings'
import { badgeCount } from '~/logic/types'

/**
 * icon badge（`features/02-ai-summary.md § 6.1`）。
 *
 * ⚠ **不用 `chrome.notifications`**：设计文档明确改掉了系统通知 —— 新邮件只在 icon
 *   右上角显示数字，用户点 icon = 看 Popup。理由是扩展不该在 OS 层打扰用户，
 *   而「有多少封没看」这件事用 badge 表达得更轻。
 *
 * badge 的计数规则在 `logic/types.ts` 的 `badgeCount()` 里（纯函数、可单测），
 * 这里只负责「算出来之后怎么画上去」。
 */

export const BADGE_COLOR = '#3B82F6'

/** 上限：超过显示 `99+`（Chrome 的 badge 最多显示 4 个字符） */
const BADGE_MAX = 99

export function formatBadgeText(count: number): string {
  if (count <= 0)
    return ''
  if (count > BADGE_MAX)
    return '99+'
  return String(count)
}

/**
 * 用当前库里的邮件重算 badge。
 *
 * `count` 传了就直接用（调用方刚算过，避免重复遍历）；不传则读库重算。
 */
export async function refreshBadge(count?: number): Promise<void> {
  try {
    const app = await readAppSettings()

    if (!app.notifyOnNew) {
      // master switch 关掉：badge 也要清掉。只「不再更新」的话，
      // 用户会看到一个永远不会变的数字，那比没有 badge 更让人困惑。
      await setBadgeText('')
      return
    }

    const resolved = count ?? badgeCount(await readRecentMails(500), app)
    await setBadgeText(formatBadgeText(resolved))
  }
  catch (error) {
    // badge 失败绝不该影响同步：它只是装饰
    console.warn('[mail-peon] 更新 badge 失败', error)
  }
}

/** 打开 Popup 时清零（设计文档：点 icon = 看 Popup，badge 归零） */
export async function clearBadge(): Promise<void> {
  await setBadgeText('')
}

async function setBadgeText(text: string): Promise<void> {
  const action = (globalThis as { browser?: typeof browser }).browser?.action
  // Firefox 的 MV3 也用 `action`（`browserAction` 是 MV2），所以这一个分支够用
  if (!action?.setBadgeText)
    return

  await action.setBadgeText({ text })
  if (text && action.setBadgeBackgroundColor)
    await action.setBadgeBackgroundColor({ color: BADGE_COLOR })
}

/**
 * 仅用于测试 / 诊断：算一遍当前应有的 badge 数字。
 *
 * 抽出来是因为「badge 该显示几」是产品规则（排除广告、排除已复制的验证码），
 * 而它值得被断言 —— 真机上验证「广告邮件不加 badge」需要构造一封真邮件。
 */
export async function computeBadgeCount(app?: Pick<AppSettings, 'excludeAds'>): Promise<number> {
  const settings = app ?? await readAppSettings()
  return badgeCount(await readRecentMails(500), settings)
}
