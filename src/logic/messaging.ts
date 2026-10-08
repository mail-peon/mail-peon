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

/**
 * 给当前激活 tab 的内容脚本发消息。
 *
 * `chrome://` 页面、扩展商店页面、PDF 阅读器等场景下没有内容脚本，
 * `sendMessage` 会 reject —— 这里吞掉它并返回 `false`，
 * 让调用方用返回值表达「没送到」，而不是用异常。
 */
export async function toActiveTab(channel: string, payload: unknown): Promise<boolean> {
  const tabId = await getActiveTabId()
  if (tabId === null)
    return false

  try {
    await sendMessage(channel as never, payload as never, { context: 'content-script', tabId })
    return true
  }
  catch {
    // 没有内容脚本（chrome:// 等）或是 SW 刚醒、页面还没注入完全 —— 都不是错误
    return false
  }
}

/**
 * 广播给所有扩展页面（Popup / Options / Sidepanel）。
 *
 * ⚠ 用「逐个已知接收方 + 吞掉失败」而不是一次广播：
 *   `webext-bridge` 的 context 名字与它内部的 `RuntimeContext` 联合类型并不完全
 *   对齐（`sidepanel` 就不在里面，虽然它在 iife 构建里是合法接收方）。
 *   逐个发还有个好处：某个页面没打开时只是那次 `sendMessage` 失败，
 *   而不是整条消息被丢弃。
 */
export function broadcastToExtension(channel: string, payload: unknown): void {
  const contexts = ['popup', 'options', 'sidepanel', 'devtools'] as const
  for (const context of contexts) {
    const destination = { context } as unknown as Parameters<typeof sendMessage>[2]
    void sendMessage(channel as never, payload as never, destination).catch(() => {
      // 该上下文没打开，正常
    })
  }
}

/** 把 toast 投给当前激活页面（背景侧调用的唯一入口） */
export async function deliverToast(payload: ToastPayload): Promise<boolean> {
  return toActiveTab('mail:toast', payload)
}

export { onMessage, sendMessage }
