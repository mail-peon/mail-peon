/**
 * 确认链接的安全校验。
 *
 * 链接来自**不可信输入**（邮件正文 / AI 抽取），点一下就会打开新标签：
 *
 *   - 只允许 `http` / `https`，挡住 `javascript:` / `data:` / `file:`；
 *   - 长度上限，挡住「把整封邮件塞进 URL」这种脏数据；
 *   - 用 `URL` 解析而不是字符串前缀匹配 —— `http://` 开头的 `http://evil` 也要过一遍。
 *
 * 存储时校验一次（归一化），打开前再校验一次（纵深防御）。
 */

export const MAX_CONFIRM_URL_LENGTH = 2048

/** 解析成安全的 http(s) URL；不合法返回 null */
export function parseSafeHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_CONFIRM_URL_LENGTH)
    return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    return url
  }
  catch {
    return null
  }
}

/** 归一化成字符串 URL；不合法返回 null */
export function safeHttpUrl(value: unknown): string | null {
  return parseSafeHttpUrl(value)?.toString() ?? null
}

/** 取 host（不含端口）；解析失败返回空串 */
export function hostOf(value: unknown): string {
  return parseSafeHttpUrl(value)?.host ?? ''
}
