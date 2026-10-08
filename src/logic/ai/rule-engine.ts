import type { Mail, PromptRule } from '~/logic/types'
import { pickRule } from '~/logic/rules/matcher'
import { listRules } from '~/logic/store/rules'

/**
 * 规则选择的缓存层。
 *
 * 为什么需要缓存：一轮心跳可能拉到 50 封邮件，而规则表在整轮里不会变。
 * 每封都 `listRules()` 就是 50 次全表读 + 50 次归一化 —— 在 SW 里这是实打实的
 * 唤醒与内存开销。
 *
 * ⚠ **失效必须由外部显式触发**（`invalidate()`），而不是靠 TTL：
 *   TTL 会让「用户刚改完规则，收一封测试邮件看效果」这件事变得不可预测 ——
 *   有时候生效、有时候不生效，而用户没有任何办法知道为什么。
 *   Options 里任何规则增删改之后调一次 `invalidate()` 就够了。
 */
export interface RuleCache {
  /** 取「这封邮件该用哪条规则」 */
  for: (mail: Pick<Mail, 'from'>) => Promise<PromptRule>
  /** 失效（规则表变更后调用） */
  invalidate: () => void
}

export function createRuleCache(): RuleCache {
  let cached: PromptRule[] | null = null

  return {
    async for(mail) {
      cached ??= await listRules()
      return pickRule(mail, cached)
    },
    invalidate() {
      cached = null
    },
  }
}

/**
 * 一次性取一个「问哪条规则」的函数。
 *
 * 给不方便持有缓存对象的地方用（比如 pipeline 的默认实现）。
 */
export async function pickRuleFor(): Promise<{ for: (mail: Pick<Mail, 'from'>) => Promise<PromptRule> }> {
  const rules = await listRules()
  return { for: async mail => pickRule(mail, rules) }
}

export { pickRule }
