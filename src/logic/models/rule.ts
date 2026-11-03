// ---------------------------------------------------------------------------
// PromptRule
// ---------------------------------------------------------------------------

export type Matcher
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }
    | { kind: 'regex', value: string }

export interface PromptRule {
  /** = ruleId（外部键） */
  id: string
  name: string
  enabled: boolean
  /** 用户拖拽 = 改 priority；**数字越小越优先 */
  priority: number
  /** 多匹配（任一命中即匹配） */
  matchers: Matcher[]
  prompt: string
  /** 不论全局开关，本规则强制自动复制验证码 */
  alwaysCopyCode?: boolean
  /** 本规则始终认为不是广告（覆盖 AI 的 isAd） */
  alwaysSkipAd?: boolean
  createdAt: number
  updatedAt: number
}

/** `PromptRule` 的字段白名单 */
export const PROMPT_RULE_FIELDS: Record<keyof PromptRule, true> = {
  id: true,
  name: true,
  enabled: true,
  priority: true,
  matchers: true,
  prompt: true,
  alwaysCopyCode: true,
  alwaysSkipAd: true,
  createdAt: true,
  updatedAt: true,
}

/**
 * 内置「全局默认规则」。
 *
 * 用户不需要自己建一条来兜底 —— 没有任何规则命中时用它（见 `logic/rules/matcher.ts`）。
 * `id` 用固定串，便于 UI 上标注「内置」并禁止删除。
 */
export const DEFAULT_RULE_ID = '__default__'

export function createDefaultRule(): PromptRule {
  return {
    id: DEFAULT_RULE_ID,
    name: '默认规则（内置）',
    enabled: true,
    priority: Number.MAX_SAFE_INTEGER,
    matchers: [],
    prompt: '',
    createdAt: 0,
    updatedAt: 0,
  }
}
