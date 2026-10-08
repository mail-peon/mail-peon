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
    /**
     * bg → 所有扩展页面：账号 / 规则 / 设置被改动了，请重载。
     *
     * 为什么需要它：Options 的页面用 `v-show` 切换，`GeneralPage` 在**打开设置页时**
     * 就挂载并读了一次账号（那时是 0 个）。用户随后在「账号」页新建账号，
     * 切回「通用」时组件**不会重新挂载** —— 没有这条广播，那一页会一直显示
     * 「账号 · 0 个」，它上面的「立即同步增量」也就跟着说「没有启用的账号」。
     */
    'data:changed': { reason: 'accounts' | 'rules' | 'settings' }
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
    /**
     * 手动触发一次增量同步。
     *
     * ⚠ 这个 channel **立刻返回**（`{ started: true }`），同步结果通过
     *   `sync:done` 广播回来 —— 它刻意不把「一轮同步」的耗时压在消息往返上。
     *
     *   原因是一个 MV3 的硬限制：Service Worker 在**没有事件** 30 秒后被回收，
     *   而一条**正在进行中**的 `sendMessage` **不算事件**。所以「点同步 → 等它跑完
     *   → 返回结果」这个形态在同步超过 30 秒时必然失败：worker 被杀，promise
     *   永远不 settle，UI 停在「同步中」。
     *
     *   真机上就是这么发生的（用户的邮箱有 3 万多封，一轮同步跑了 32 秒）。
     */
    'accounts:sync-now': ProtocolWithReturn<undefined, { started: boolean }>
    /**
     * 取最近一轮同步的结果 —— UI 的**轮询兜底**。
     *
     * ⚠ 为什么不能只靠 `sync:done` 广播：广播的送达依赖 background 侧 `connMap` 里
     *   有没有那个端点，而它只在对方握手完成后才有条目。于是「页面在 background
     *   重载之前就连上了」「同一 context 有多个连接」「端点名对不上」这三种情况
     *   都会让消息**静默消失** —— 用户看到的是「一直转圈」，**没有任何错误**可查。
     *   真机上就这样卡过。     *
     *   所以 `accounts:sync-now` 立刻返回之后，UI 可以隔一会儿问一次这里。
     *   这不是把长操作塞回消息往返：同步**已经**在后台跑，这只是一次读内存。
     */
    'accounts:sync-status': ProtocolWithReturn<undefined, {
      ok: boolean
      results: SyncSummary[]
      error?: string
      finishedAt?: number
    } | null>
    /** bg → 所有扩展页面：一轮同步结束（成功或失败） */
    'sync:done': { ok: boolean, results: SyncSummary[], error?: string, finishedAt?: number }
    /** Google OAuth 授权（拿 refresh token） */
    'accounts:gmail-authorize': ProtocolWithReturn<{ clientId: string }, { ok: boolean, refreshToken?: string, email?: string, error?: string }>

    // --- 回收站 ---
    /** 回收站列表（按删除时间倒序） */
    'trash:list': ProtocolWithReturn<undefined, { mails: Mail[] }>
    /**
     * 移入回收站。
     *
     * ⚠ 这是**状态变更**，不是删除：只写一个 `trashedAt` 时间戳，
     *   正文与 AI 结果都还在，所以「恢复」是零成本的。
     *   真正的移除是 `trash:delete` / `trash:empty`。
     */
    'trash:trash': ProtocolWithReturn<{ mailId: string }, { ok: boolean, error?: string }>
    /** 从回收站恢复（清掉 `trashedAt`） */
    'trash:restore': ProtocolWithReturn<{ mailId: string }, { ok: boolean, error?: string }>
    /** **彻底删除**一封（硬删除，没有撤销） */
    'trash:delete': ProtocolWithReturn<{ mailId: string }, { ok: boolean }>
    /** **清空回收站**（硬删除全部），返回删掉了几封 */
    'trash:empty': ProtocolWithReturn<undefined, { ok: true, count: number }>

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
