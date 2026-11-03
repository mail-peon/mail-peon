// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰。
 *
 * ⚠ 极简模式**写死** `MINIMAL_RETENTION`（50 条验证码），不读这个值。
 */
export type MailRetention = 100 | 200 | 500 | 1000 | 'unlimited'

/**
 * 写入邮件时能接受的实际上限。
 *
 * 比 `MailRetention` 宽一档，多出极简模式那个写死的 `MINIMAL_RETENTION = 50`
 * （它不在用户可选的档位里，所以不能塞进 `MailRetention` 的联合类型 —— 那会让
 * 「用户可选 50」在类型上变成合法的，而设置页里根本没有这一项）。
 */
export type RetentionLimit = MailRetention | typeof MINIMAL_RETENTION

export const MAIL_RETENTION_OPTIONS: readonly MailRetention[] = [100, 200, 500, 1000, 'unlimited'] as const

/** 极简模式写死的保留份数（`design/minimal-mode.md § 3.5`） */
export const MINIMAL_RETENTION = 50

/**
 * 列表筛选 id。
 *
 * - `important` / `all` / `ad`：**状态**筛选（重要是派生条件，ad 是 `MailStateFlag.Ad`）
 * - `adapter:<adapterId>`：筛出命中某个适配器的邮件（内置 + 自定义）
 *
 * ⚠ 从 Feature 08 起不再硬编码四个 tab —— 自定义适配器会动态变成筛选标签。
 */
export type MailFilterId = 'all' | 'important' | 'ad' | `adapter:${string}`

/** @deprecated 用 `MailFilterId`（保留别名是为了平滑迁移旧调用点） */
export type PopupTab = MailFilterId

export interface AppSettings {
  /** 两套运行模式：极简（固定验证码 + 确认） / 自定义（用户配置适配器） */
  minimalMode: boolean
  /** 仅自定义模式生效 */
  excludeAds: boolean
  /** 仅自定义模式生效 */
  blockedEnabled: boolean
  /** master switch；关掉后不动 badge */
  notifyOnNew: boolean
  /**
   * @deprecated 自动复制已经迁到「验证码」适配器的 `params.autoCopyCode`。
   *
   * 这里保留只为兼容存量数据：适配器没有显式参数时，pipeline 用它做回退。
   * 通用设置页不再展示这个开关。
   */
  autoCopyCode: boolean
  /**
   * 后台自动检查新邮件的间隔（分钟）。
   *
   * 不是「推送」：MV3 的 SW 无法常驻，打开 Popup 会立即检查一次，这里是
   * 后台最长隔多久主动检查一次。默认 5 分钟，允许 1–60。
   */
  checkIntervalMinutes: number
  /** 仅自定义模式生效；值见 `MailFilterId` */
  popupDefaultTab: MailFilterId
  mailRetention: MailRetention
  /** M3+：默认 0 = 不按时间清理 */
  mailRetentionDays: number

  /**
   * @deprecated 失效验证码自动删除已经迁到「验证码」适配器的
   * `params.autoDeleteExpiredCode`。
   *
   * 这里保留只为兼容存量数据：适配器没有显式参数时，清理任务用它做回退。
   * 回收站页不再展示这个开关。
   */
  autoDeleteExpiredCode: boolean

  schemaVersion: number
}

/** 自动检查间隔的允许范围（分钟） */
export const CHECK_INTERVAL_MIN_MINUTES = 1

export const CHECK_INTERVAL_MAX_MINUTES = 60

export const DEFAULT_CHECK_INTERVAL_MINUTES = 5

export function createDefaultAppSettings(): AppSettings {
  return {
    minimalMode: true,
    excludeAds: true,
    autoCopyCode: true,
    blockedEnabled: true,
    notifyOnNew: true,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    popupDefaultTab: 'important',
    mailRetention: 100,
    mailRetentionDays: 0,
    autoDeleteExpiredCode: true,
    schemaVersion: 1,
  }
}

export type AiPlatformName = string

export type OutputLanguage = 'auto-browser' | 'auto-email'

export interface AiSettings {
  platform: AiPlatformName
  /** 留空时使用平台默认地址 */
  baseUrl?: string
  apiKey: string
  /** 留空时使用平台默认模型 */
  model?: string
  /** 默认 2048 */
  maxTokens?: number
  /** 默认 false（DeepSeek 等开思考会出事：token 被推理链吃光，content 为空） */
  thinking?: boolean
  outputLanguage: OutputLanguage
}

export function createDefaultAiSettings(): AiSettings {
  return {
    platform: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 2048,
    thinking: false,
    outputLanguage: 'auto-browser',
  }
}

// ---------------------------------------------------------------------------
// 存储用量
// ---------------------------------------------------------------------------

export interface StorageUsage {
  count: number
  /** 估算字节数（UTF-16 长度 × 2）—— 不是真实占用，但数量级正确 */
  bytesApprox: number
  byAccount: Record<string, { count: number, bytesApprox: number }>
}
