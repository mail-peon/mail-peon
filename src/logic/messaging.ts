import type { ToastPayload } from './notification/types'
import { onMessage, sendMessage } from 'webext-bridge/background'

/**
 * 跨上下文消息通道的统一封装（`ai-docs/01-architecture.md § 3`）。
 *
 * 为什么要有这一层，而不是各处直接 `sendMessage('mail:list', …)`：
 *
 * 1. **类型集中**：消息体在 `shim.d.ts` 里给 `ProtocolMap` 加签名，拼错消息名
 *    编译期就报错，而不用等到运行时什么都不发生（`webext-bridge` 的失败是静默的）。
 * 2. **「投给谁」这件事有默认值**：`sendMessage` 要求显式指定 `context`，
 *    而「发给内容脚本」这件事 90% 的情况下指的是「当前激活 tab」——
 *    把那三步（查 tab → 查不到就跳过 → 发消息）收在这里，
 *    调用方写 `toActiveTab('mail:toast', payload)` 就够。
 * 3. **没有激活 tab 是正常情况**（所有窗口最小化、当前页是 `chrome://`），
 *    不该让每个调用点都写一遍 try/catch。
 */

/**
 * 拿到当前窗口的激活 tab id。
 *
 * 返回 `null` 表示「没有可用目标」—— 调用方应当**静默跳过**而不是报错：
 * 用户在 chrome:// 页面上、或所有窗口都最小化时，没有 toast 可弹是完全合理的，
 * 而这里抛错会污染 `lastError` 让用户以为同步坏了。
 */
export async function getActiveTabId(): Promise<number | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    return tabs[0]?.id ?? null
  }
  catch {
    return null
  }
}

/** 等 content script 回话的上限 */
const TO_ACTIVE_TAB_TIMEOUT_MS = 2000

/**
 * 给当前激活 tab 的内容脚本发消息。
 *
 * ⚠ 这里有**两个**必须处理的失败模式，而且它们都不是「报错」能解决的：
 *
 * **① 目标端点不存在，webext-bridge 会抛在异步回调里 —— 我们 try/catch 不到。**
 *
 *   `webext-bridge` 的 background 侧无条件读 `connMap.get(dest).fingerprint`
 *   （`dist/background.js` 的 `deliver()`）。目标没注册时那是 `undefined`，
 *   于是抛 `TypeError: Cannot read properties of undefined (reading 'fingerprint')`。
 *
 *   而 `deliver()` 是**异步**调用的（等 `oncePortConnected`），
 *   所以异常逃出 `sendMessage` 的 try/catch，被 Chrome 报成
 *   「Error in event handler」—— 看起来像 background 崩了。
 *
 *   真机场景：用户开着**设置页 / Popup**（它们没有 content script），
 *   这时投 toast 就会撞上。所以「有没有内容脚本」这个问题**不能靠发一次试试**来回答。
 *
 * **② 调用可能永远不返回。**
 *
 *   目标 tab 存在、但里面的 content script 还没连接（页面刚加载、或 SW 刚重启）时，
 *   `sendMessage` 既不 resolve 也不 reject —— 于是**调用方被挂死**。
 *   真机上验证码邮件因此不入库（复制降级走的就是这条路）。
 *
 * 超时 + 不抛错是唯一稳妥的组合：**没送到就当没送到**，调用方用返回值判断。
 */
export async function toActiveTab(channel: string, payload: unknown): Promise<boolean> {
  const tabId = await getActiveTabId()
  if (tabId === null)
    return false

  try {
    const sent = sendMessage(channel as never, payload as never, { context: 'content-script', tabId })
    const timeout = new Promise<null>((resolve) => {
      setTimeout(resolve, TO_ACTIVE_TAB_TIMEOUT_MS, null)
    })
    await Promise.race([sent, timeout])
    return true
  }
  catch {
    // 没有内容脚本（chrome:// / 设置页 / 商店页）或是 SW 刚醒 —— 都不是错误
    return false
  }
}

/**
 * 广播给所有**确实连着**的扩展页面（Popup / Options / Sidepanel）。
 *
 * ⚠ 这里有两个必须遵守的约束，都是被真机故障教出来的：
 *
 * 1. **只发给 `webext-bridge` 认得的 context 名。**
 *    它的 `formatEndpoint` 只对 `background` / `popup` / `options` 原样返回，
 *    其余一律拼成 `<context>@<tabId>`。所以 `{ context: 'sidepanel' }` 会被解析成
 *    **`sidepanel@null`** —— 而 Sidepanel 页面注册自己时用的是 **`sidepanel`**，
 *    两边对不上。后果不是「消息丢了」，而是 background 直接抛
 *    `TypeError: Cannot read properties of undefined (reading 'fingerprint')`
 *    （它内部无条件读 `connMap.get(dest).fingerprint`，不信目标不存在）。
 *
 * 2. **不发给自己没见过的端点。**
 *    同一个 `connMap.get(...)` 在目标没连上时同样是 undefined。
 *
 * 所以这里自己维护一张「活着的扩展页面」表，只往表里的 key 发。
 * 表的来源是 `runtime.onConnect` 的连接名 —— 那正是 `webext-bridge` 注册端点时
 * 用的同一个字符串，所以键一定对得上。
 *
 * ⚠ 已知的残留风险（**没能彻底解决**，见下面的说明）：三个界面页（Popup /
 *   Options / Sidepanel）都通过 `logic/bridge.ts` 注册，而它 import 的是
 *   `webext-bridge/popup` —— 于是它们**共用 `popup` 这一个端点名**。
 *   `webext-bridge` 的 `connMap` 每个名字只留最后一个连接，而任一页面断开时
 *   它会**删掉整个键** —— 于是「另一个页面还开着」的情况下键就没了，
 *   而这里的表还以为它活着 → 广播仍可能撞上 undefined。
 *
 *   根因在 `webext-bridge` 的 `RuntimeContext` 里**没有 `sidepanel`**，
 *   没法给三个页面分配不同的端点名。彻底的解法是不用它的 push 通道、
 *   改成 UI 侧轮询。**当前的缓解措施**：所有 `broadcastToExtension` 的调用方
 *   都不依赖它（UI 有轮询兜底），所以即使这里报一次错，功能不受影响。
 */
const liveExtensionContexts = new Set<string>()

/** 只认 webext-bridge 的 `RuntimeContext`（`sidepanel` 不在其中，见上面的说明） */
const KNOWN_EXTENSION_CONTEXTS = new Set(['popup', 'options', 'devtools'])

/**
 * 从连接名还原出 `webext-bridge` 用的端点名。
 *
 * 连接名是它用 `encodeConnectionArgs` 拼的 JSON：
 * `{"endpointName":"popup","fingerprint":"uid::AbC1234"}`。
 *
 * ⚠ 解析**失败**（不是 JSON、或缺 `endpointName`）时返回空串，调用方应当忽略该连接 ——
 *   扩展里还有别的 `runtime.connect` 使用者，把它们的连接名当端点名会造出一个
 *   永远收不到消息的假目标。
 *
 * 导出是为了能单测：这是纯函数，而它的正确性直接决定广播会不会打到不存在的端点
 * （打到就会在 background 里抛 `reading 'fingerprint'`，见文件头）。
 *
 * @param name `runtime.onConnect` 给的连接名
 * @returns 端点名；无法识别时为空串
 */
export function parseEndpointName(name: string | undefined): string {
  if (!name)
    return ''
  try {
    const parsed = JSON.parse(name) as { endpointName?: unknown }
    return typeof parsed.endpointName === 'string' ? parsed.endpointName : ''
  }
  catch {
    return ''
  }
}

/**
 * 该不该把一个端点加进「活着的扩展页面」表。
 *
 * ⚠ `sidepanel` **不在** webext-bridge 的 `RuntimeContext` 里。它的
 *   `formatEndpoint` 只对 `background` / `popup` / `options` 原样返回端点名，
 *   其余一律拼成 `<context>@<tabId>` —— 所以按 context 名去发 `sidepanel` 会解析成
 *   `sidepanel@null`，而 Sidepanel 页面注册自己时用的是 `sidepanel@<tabId>`。
 *   两边对不上 → `connMap.get()` 返回 undefined → background 抛
 *   `TypeError: Cannot read properties of undefined (reading 'fingerprint')`。
 *
 * 所以 Sidepanel **不通过 context 名**接收广播，而是以 `popup` 身份注册
 * （见 `src/sidepanel/index.html` 里的 context 参数）。
 *
 * @param endpointName 端点名（可带 `@tabId` 后缀）
 */
export function isBroadcastableEndpoint(endpointName: string): boolean {
  if (!endpointName)
    return false
  return KNOWN_EXTENSION_CONTEXTS.has(endpointName.split('@')[0])
}

let connectListenerInstalled = false

function installConnectListener(): void {
  if (connectListenerInstalled)
    return
  connectListenerInstalled = true

  try {
    browser.runtime.onConnect.addListener((port) => {
      const endpointName = parseEndpointName(port.name)
      if (!isBroadcastableEndpoint(endpointName))
        return

      liveExtensionContexts.add(endpointName)
      port.onDisconnect.addListener(() => {
        liveExtensionContexts.delete(endpointName)
      })
    })
  }
  catch {
    // 没有 runtime.onConnect（例如单测的桩）时不广播，也不报错
  }
}

export function broadcastToExtension(channel: string, payload: unknown): void {
  installConnectListener()

  if (!liveExtensionContexts.size)
    return

  for (const context of liveExtensionContexts) {
    const destination = { context } as unknown as Parameters<typeof sendMessage>[2]
    void sendMessage(channel as never, payload as never, destination).catch(() => {
      // 页面刚好在这一刻关掉 —— 正常，不是错误
    })
  }
}

/** 把 toast 投给当前激活页面（背景侧调用的唯一入口） */
export async function deliverToast(payload: ToastPayload): Promise<boolean> {
  return toActiveTab('mail:toast', payload)
}

export { onMessage, sendMessage }
