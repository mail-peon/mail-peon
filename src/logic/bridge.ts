import type { Ref } from 'vue'
import type { AiSettings, AppSettings, Mail } from '~/logic/types'
import { onMounted, onUnmounted, ref } from 'vue'
import { onMessage, sendMessage } from 'webext-bridge/popup'
/**
 * 扩展页面（Popup / Options / Sidepanel）共用的数据访问层。
 *
 * ⚠ 三条规矩，都来自 `01-architecture.md § 1` 的「UI 只渲染 + 收发消息」：
 *
 *   1. **UI 不直接读 IndexedDB**。所有数据都经 `webext-bridge` 问 background 要。
 *      让 UI 直接开库的话，两处都要维护 schema 归一化，而它们迟早会分叉
 *      （UI 读到旧形状、background 读到新形状，表现为「列表里少了几封」）。
 *   2. **`webext-bridge` 的失败是静默的**：消息名拼错 → 谁都不响应 → 调用方
 *      永远等下去。所以每个 `send` 都包了 try/catch 并返回一个安全的默认值，
 *      让 UI 至少能渲染出「加载失败」而不是转圈到天荒地老。
 *   3. **`mail:updated` 是唯一的刷新信号**：background 处理完一封邮件后广播它，
 *      打开的界面据此重载。轮询（`setInterval` 拉一次列表）会让 SW 反复被唤醒，
 *      而 MV3 的 SW 唤醒是有成本的。
 */

/** 消息请求的默认超时（毫秒）。超时后返回 fallback，而不是让 UI 永远转圈 */
const REQUEST_TIMEOUT_MS = 8000

async function send<T>(channel: string, payload: unknown, fallback: T): Promise<T> {
  try {
    const result = await withTimeout(
      sendMessage(channel as never, payload as never, { context: 'background' } as never),
      REQUEST_TIMEOUT_MS,
    )
    return (result as T) ?? fallback
  }
  catch (error) {
    console.warn(`[mail-peon] 消息 ${channel} 失败`, error)
    return fallback
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时（background 可能正在休眠）')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export function useSettings() {
  const app = ref<AppSettings | null>(null)
  const ai = ref<AiSettings | null>(null)

  async function reload() {
    const result = await send<{ app: AppSettings, ai: AiSettings }>('settings:get', undefined, {
      app: null as unknown as AppSettings,
      ai: null as unknown as AiSettings,
    })
    if (result?.app)
      app.value = result.app
    if (result?.ai)
      ai.value = result.ai
  }

  async function setApp(patch: Partial<AppSettings>) {
    // 乐观更新：开关点下去要立刻有反应，等 background 往返会有一帧的迟滞
    if (app.value)
      app.value = { ...app.value, ...patch }
    const result = await send<{ app: AppSettings } | null>('settings:set-app', { patch }, null)
    if (result?.app)
      app.value = result.app
  }

  async function setAi(patch: Partial<AiSettings>) {
    if (ai.value)
      ai.value = { ...ai.value, ...patch }
    const result = await send<{ ai: AiSettings } | null>('settings:set-ai', { patch }, null)
    if (result?.ai)
      ai.value = result.ai
  }

  return { app, ai, reload, setApp, setAi }
}

// ---------------------------------------------------------------------------
// 邮件列表
// ---------------------------------------------------------------------------

/**
 * 已注册的 `mail:updated` 监听器。
 *
 * ⚠ 必须去重：`webext-bridge` 的 `onMessage` 是**累加**注册的，而每个用到
 *   `useMails()` 的组件都会尝试注册一次。不去重的话，Popup 里切换一次 tab
 *   （组件重新挂载）就多一个监听器 —— 每个新邮件广播都会触发 N 次全量重载，
 *   而 N 会随用户点击次数增长。症状是「用久了弹窗越来越卡」。
 *
 * 用一个 Set 而不是布尔量：将来可能有多个界面同时监听（Popup + Sidepanel），
 * 每个都需要刷新自己的列表。
 */
const mailUpdateListeners = new Set<() => void>()
let bridgeListenerInstalled = false

function installBridgeListener(): void {
  if (bridgeListenerInstalled)
    return
  bridgeListenerInstalled = true
  onMessage('mail:updated', () => {
    for (const listener of mailUpdateListeners)
      listener()
  })
}

export function useMails(limit = 200) {
  const mails = ref<Mail[]>([]) as Ref<Mail[]>
  const loading = ref(true)

  async function reload() {
    const result = await send<{ mails: Mail[] }>('mail:list', { limit }, { mails: [] })
    mails.value = result.mails
    loading.value = false
  }

  async function copyCode(mail: Mail) {
    const code = mail.code ?? mail.ai?.code
    if (!code)
      return false
    const result = await send<{ ok: boolean }>('mail:copy-code', { mailId: mail.id, code }, { ok: false })
    if (result.ok) {
      // 本地先改状态：等广播回来再刷新会让按钮延迟半秒才变「已复制」
      const target = mails.value.find(item => item.id === mail.id)
      if (target)
        target.copyStatus = 'copied'
    }
    return result.ok
  }

  async function setRead(mail: Mail, read: boolean) {
    await send('mail:dismiss', { mailId: mail.id, read }, { ok: false })
    await reload()
  }

  async function dismiss(mail: Mail) {
    await send('mail:dismiss', { mailId: mail.id, dismissed: true }, { ok: false })
    await reload()
  }

  async function markAllRead() {
    await send('mail:mark-all-read', undefined, { ok: false })
    await reload()
  }

  onMounted(() => {
    void reload()
    // background 的 `mail:updated` 广播是**唯一**的刷新信号：轮询（setInterval）
    // 会让 SW 反复被唤醒，而 MV3 的 SW 唤醒是有成本的
    installBridgeListener()
    mailUpdateListeners.add(reload)
  })

  onUnmounted(() => {
    mailUpdateListeners.delete(reload)
  })

  return { mails, loading, reload, copyCode, setRead, dismiss, markAllRead }
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

export function useAccounts() {
  const accounts = ref<import('~/logic/types').MailAccount[]>([])

  async function reload() {
    const result = await send<{ accounts: import('~/logic/types').MailAccount[] }>('accounts:list', undefined, { accounts: [] })
    accounts.value = result.accounts
  }

  async function save(account: import('~/logic/types').MailAccount) {
    const result = await send<{ ok: boolean }>('accounts:upsert', { account }, { ok: false })
    await reload()
    return result.ok
  }

  async function remove(id: string) {
    await send('accounts:delete', { id }, { ok: false })
    await reload()
  }

  async function test(account: import('~/logic/types').MailAccount) {
    return send<{ ok: boolean, detail?: string, error?: string }>('accounts:test', { account }, { ok: false, error: '请求失败' })
  }

  async function resetCursor(id: string) {
    return send<{ ok: boolean, error?: string }>('accounts:reset-cursor', { id }, { ok: false, error: '请求失败' })
  }

  async function syncNow() {
    return send<{ ok: boolean, results: import('~/logic/types').SyncSummary[] }>('accounts:sync-now', undefined, { ok: false, results: [] })
  }

  async function authorizeGmail(clientId: string) {
    return send<{ ok: boolean, refreshToken?: string, error?: string }>('accounts:gmail-authorize', { clientId }, { ok: false, error: '请求失败' })
  }

  return { accounts, reload, save, remove, test, resetCursor, syncNow, authorizeGmail }
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export function useRules() {
  const rules = ref<import('~/logic/types').PromptRule[]>([])

  async function reload() {
    const result = await send<{ rules: import('~/logic/types').PromptRule[] }>('rules:list', undefined, { rules: [] })
    rules.value = result.rules
  }

  async function save(rule: import('~/logic/types').PromptRule) {
    await send('rules:upsert', { rule }, { ok: false })
    await reload()
  }

  async function remove(id: string) {
    await send('rules:delete', { id }, { ok: false })
    await reload()
  }

  async function move(id: string, direction: 'up' | 'down') {
    const result = await send<{ rules: import('~/logic/types').PromptRule[] }>('rules:move', { id, direction }, { rules: rules.value })
    rules.value = result.rules
  }

  return { rules, reload, save, remove, move }
}

export { onMessage, send, sendMessage }
