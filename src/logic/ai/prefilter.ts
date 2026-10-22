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

export const CODE_HINTS: readonly RegExp[] = [ // --- 设计文档给的四条 ---
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
 * 确认邮件的线索（Feature 08）。
 *
 * ⚠ 极简模式同时跑「验证码 + 确认」两个适配器。如果不加这一组，一封
 *   `Please confirm your email address` 会在预筛就被丢掉 —— 而它正是最该
 *   被看到的邮件之一。
 *
 * 假阳性的代价只是白调一次 AI；假阴性会让用户**永远看不到确认邮件**，所以宁宽勿严。
 */
export const CONFIRM_HINTS: readonly RegExp[] = [
  /\bconfirm(?:ation|ed|ing)?\b/i,
  /\bverify\s+your\s+(?:e-?mail|address|account)\b/i,
  /\b(?:activate|activation)\b/i,
  /\bsign[-\s]?up\b/i,
  /确认.*(?:邮箱|邮件|账号|帐户)/,
  /验证.*(?:邮箱|邮件)/,
  /激活/,
  /確認メール|メール認証|アカウントを有効/,
  /이메일\s*(?:인증|확인)/,
]

function haystackOf(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): string {
  return `${mail.subject ?? ''} ${(mail.bodyText ?? mail.snippet ?? '').slice(0, 1000)}`
}

/** 这封邮件看起来像含验证码吗？（保留给单测 / 诊断） */
export function looksLikeCodeEmail(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): boolean {
  const haystack = haystackOf(mail)
  return CODE_HINTS.some(pattern => pattern.test(haystack))
}

/** 这封邮件看起来像确认 / 激活邮件吗？ */
export function looksLikeConfirmEmail(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): boolean {
  const haystack = haystackOf(mail)
  return CONFIRM_HINTS.some(pattern => pattern.test(haystack))
}

/**
 * 极简模式的预筛：验证码 OR 确认。
 *
 * 两条都不像 → 不调 AI、不入库。这是极简模式省钱的关键。
 */
export function looksLikeActionableEmail(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): boolean {
  return looksLikeCodeEmail(mail) || looksLikeConfirmEmail(mail)
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
