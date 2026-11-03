import { sendMessage } from 'webext-bridge/popup'
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
export const REQUEST_TIMEOUT_MS = 8000

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
export const SLOW_REQUEST_TIMEOUT_MS = 3 * 60 * 1000

/** 这些消息走慢超时 */
export const SLOW_CHANNELS = new Set([
  'accounts:sync-now',
  'accounts:test',
  'accounts:reset-cursor',
  'accounts:gmail-authorize',
  'ai:test',
])

export async function send<T>(channel: string, payload: unknown, fallback: T): Promise<T> {
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

export function withTimeout<T>(promise: Promise<T>, ms: number, channel: string): Promise<T> {
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
