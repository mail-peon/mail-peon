import type { Mail } from '~/logic/types'
import { htmlToText } from '~/adapters/mail/parser'
import { cleanCode } from './code'
/**
 * 启发式广告判定。
 *
 * 判据只有一条：**带 `List-Unsubscribe` 头的邮件几乎一定是群发**（营销 / 通知 /
 * Newsletter），因为真人写邮件不会给你一个「退订」链接。
 *
 * ⚠ 但它**不能反过来用**：没有这个头不等于不是广告（很多平台推广不带它）。
 *   所以这只在 AI 失败时兜底，正常路径永远以 AI 的 `states` 为准。
 */
export function heuristicIsAd(mail: Pick<Mail, 'listUnsubscribe'>): boolean {
  return !!mail.listUnsubscribe
}

/**
 * 启发式验证码提取。
 *
 * 策略是「**先找关键词，再在它附近找验证码**」，而不是写一条「关键词 + 任意字符 +
 * 字母数字」的大正则。后者有一个真实的坑：`[^\dA-Za-z]{0,12}([A-Za-z0-9]{4,12})`
 * 里的 `{0,12}` 是**贪婪**的，在 `Your verification code is 90210.` 上它会先吃掉
 * `code is 9021`（正好 12 个字符），于是捕获组只拿到 `0`，长度不够而匹配失败。
 *
 * 关键词的位置才是真正的锚点：验证码几乎总在关键词后面十几个字符内，
 * 取一个固定窗口再看窗口里有什么，比在大正则里调量词可靠得多。
 */
export const CODE_KEYWORDS = [
  /验[证証][码碼]/g,
  /校验码/g,
  /动态(?:密码|码)/g,
  /一次性密码/g,
  /確認コード/g,
  /認証コード/g,
  /인증\s*(?:번호|코드)/g,
  /verification\s+code/gi,
  /verify\s+code/gi,
  /security\s+code/gi,
  /one[-\s]?time\s+(?:code|password|pin)/gi,
  /passcode/gi,
  /\botp\b/gi,
]

/** 关键词之后多长的窗口里找验证码 */
export const KEYWORD_WINDOW = 60

export function heuristicCode(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): string | null {
  const text = `${mail.subject}\n${mail.bodyText ?? mail.snippet ?? ''}`

  // 1. 关键词附近的字母数字串（可信度最高）
  for (const pattern of CODE_KEYWORDS) {
    // 这些正则都带 `g`，复用同一个实例时 `lastIndex` 会串味，所以每次重建
    const scanner = new RegExp(pattern.source, pattern.flags)
    for (;;) {
      const match = scanner.exec(text)
      if (!match)
        break

      const window = text.slice(match.index + match[0].length, match.index + match[0].length + KEYWORD_WINDOW)
      const candidate = firstCodeLikeToken(window)
      if (candidate)
        return candidate
    }
  }

  // 2. 主题里独立的 4-8 位数字（`你的登录码 7788` 这种关键词没写全的情况）
  const subjectMatch = /(?:^|\s)(\d{4,8})(?:\s|$|[，。,.])/.exec(mail.subject ?? '')
  if (subjectMatch)
    return cleanCode(subjectMatch[1])

  return null
}

/** 窗口里第一个「像验证码」的字母数字串 */
export function firstCodeLikeToken(window: string): string | null {
  const tokens = window.match(/\b[A-Z0-9]{4,12}\b/gi)
  if (!tokens?.length)
    return null
  // 含数字的优先：窗口里可能先出现一个英文单词（`is`、`code`），再出现真正的验证码
  const withDigit = tokens.find(token => /\d/.test(token))
  return withDigit ? cleanCode(withDigit) : null
}

/**
 * 从 HTML 里抽验证码（`html` 只在解析阶段存在，入库时已被丢弃）。
 *
 * 目前没有生产调用方 —— 保留是因为「只用 HTML 的邮件」（有些平台只发 HTML 部分）
 * 是我们已知会遇到的形态，而 `htmlToText` 已经写好了，接上只要一行。
 */
export function heuristicCodeFromHtml(html: string): string | null {
  return heuristicCode({ subject: '', bodyText: htmlToText(html), snippet: '' })
}
