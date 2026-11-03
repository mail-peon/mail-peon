import type { PromptRule } from '~/logic/types'
import { DEFAULT_RULE_ID } from '~/logic/types'
import { asObject, bool, num, str } from './common'
import { normalizeMatchers } from './matching'
// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export function normalizeRule(raw: unknown, fallbackKey?: string): PromptRule | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '')
  if (!id)
    return null

  const createdAt = num(value.createdAt, Date.now())

  return {
    id,
    name: str(value.name, '未命名规则'),
    enabled: bool(value.enabled, true),
    priority: num(value.priority, createdAt),
    matchers: normalizeMatchers(value.matchers),
    prompt: str(value.prompt),
    alwaysCopyCode: value.alwaysCopyCode === undefined ? undefined : bool(value.alwaysCopyCode, false),
    alwaysSkipAd: value.alwaysSkipAd === undefined ? undefined : bool(value.alwaysSkipAd, false),
    createdAt,
    updatedAt: num(value.updatedAt, createdAt),
  }
}

/** 内置默认规则不能被存进库（它由 `createDefaultRule()` 现造） */
export function isReservedRuleId(id: string): boolean {
  return id === DEFAULT_RULE_ID
}
