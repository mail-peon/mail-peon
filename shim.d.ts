import type { ProtocolWithReturn } from 'webext-bridge'
import type { ToastPayload } from '~/logic/notification/types'
import type {
  AiSettings,
  AiTestResult,
  AppSettings,
  Mail,
  MailAccount,
  MailTestResult,
  PromptRule,
  StorageUsage,
  SyncSummary,
} from '~/logic/types'

/**
 * 跨上下文消息协议（`webext-bridge` 的 `ProtocolMap`）。
 *
 * 消息命名与 `ai-docs/01-architecture.md § 3` 的表一致；返回体在
 * `logic/types.ts` 里定义（`.d.ts` 只有类型、没有运行时值，
 * 所以运行时要用的形状不能只写在这里）。
 *
 * ⚠ 每个 channel 都必须在这里登记：`webext-bridge` 的失败是**静默**的
 *   （消息名拼错 → 谁都不响应 → 调用方永远等下去），编译期签名是唯一的护栏。
 */
declare module 'webext-bridge' {

  export interface ProtocolMap {
    // --- 邮件 ---
    'mail:list': ProtocolWithReturn<{ limit?: number } | undefined, { mails: Mail[] }>
    'mail:get': ProtocolWithReturn<{ mailId: string }, { mail: Mail | null }>
    /** 标记已读 / 不再显示 */
    'mail:dismiss': ProtocolWithReturn<{ mailId: string, read?: boolean, dismissed?: boolean }, { ok: true }>
    /** Popup 打开时把 badge 归零 */
    'mail:mark-all-read': ProtocolWithReturn<undefined, { ok: true, count: number }>
    /** 复制验证码（content script 在页面 focus 上下文里执行 writeText） */
    'mail:copy-code': ProtocolWithReturn<{ mailId: string, code: string }, { ok: boolean }>
    /** bg → content script：在当前页面顶部弹 toast */
    'mail:toast': ToastPayload
    /** bg → popup/sidepanel：某封邮件已更新，请刷新 */
    'mail:updated': { mailId: string }
    /** bg → popup：用户点了某条 toast，希望定位到那封邮件 */
    'mail:focus': { mailId: string }
    /** content script → bg：toast 上的「点击复制」结果 */
    'mail:manual-copy-result': ProtocolWithReturn<{ mailId: string, ok: boolean }, { ok: true }>

    // --- 账号 ---
    'accounts:list': ProtocolWithReturn<undefined, { accounts: MailAccount[] }>
    'accounts:upsert': ProtocolWithReturn<{ account: MailAccount }, { ok: true, id: string }>
    'accounts:delete': ProtocolWithReturn<{ id: string }, { ok: true }>
    'accounts:test': ProtocolWithReturn<{ account: MailAccount }, MailTestResult>
    /** 把当前游标重置为「现在」（不拉历史） */
    'accounts:reset-cursor': ProtocolWithReturn<{ id: string }, { ok: boolean, error?: string }>
    /** 手动触发一次增量同步 */
    'accounts:sync-now': ProtocolWithReturn<undefined, { ok: true, results: SyncSummary[] }>
    /** Google OAuth 授权（拿 refresh token） */
    'accounts:gmail-authorize': ProtocolWithReturn<{ clientId: string }, { ok: boolean, refreshToken?: string, email?: string, error?: string }>

    // --- 规则 ---
    'rules:list': ProtocolWithReturn<undefined, { rules: PromptRule[] }>
    'rules:upsert': ProtocolWithReturn<{ rule: PromptRule }, { ok: true, id: string }>
    'rules:delete': ProtocolWithReturn<{ id: string }, { ok: true }>
    'rules:move': ProtocolWithReturn<{ id: string, direction: 'up' | 'down' }, { rules: PromptRule[] }>

    // --- 设置 ---
    'settings:get': ProtocolWithReturn<undefined, { app: AppSettings, ai: AiSettings }>
    'settings:set-app': ProtocolWithReturn<{ patch: Partial<AppSettings> }, { app: AppSettings }>
    'settings:set-ai': ProtocolWithReturn<{ patch: Partial<AiSettings> }, { ai: AiSettings }>
    'settings:usage': ProtocolWithReturn<undefined, {
      usage: StorageUsage
      retention: number | 'unlimited'
      /** 账号数量（`accounts:list` 的完整列表另有通道，这里只给数） */
      accountCount: number
      rules: number
      /** 全部账号里最近一次同步时间（UI 展示「5 分钟前」） */
      lastSyncedAt?: number
    }>
    'settings:clear-mails': ProtocolWithReturn<undefined, { ok: true, removed: number }>
    'settings:clear-all': ProtocolWithReturn<undefined, { ok: true }>

    // --- AI ---
    'ai:test': ProtocolWithReturn<{ ai: AiSettings }, AiTestResult>
    'ai:platforms': ProtocolWithReturn<undefined, {
      platforms: Array<{
        value: string
        label: string
        hint: string
        defaultBaseUrl: string
        defaultModel: string
        nativeJson: boolean
      }>
    }>

    // --- 邮箱协议元数据（Options 动态渲染表单） ---
    'mail:providers': ProtocolWithReturn<undefined, {
      providers: Array<{
        value: string
        label: string
        hint: string
        availability: 'ready' | 'needs-relay'
        availabilityNote?: string
        fields: Array<{
          key: string
          label: string
          type: 'text' | 'password' | 'number' | 'toggle'
          placeholder?: string
          required?: boolean
          default?: string | number | boolean
        }>
      }>
    }>

    // --- 兼容模板自带的示例消息（保留，避免模板页面报错） ---
    'tab-prev': { title: string | undefined }
    'get-current-tab': ProtocolWithReturn<{ tabId: number }, { title?: string }>
  }
}
