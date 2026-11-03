import type { AiSettings, AppSettings, MailFilterId, MailRetention } from '~/logic/types'
import { BUILTIN_CODE_ID, CHECK_INTERVAL_MAX_MINUTES, CHECK_INTERVAL_MIN_MINUTES, createDefaultAiSettings, createDefaultAppSettings, MAIL_RETENTION_OPTIONS } from '~/logic/types'
import { bool, mergeDefaults, num, str } from './common'
// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
export const RETENTION_VALUES = new Set<string>(MAIL_RETENTION_OPTIONS.map(String))

export function normalizeRetention(raw: unknown, fallback: MailRetention): MailRetention {
  if (raw === 'unlimited')
    return 'unlimited'
  const asText = String(raw)
  if (RETENTION_VALUES.has(asText) && asText !== 'unlimited')
    return Number(asText) as MailRetention
  return fallback
}

/**
 * 自动检查间隔归一：只接受 1–60 的整数分钟。
 *
 * 用户可能手改导出文件 / 旧版本没有这个字段；0、负数、NaN、小数都要落回一个
 * **能真的建 alarm** 的值。`chrome.alarms` 不接受 0；大于 60 分钟没必要限制，
 * 但 UI 只有 1–60，保持同一范围。
 */
export function clampCheckInterval(raw: unknown, fallback: number): number {
  const value = num(raw, fallback)
  if (!Number.isFinite(value))
    return fallback
  return Math.min(
    CHECK_INTERVAL_MAX_MINUTES,
    Math.max(CHECK_INTERVAL_MIN_MINUTES, Math.round(value)),
  )
}

export function normalizeAppSettings(raw: unknown): AppSettings {
  const defaults = createDefaultAppSettings()
  const merged = mergeDefaults(raw, defaults)
  return {
    ...merged,
    minimalMode: bool(merged.minimalMode, defaults.minimalMode),
    excludeAds: bool(merged.excludeAds, defaults.excludeAds),
    autoCopyCode: bool(merged.autoCopyCode, defaults.autoCopyCode),
    blockedEnabled: bool(merged.blockedEnabled, defaults.blockedEnabled),
    notifyOnNew: bool(merged.notifyOnNew, defaults.notifyOnNew),
    checkIntervalMinutes: clampCheckInterval(merged.checkIntervalMinutes, defaults.checkIntervalMinutes),
    popupDefaultTab: normalizePopupFilterId(merged.popupDefaultTab),
    mailRetention: normalizeRetention(merged.mailRetention, defaults.mailRetention),
    mailRetentionDays: Math.max(0, num(merged.mailRetentionDays, 0)),
    /*
     * 存量设置里没有这个字段 → `mergeDefaults` 会补上默认值（`true`）。
     * 这里再兜一道 `bool` 是为了防住「用户手改过导出文件」那种情况。
     */
    autoDeleteExpiredCode: bool(merged.autoDeleteExpiredCode, defaults.autoDeleteExpiredCode),
    schemaVersion: num(merged.schemaVersion, 1),
  }
}

/**
 * 筛选 id 归一。
 *
 * - 旧版枚举：`'code'` 已经没有这个 tab 了，映射到 `adapter:builtin:code`；
 * - 新格式：`'important' | 'all' | 'ad' | 'adapter:<id>'`；
 * - 其它（乱写 / 指向已删除的适配器）→ `'important'`。
 *   Popup 启动时还会再校验一次「这个适配器现在还在不在」，不在就回退。
 */
export function normalizePopupFilterId(raw: unknown): MailFilterId {
  const value = str(raw)
  if (value === 'important' || value === 'all' || value === 'ad')
    return value
  if (value === 'code')
    return `adapter:${BUILTIN_CODE_ID}`
  if (value.startsWith('adapter:') && value.length > 'adapter:'.length)
    return value as MailFilterId
  return 'important'
}

export function normalizeAiSettings(raw: unknown): AiSettings {
  const defaults = createDefaultAiSettings()
  const merged = mergeDefaults(raw, defaults)
  return {
    platform: str(merged.platform, defaults.platform) || defaults.platform,
    baseUrl: str(merged.baseUrl),
    apiKey: str(merged.apiKey),
    model: str(merged.model),
    maxTokens: Math.max(1, num(merged.maxTokens, 2048)),
    thinking: bool(merged.thinking, false),
    outputLanguage: merged.outputLanguage === 'auto-email' ? 'auto-email' : 'auto-browser',
  }
}
