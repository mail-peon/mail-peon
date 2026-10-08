import type { AppSettings, Mail, PromptRule } from '~/logic/types'
import { createDefaultRule, DEFAULT_RULE_ID } from '~/logic/types'
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
 * ⚠ 极简模式下这里恒为 `true`（设计文档 Q18：「极简模式下 autoCopyCode 强制为 true」）。
 *   把这条判定收在这里而不是让调用方各写一遍：极简模式的整个价值就是自动复制，
 *   漏掉这条特判的地方会表现为「极简模式下验证码不自动复制」—— 功能等于废了。
 */
export function shouldAutoCopyCode(
  app: Pick<AppSettings, 'minimalMode' | 'autoCopyCode'>,
  rule: Pick<PromptRule, 'alwaysCopyCode'> | null,
): boolean {
  if (app.minimalMode)
    return true
  if (app.autoCopyCode)
    return true
  return rule?.alwaysCopyCode === true
}

/**
 * 广告判定（`features/04-exclude-ads.md § 3`）。
 *
 * ```
 * rule.alwaysSkipAd === true  → isAd 强制 false（用户主动认领的发件人绕过过滤）
 * 否则                          → 用 AI 输出的 isAd
 * ```
 *
 * 设计文档提到的 `rule.prompt?.forceAd` 那条分支**刻意不实现**：
 *   prompt 是字符串（用户写的自然语言提示词），在它上面挂一个 `forceAd` 布尔字段
 *   是文档里的笔误残留，代码里没有对应的数据模型。等真有需求时按
 *   `PromptRule.alwaysForceAd` 那样的显式字段加，而不是从提示词文本里猜。
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
