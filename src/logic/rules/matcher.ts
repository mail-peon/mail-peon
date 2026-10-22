import type { AppSettings, Mail, PromptRule } from '~/logic/types'
import { createDefaultRule, DEFAULT_RULE_ID, MailStateFlag } from '~/logic/types'
import { senderAddress } from './blocked'

/**
 * 规则匹配（`ai-docs/features/03-prompt-rules.md § 3`）。
 *
 * 匹配优先级（**按顺序找第一条命中**）：
 *
 *   1. `matcher.kind === 'email'`  精确匹配发件人地址
 *   2. `matcher.kind === 'domain'` 域名后缀匹配
 *   3. `matcher.kind === 'regex'`  正则匹配
 *   4. 内置默认规则
 *
 * ⚠ 这里是**两条独立排序**的交织，容易写错也容易被误改：
 *
 *   - **规则之间**：按 `priority` 升序（数字越小越优先，用户拖拽 = 改 priority）。
 *     调用方传进来的数组必须已经是这个顺序（`listRules()` 保证）。
 *   - **匹配器之间**：同一规则内不限种类，任一命中即命中的规则。
 *
 * 设计文档伪代码把「email 比 domain 优先」写在**匹配器类型**的层级上，
 * 但同一规则内两种匹配器混用是常见写法（`me@a.com` + `@b.com`），
 * 而「哪个更优先」在**同一规则内**毫无意义 —— 命中哪个都是命中这条规则。
 * 跨规则的优先由 `priority` 决定。所以这里不做类型间的偏序，
 * 只按 priority 顺序扫、每条规则内任一命中即返回。
 */

/** 域名匹配的规范化：摘掉用户习惯写的 `@` 前缀 */
function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '')
}

/**
 * 单个匹配器是否命中。
 *
 * ⚠ 域名匹配用 `=== v || endsWith('.' + v)` 而不是裸 `endsWith(v)`：
 *   后者会把 `notgithub.com` 当成 `github.com` 命中 —— 那是个静默的过度匹配，
 *   用户的规则会作用在完全无关的邮件上。
 */
export function matchesRule(mail: Pick<Mail, 'from'>, rule: Pick<PromptRule, 'matchers'>): boolean {
  if (!rule.matchers.length)
    return false

  const address = senderAddress(mail)
  if (!address)
    return false

  const at = address.lastIndexOf('@')
  const domain = at === -1 ? '' : address.slice(at + 1)

  return rule.matchers.some((matcher) => {
    const value = matcher.value.trim().toLowerCase()
    if (!value)
      return false

    switch (matcher.kind) {
      case 'email':
        return address === value
      case 'domain': {
        const target = normalizeDomain(value)
        return domain === target || domain.endsWith(`.${target}`)
      }
      case 'regex':
        return safeRegexTest(value, address)
      default:
        return false
    }
  })
}

/**
 * 正则匹配，**构造失败即不命中**。
 *
 * 用户写的正则可能是非法的（少一个括号、用了不支持的反向引用）。
 * 直接 `new RegExp()` 会让它抛错、进而让整轮同步失败 —— 一条写错的规则
 * 不该让用户收不到所有邮件。
 */
function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(value)
  }
  catch {
    return false
  }
}

/**
 * 挑一条规则。
 *
 * `rules` 必须是**已按 priority 升序排好**的（`listRules()` 的返回值）。
 * 没有任何命中时返回内置默认规则 —— 所以这个函数的返回类型非空，
 * 调用方不需要处理 `null`（少一条分支，也少一处可能忘记写的地方）。
 */
export function pickRule(mail: Pick<Mail, 'from'>, rules: PromptRule[]): PromptRule {
  for (const rule of rules) {
    if (!rule.enabled)
      continue
    if (matchesRule(mail, rule))
      return rule
  }
  return createDefaultRule()
}

/**
 * 验证码是否该自动复制（`features/05-verification-code.md § 2` 的决策表）。
 *
 * `autoCopy = settings.autoCopyCode || rule.alwaysCopyCode`
 *
 * ⚠ 极简模式**不再恒为 true**（产品决定）：极简模式里的「验证码自动复制」也是一个
 *   普通开关。关掉之后极简模式**照旧提取并入库**验证码，只是不写剪贴板，
 *   toast 上给「点击复制」按钮 —— 与完整模式关掉时的行为完全一致。
 *
 * ⚠ 判据里**不再看 `minimalMode`**：这里只回答「该不该写剪贴板」，
 *   而模式决定的是「走哪条处理链」（见 `pipeline.ts` 的 `process`）。
 *   两件事混在一起时，极简模式就没法单独关掉自动复制了。
 */
export function shouldAutoCopyCode(
  app: Pick<AppSettings, 'autoCopyCode'>,
  rule: Pick<PromptRule, 'alwaysCopyCode'> | null,
): boolean {
  return app.autoCopyCode || rule?.alwaysCopyCode === true
}

/**
 * 规则对**邮件状态位**的覆盖（Feature 08 起 `isAd` 迁到位掩码）。
 *
 * `rule.alwaysSkipAd === true` → 清掉 `Ad` 位（用户主动认领的发件人绕过广告过滤）。
 *
 * 用「清 bit」而不是「改布尔」：状态位里可能同时有 `Urgent` / `LowPriority`，
 * 规则只该动它负责的那一位。
 */
export function applyRuleStateFlags(
  flags: number,
  rule: Pick<PromptRule, 'alwaysSkipAd'> | null,
): number {
  if (rule?.alwaysSkipAd === true)
    return flags & ~MailStateFlag.Ad
  return flags
}

/**
 * @deprecated 用 `applyRuleStateFlags`（Feature 08 起 isAd 是状态位，不是 AI 输出字段）。
 *
 * 保留这个纯函数是为了历史用例能继续表达「规则能推翻 AI 的广告判定」这条语义。
 */
export function resolveIsAd(
  aiIsAd: boolean,
  rule: Pick<PromptRule, 'alwaysSkipAd'> | null,
): boolean {
  if (rule?.alwaysSkipAd === true)
    return false
  return aiIsAd
}

/** 这条规则是不是内置默认规则（UI 上禁止删除 / 编辑） */
export function isDefaultRule(rule: Pick<PromptRule, 'id'>): boolean {
  return rule.id === DEFAULT_RULE_ID
}
