/**
 * 全局领域模型。background / popup / options / sidepanel / content-script 五方共享，
 * 因此这里不引入任何运行时依赖（除了 `nanoid` 这种纯函数），只放类型、常量与默认值。
 *
 * 字段定义与 `ai-docs/design/data-model.md` 一一对应 —— **改这里之前先改文档**。
 */

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/**
 * 邮箱协议标识。
 *
 * 与 offer-hunter 的 `SiteId` 一样是**开放字符串**：provider 是按目录约定自动索引的
 * （`src/adapters/mail/providers/<id>/index.ts`），闭合联合会逼着「加一家 provider
 * 还要改领域模型」。代价是拼错 id 编译器不再拦，改由 `createMailProvider` 在未知
 * id 上抛错 + 注册表单测兜底。
 */
export type MailProviderId = string

/**
 * provider 的「增量游标」。
 *
 * ⚠ 这是对设计文档的一处**必要推广**：文档把游标写死成 IMAP 的 `lastSeenUid`
 *   （数字 UID），但 Gmail API 的增量游标是 `historyId`（字符串），且没有
 *   `UIDVALIDITY` 这种东西。若把 `lastSeenUid` 硬编码进同步编排，加第二个
 *   provider 就要改 `syncAccount` —— 那正是适配器层要消掉的耦合。
 *
 * 形状：`{ ...provider 私有字段 }`。IMAP 放 `{ uid, uidValidity }`，
 *   Gmail 放 `{ historyId }`。**只有对应 provider 自己读得懂**，编排层只负责透传。
 *   `null` = 从未同步过（首次 sync 只记游标，不拉任何历史邮件）。
 */
export type SyncCursor = Record<string, unknown> | null

/**
 * 账号凭据。
 *
 * ⚠ MVP 明文存 IndexedDB（见 `decisions/open-questions.md` Q2）：不存在
 *   「既方便又安全」的密钥来源。Options 里有隐私声明与「清空所有数据」按钮。
 */
export interface ProviderConfig {
  // --- IMAP（需要 WebSocket↔TCP 中继，见 decisions/adr-0005）---
  host?: string
  /** 993 */
  port?: number
  /** true */
  tls?: boolean
  user?: string
  pass?: string
  /** IMAP 中继地址（`wss://…`）；留空表示该 provider 在当前环境不可用 */
  relayUrl?: string

  // --- Gmail API ---
  /** Google OAuth Client ID（`*.apps.googleusercontent.com`） */
  clientId?: string
  /** OAuth 授权码换来的 refresh token */
  refreshToken?: string
  /** 访问令牌 */
  accessToken?: string
  /** 访问令牌过期时刻（ts） */
  expiresAt?: number

  // --- Outlook Graph（M3+ 预留）---
  tenantId?: string
}

export type BlockedEntry
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }

export interface MailAccount {
  /** = accountId（外部键） */
  id: string
  label: string
  /** 邮箱地址；`by-email` 索引按它查 */
  email: string
  /** 协议 id，必须等于 `adapters/mail/providers/<id>/` 的目录名 */
  provider: MailProviderId
  config: ProviderConfig
  /** per-account 排除邮箱（详见 features/06-blocked-senders.md） */
  blockedList: BlockedEntry[]
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /** 增量同步游标；`null` = 从未同步过（首次 sync 只记这个，不拉历史） */
  cursor?: SyncCursor
}

/**
 * 兼容字段：设计文档里的 `lastSeenUid` / `uidValidity`。
 *
 * 读的时候从 `cursor` 里取（见 `readMailCursor`）；写的时候由 IMAP provider 自己
 * 塞进 `cursor`。**不再是 `MailAccount` 的顶层字段** —— 理由见 `SyncCursor`。
 */
export interface ImapCursor {
  uid: number
  uidValidity?: number | null
}

export interface GmailCursor {
  historyId: string
}

/** `MailAccount` 的字段白名单（运行时归一化用；增删字段必须同步改这里，否则编译不过） */
export const MAIL_ACCOUNT_FIELDS: Record<keyof MailAccount, true> = {
  id: true,
  label: true,
  email: true,
  provider: true,
  config: true,
  blockedList: true,
  enabled: true,
  createdAt: true,
  lastSyncedAt: true,
  lastError: true,
  cursor: true,
}
