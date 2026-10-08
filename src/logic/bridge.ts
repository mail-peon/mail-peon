import type { Ref } from 'vue'
import type { AiSettings, AppSettings, Mail } from '~/logic/types'
import { onMounted, onUnmounted, ref } from 'vue'
import { onMessage, sendMessage } from 'webext-bridge/popup'
import { useCopyFeedback } from '~/logic/copy-feedback'

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
 *
 * ## ⚠ 为什么三个页面都 import `webext-bridge/popup`
 *
 * 因为 `webext-bridge` 的入口模块**决定了这个页面注册成哪个 context**，而它认得
 * 的 context 只有 `background` / `popup` / `options` / `devtools` / `content-script` /
 * `window` —— **没有 `sidepanel`**。
 *
 * 如果为了「语义正确」给 Sidepanel 换一个入口，或者让 background 按 context 名去发
 * `{ context: 'sidepanel' }`，`formatEndpoint` 会把它拼成 `sidepanel@null`，
 * 而 `connMap.get()` 返回 undefined，background 直接抛
 * `TypeError: Cannot read properties of undefined (reading 'fingerprint')`。
 * 这个错误**不会**表现为「Sidepanel 收不到消息」，而是让 background 报错。
 *
 * 所以三个页面统一以 `popup` 身份注册。代价是一个已知限制：
 *
 * > `webext-bridge` 的 `connMap` 每个 context 名只留**最后一个**连接，
 * > 所以同时开着 Popup 和 Options 时，两者中只有一个能收到广播。
 *
 * 这个限制在当前用法下没有实际影响：广播只有两种（`mail:updated` / `data:changed`
 * / `sync:done`），而每个界面在挂载时都会主动 `send` 拉一次全量数据 ——
 * 广播只是「锦上添花」的即时刷新，丢一次不会让界面停在错误状态。
 */

/**
 * 消息请求的超时（毫秒）。
 *
 * 默认 8 秒：绝大多数消息都是「读一点本地数据」，几毫秒就该回来 ——
 * 超过 8 秒基本说明 background 出问题了，让 UI 显示「加载失败」比一直转圈强。
 */
const REQUEST_TIMEOUT_MS = 8000

/**
 * **慢**消息的超时。
 *
 * 有些消息天生要干几十秒的活，用 8 秒会把正常操作误判成失败：
 *
 *   - `accounts:sync-now` —— 一轮同步要连邮箱、登录、拉正文、逐封解析。
 *     用户的邮箱有 3 万多封时，一批 50 封也可能跑很久。
 *   - `accounts:test` —— 要建立 TCP + TLS + 登录往返。
 *   - `accounts:reset-cursor` —— 同上。
 *
 * 之前这些都用 8 秒，真机表现是「点立即同步 → 8 秒后报『请求超时
 * （background 可能正在休眠）』」—— 而 background 其实正在正常干活，
 * 报错信息里的猜测把排查方向带偏了。
 */
const SLOW_REQUEST_TIMEOUT_MS = 3 * 60 * 1000

/** 这些消息走慢超时 */
const SLOW_CHANNELS = new Set([
  'accounts:sync-now',
  'accounts:test',
  'accounts:reset-cursor',
  'accounts:gmail-authorize',
  'ai:test',
])

async function send<T>(channel: string, payload: unknown, fallback: T): Promise<T> {
  const timeout = SLOW_CHANNELS.has(channel) ? SLOW_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
  try {
    const result = await withTimeout(
      sendMessage(channel as never, payload as never, { context: 'background' } as never),
      timeout,
      channel,
    )
    return (result as T) ?? fallback
  }
  catch (error) {
    console.warn(`[mail-peon] 消息 ${channel} 失败`, error)
    return fallback
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, channel: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      /*
       * ⚠ 报错文案不能猜原因。原文案是「background 可能正在休眠」——
       *   而真机上这次超时其实是**邮件太多、一批拉不完**，那句猜测把排查
       *   方向直接带偏了（去看 SW 休眠，而问题在 IMAP 拉取策略）。
       *   现在只陈述事实：哪条消息、等了多久。
       */
      reject(new Error(`「${channel}」等待超过 ${Math.round(ms / 1000)} 秒仍未返回`))
    }, ms)
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

/**
 * 「账号 / 规则 / 设置被改动了」的订阅者。
 *
 * ⚠ 这一套是**必需的**，不是优化。原因是一个很容易踩的 UI 生命周期事实：
 *
 *   Options 的页面用 `v-show` 切换（见 `Options.vue`），所以 `GeneralPage`
 *   在**打开设置页的那一刻就挂载了**，并在 `onMounted` 里读了一次账号 ——
 *   而那时用户还没添加任何账号。之后他切到「账号」页新建，再切回「通用」，
 *   `GeneralPage` **不会重新挂载**，于是它一直显示「账号 · 0 个」，
 *   「立即同步增量」也跟着用不上（它依赖那份账号列表做前置检查）。
 *
 *   真机症状：账号页明明有账号、测试连接也通过，通用页却坚持说「没有启用的账号」。
 *
 * 修法是让写操作**广播**出来，由订阅者重载 —— 而不是在每个组件里 `watch`
 * 一个共享状态（那要求所有页面共用同一份响应式数据，跨 `v-show` 的组件做不到）。
 */
const dataChangeListeners = new Set<() => void>()

/** 「一轮同步结束」的订阅者，见 `onSyncDone` */
interface SyncDonePayload {
  ok: boolean
  results: import('~/logic/types').SyncSummary[]
  error?: string
  /** 完成时刻（`Date.now()`），用来判断「这是不是我这次点击的结果」 */
  finishedAt?: number
}
const syncDoneListeners = new Set<(result: SyncDonePayload) => void>()

let bridgeListenerInstalled = false

function installBridgeListener(): void {
  if (bridgeListenerInstalled)
    return
  bridgeListenerInstalled = true
  onMessage('mail:updated', () => {
    for (const listener of mailUpdateListeners)
      listener()
  })
  onMessage('data:changed', () => {
    for (const listener of dataChangeListeners)
      listener()
  })
  onMessage('sync:done', ({ data }) => {
    for (const listener of syncDoneListeners)
      listener(data)
  })
}

/**
 * 订阅「数据被改动」。返回取消订阅函数（组件卸载时调用）。
 *
 * 用在需要跟着账号 / 规则 / 设置变化刷新的地方。
 */
export function onDataChanged(listener: () => void): () => void {
  installBridgeListener()
  dataChangeListeners.add(listener)
  return () => dataChangeListeners.delete(listener)
}

/**
 * 订阅「一轮同步结束」。
 *
 * ⚠ 同步**不是**通过 `send()` 的返回值告知结果的，而是走广播 ——
 *   原因见 `background/main.ts` 里 `accounts:sync-now` 的注释：
 *   MV3 的 worker 在没有事件 30 秒后被回收，而挂着一条未完成的 `sendMessage`
 *   不算事件，所以「等同步跑完再返回」在同步较慢时必然失败。
 *
 * 返回取消订阅函数。
 */
export function onSyncDone(
  listener: (result: SyncDonePayload) => void,
): () => void {
  installBridgeListener()
  syncDoneListeners.add(listener)
  return () => syncDoneListeners.delete(listener)
}

export function useMails(limit = 200) {
  const mails = ref<Mail[]>([]) as Ref<Mail[]>
  const loading = ref(true)

  async function reload() {
    /*
     * ⚠ 计时「UI 侧看到的往返耗时」，而不是只看 background 内部耗时。
     *
     *   两者的差值是**消息通道**的开销 —— 真机上那个「十几秒才显示」如果出在这里，
     *   background 的日志会显示它很快就返回了，而 UI 直到很久之后才拿到。
     *   只有两侧都计时才能分清是「库慢」还是「消息慢」。
     */
    const started = Date.now()
    const result = await send<{ mails: Mail[] }>('mail:list', { limit }, { mails: [] })
    const elapsed = Date.now() - started

    mails.value = result.mails
    loading.value = false

    if (elapsed > 300)
      console.warn(`[mail-peon] mail:list 往返慢：${result.mails.length} 条用了 ${elapsed}ms`)
  }

  /**
   * 「刚刚复制成功」的瞬时反馈（**纯前端，不落库**）。
   *
   * 实现与踩过的坑都在 `logic/copy-feedback.ts` 里；这里只是接上它。
   * 单独一个模块是为了能**直接用假定时器测**「几秒后复原」那个行为 ——
   * 它埋在 `useMails`（要连 store 与消息通道）里的话根本测不动，
   * 而真机上坏掉的恰恰就是它。
   */
  const { justCopied, markCopied: markJustCopied } = useCopyFeedback()

  /**
   * 复制验证码。
   *
   * ## ⚠ 为什么在**这里**写剪贴板，而不是让 background 代劳
   *
   * `navigator.clipboard.writeText` 要求调用它的**文档处于 focused 状态**。
   *
   *   - background（MV3 Service Worker）**没有文档** —— 它那次调用经常直接抛
   *     `NotAllowedError`，所以才有了「降级给 content script」那一套；
   *   - 而 **Popup / Sidepanel 自己就是 focused 文档** —— 由用户点一下触发，
   *     这是剪贴板 API 最理想的调用场景，几乎必然成功。
   *
   * 早期实现把这一步交给 background 的 `copyViaContentScript`，它打的是
   * **当前激活 tab 的 content script** —— 而用户点弹窗里的复制按钮时，
   * 激活页往往就是扩展自己的页面（`chrome-extension://…`），
   * 那里**没有 content script**。于是消息石沉大海，超时后返回 `ok: false`：
   * 用户看到的正是「复制按钮无效」。
   *
   * ## ⚠ 全程不落库
   *
   * 手动复制**不写任何持久状态**（理由见 `justCopied` 的说明）。
   * 剪贴板里那句 `writeText` 本身就是结果，写进去了就成功了 ——
   * 不需要再让后台记一笔。
   *
   * ⚠ 写失败时才回退给 background（`mail:copy-code`）：它还有 content script
   *   那一级，比直接放弃多一次机会。那条路才会落库为 `'failed'`。
   *
   * ⚠ 这是「点击复制」这条路；**自动复制**（收到验证码时）仍然走 background
   *   那套三级降级，那条路没有 focused 文档可用。
   *
   * @param mail 邮件
   * @returns 是否复制成功
   */
  async function copyCode(mail: Mail) {
    const code = mail.code ?? mail.ai?.code
    if (!code)
      return false

    let ok = false
    try {
      await navigator.clipboard.writeText(code)
      ok = true
    }
    catch (error) {
      console.warn('[mail-peon] 页面内写剪贴板失败，回退给 background', error)
      const result = await send<{ ok: boolean }>('mail:copy-code', { mailId: mail.id, code }, { ok: false })
      ok = result.ok
    }

    if (ok)
      markJustCopied(mail.id)

    return ok
  }

  async function setRead(mail: Mail, read: boolean) {
    await send('mail:dismiss', { mailId: mail.id, read }, { ok: false })
    await reload()
  }

  async function dismiss(mail: Mail) {
    await send('mail:dismiss', { mailId: mail.id, dismissed: true }, { ok: false })
    await reload()
  }

  /**
   * 把一封邮件移入回收站。
   *
   * ⚠ 用户可见的说法是「删除」，但底层是**状态变更**（写一个 `trashedAt`），
   *   所以这里可以乐观地立刻从列表里摘掉而不必等广播回来 ——
   *   真出错了回收站页里也找得到它（不会凭空消失）。
   *
   *   刻意**不**做乐观更新：`reload()` 一次只花几毫秒，
   *   而乐观更新在「操作失败」时要回滚，回滚代码是 bug 的高发区。
   *   等广播 + `reload()` 的代价很小，换来的是「界面永远等于库里的真相」。
   *
   * @param mail 要移入回收站的邮件
   * @returns 是否成功
   */
  async function trash(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:trash', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
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

  return { mails, loading, justCopied, reload, copyCode, setRead, dismiss, trash, markAllRead }
}

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

/**
 * 回收站页用的数据与操作。
 *
 * ## 两条语义（产品要求，别搞混）
 *
 * - **移入回收站**（`trash`）= 状态变更。只写一个 `trashedAt`，记录本身不动，
 *   所以「恢复」是零成本的。用户看到的「删除」按钮走的其实是这条。
 * - **彻底删除**（`deleteForever` / `empty`）= **硬删除**。直接从 IndexedDB 移除，
 *   没有撤销。刻意不做软删除：回收站本身已经是软删除层了，
 *   在它下面再叠一层只会让「彻底删除」名不副实。
 */
export function useTrash() {
  const mails = ref<Mail[]>([]) as Ref<Mail[]>
  const loading = ref(true)

  async function reload() {
    const result = await send<{ mails: Mail[] }>('trash:list', undefined, { mails: [] })
    mails.value = result.mails
    loading.value = false
  }

  /** 从回收站恢复（清掉 `trashedAt`，邮件回到主列表） */
  async function restore(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:restore', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
  }

  /** **彻底删除**一封（硬删除，不可撤销） */
  async function deleteForever(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:delete', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
  }

  /**
   * 清空回收站。
   *
   * ⚠ 由调用方负责**二次确认** —— 这是全项目唯一一个不可撤销的批量操作。
   *   放在 UI 层确认而不是这里：这里拿不到「用户是不是真的点了确认」这个信息，
   *   而一个会自动执行确认的 `confirm()` 等于没有确认。
   *
   * @returns 删掉了几封
   */
  async function empty() {
    const result = await send<{ ok: boolean, count: number }>('trash:empty', undefined, { ok: false, count: 0 })
    await reload()
    return result.count
  }

  onMounted(() => {
    void reload()
    installBridgeListener()
    /*
     * ⚠ 同时监听两种广播：
     *   - `mail:updated`：单封邮件被移入/移出回收站；
     *   - `data:changed`：清空、以及「失效验证码自动删除」这类**批量**变化
     *     （它一次动很多封，逐封发 `mail:updated` 会把消息通道打满）。
     */
    mailUpdateListeners.add(reload)
    dataChangeListeners.add(reload)
  })

  onUnmounted(() => {
    mailUpdateListeners.delete(reload)
    dataChangeListeners.delete(reload)
  })

  return { mails, loading, reload, restore, deleteForever, empty }
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

  /**
   * 触发一轮同步。
   *
   * ⚠ 只负责「让后台开始」，不等待结果。原因见 `background/main.ts` 里
   *   `accounts:sync-now` 的注释（MV3 worker 30 秒回收，挂着的 `sendMessage`
   *   不算事件）。
   *
   * @returns 是否成功启动；`startedAt` 是本次点击的时刻，
   *          调用方拿它和 `syncStatus()` 的 `finishedAt` 比对
   */
  async function syncNow() {
    const startedAt = Date.now()
    const result = await send<{ started: boolean }>('accounts:sync-now', undefined, { started: false })
    return { ...result, startedAt }
  }

  /**
   * 取最近一轮同步的结果（**轮询兜底**）。
   *
   * `setTimeout` / `setInterval` 都不好在这里用（组件卸载后还要能取消），
   * 所以只暴露「问一次」，节奏交给调用方。
   */
  async function syncStatus() {
    return send<SyncDonePayload | null>('accounts:sync-status', undefined, null)
  }

  async function authorizeGmail(clientId: string) {
    return send<{ ok: boolean, refreshToken?: string, error?: string }>('accounts:gmail-authorize', { clientId }, { ok: false, error: '请求失败' })
  }

  return { accounts, reload, save, remove, test, resetCursor, syncNow, syncStatus, authorizeGmail }
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
