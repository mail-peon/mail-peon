/**
 * 从剪贴板读中继地址 —— 让「peon-hall 复制 / 扩展自动检测」闭环工作。
 *
 * ## 流程
 *
 * 1. 用户在 peon-hall 点「复制扩展地址」→ 剪贴板里是 `ws://127.0.0.1:41316/`
 * 2. 用户打开扩展 → options 页
 * 3. 用户点「+ 新增账号」或编辑一个
 * 4. 表单打开时 `looksLikeClipboardRelayUrl()` 探测 → 命中就提示「剪贴板里有中继地址，要使用吗？」
 * 5. 用户点「填入」→ 字段被填
 *
 * ## 为什么是「提示 + 按钮」而不是「自动填入」
 *
 * 剪贴板里可能是**任何东西**（用户从某处复制了一段 URL，但不一定是要做中继配置）。
 * 「自动填」会引入**意外的字段覆盖**——用户本来只是想看一下别的东西，结果发现
 * 自己的中继地址已经被改成了别的值。
 *
 * 显式「提示 + 按钮」把决定权抓在用户手里，与「手填一样多一步」相比只是省了「去
 * 找中继地址字段」这一步。
 *
 * ## Clipboard API 与 MV3
 *
 * `navigator.clipboard.readText()` 在扩展页面（popup / options / sidepanel）里
 * 是**安全上下文**：可以用，不需要 manifest 声明。但浏览器仍可能在第一次调用
 * 时弹一次权限确认。这点接受就是了——它发生在用户主动点了「+ 新增账号」之后，
 * 不是冷启动期间偷偷读。
 */

const RELAY_URL_PATTERN = /^wss?:\/\/\S+$/i

/**
 * 这条剪贴板里的东西是中继地址吗？
 *
 * 故意写得**宽松**（只要求 `ws://` 或 `wss://` 开头 + 一段非空文本）：
 * peon-hall 复制的就是 `ws://127.0.0.1:41316/`，其它客户端的复制可能是
 * `wss://relay.example.com:443/path?token=xxx`，都得接受。
 *
 * 严格的校验（合法 URL / 主机名解析）留给表单已有的 `validateRelayUrl()`。
 */
export function looksLikeClipboardRelayUrl(url: string): boolean {
  const trimmed = url.trim()
  return RELAY_URL_PATTERN.test(trimmed)
}

/**
 * 读剪贴板内容。失败时返回 `null`（**不**抛）—— 调用方只把它当作「没读出来」。
 *
 * 失败场景：
 * - 浏览器不允许（HTTP context、非 secure context）→ options 页是扩展页面，
 *   应当是 secure context；如果不是，安静地退化。
 * - 用户拒绝权限 → 安静地退化。
 * - 剪贴板为空 / 没文本 → 返回 `null`。
 */
export async function readClipboardText(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return null
  }
  try {
    const text = await navigator.clipboard.readText()
    if (typeof text !== 'string' || text.length === 0) {
      return null
    }
    return text
  }
  catch {
    // 权限被拒 / 不在 secure context / 任何其它 Clipboard API 异常
    return null
  }
}
