import type { Mail } from '~/logic/types'

/**
 * 极简模式的**预筛**（`design/minimal-mode.md § 3.3`）。
 *
 * 目的是「不调 AI 也能省」：不像含验证码的邮件根本不进 AI 流程。
 * 这是极简模式在成本上唯一的关键优化 —— 一个收验证码的邮箱里同时躺着几百封
 * 通知邮件，全烧一遍 AI 的话「几乎免费」这个卖点就不成立了。
 *
 * ⚠ 预筛的**假阴性**代价比假阳性高得多：
 *   - 假阳性（放过了没有验证码的邮件）→ 白调一次 AI，成本可控；
 *   - 假阴性（漏掉了真有验证码的邮件）→ **用户拿不到验证码**，功能直接失效。
 *
 *   所以这里的规则刻意宽松，并且在文档给出的四条之外**额外**加了几条
 *   真实邮件里常见的形态（见下面注释）。
 */

export const CODE_HINTS: readonly RegExp[] = [
  // --- 设计文档给的四条 ---
  /验[证証][码碼]/, // 中文（含繁体）
  /\bcode\b/i,
  /\botp\b/i,
  /\b\d{4,8}\b/, // 短数字串

  // --- 以下为实际邮件里高频、但文档没列出的形态 ---
  // 登录 / 安全类通知（Google、Apple、GitHub 的验证码邮件通常用英文这些词）
  /\b(?:verification|verify|security|auth(?:entication)?)\s+code\b/i,
  /\b(?:one[-\s]?time|passcode|pin)\b/i,
  // 中文的其它说法
  /校验码|动态密码|一次性密码|短信验证/,
  // 日文 / 韩文（设计文档要求「支持任何语言的邮件」，而这两类是常见来源）
  /確認コード|認証コード|ワンタイム/,
  /인증\s*(?:번호|코드)/,
  // 纯数字验证码但被空格 / 连字符分隔（`123 456`、`123-456`）——
  // `\b\d{4,8}\b` 匹配不到这种，而它恰恰是很多平台为可读性采用的格式
  /\b\d{3}[\s-]\d{3}\b/,
]

/**
 * 这封邮件看起来像含验证码吗？
 *
 * 扫描范围：**主题 + 正文前 1000 字**。
 *
 * ⚠ 只扫前 1000 字是有意的：验证码几乎总在邮件开头（"您的验证码是 xxx"），
 *   而扫全文会让「邮件底部有一行版权声明写着 © 2024」这类内容命中
 *   `\b\d{4,8}\b` —— 于是每封邮件都要白调一次 AI。1000 字是「覆盖开头几段」
 *   与「不误伤」之间的平衡点。
 */
export function looksLikeCodeEmail(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): boolean {
  const haystack = `${mail.subject ?? ''} ${(mail.bodyText ?? mail.snippet ?? '').slice(0, 1000)}`
  return CODE_HINTS.some(pattern => pattern.test(haystack))
}

/**
 * 找出**第一条**命中的线索（诊断用）。
 *
 * 有了它，「为什么这封邮件没进 AI」在 Options 的诊断面板里能直接回答 ——
 * 而不是让用户对着一个「被跳过」的结论猜。
 */
export function matchedCodeHint(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): string | null {
  const haystack = `${mail.subject ?? ''} ${(mail.bodyText ?? mail.snippet ?? '').slice(0, 1000)}`
  const found = CODE_HINTS.find(pattern => pattern.test(haystack))
  return found ? String(found) : null
}
