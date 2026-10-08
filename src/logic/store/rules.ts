import type { PromptRule } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { clearStore, count, del, get, getAllEntries, put, runTx } from '~/platform/idb/database'
import { isReservedRuleId, normalizeRule } from './migrations'
import { withReady } from './ready'

/**
 * PromptRule 仓库（`rules`，外部键 `ruleId`）。
 *
 * 排序契约：**`priority` 数字越小越优先**。列表读出时按它升序排，匹配器也按这个
 * 顺序找第一条命中的规则（`features/03-prompt-rules.md § 3`）。用户拖拽 = 改 priority。
 *
 * ⚠ 内置「默认规则」(`DEFAULT_RULE_ID`) **不落库** —— 它由 `createDefaultRule()`
 *   现造，`upsertRule` 会拒绝写入它。落库的话，用户清空规则后会把内置规则也删掉。
 */

export const readRule = withReady(async (id: string): Promise<PromptRule | undefined> => {
  if (isReservedRuleId(id))
    return undefined
  const raw = await get<unknown>('rules', id)
  if (raw === undefined)
    return undefined
  return normalizeRule(raw, id) ?? undefined
})

/** 读全表，按 priority 升序（同 priority 时按 createdAt 稳定排序） */
export const listRules = withReady(async (): Promise<PromptRule[]> => {
  const entries = await getAllEntries<unknown>('rules')
  return entries
    .map(({ key, value }) => normalizeRule(value, String(key)))
    .filter((rule): rule is PromptRule => rule !== null && !isReservedRuleId(rule.id))
    .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt))
})

export const upsertRule = withReady(async (rule: PromptRule, ctx?: TxContext): Promise<void> => {
  if (isReservedRuleId(rule.id))
    throw new Error('内置默认规则不可写入存储')
  const normalized = normalizeRule(rule, rule.id)
  if (!normalized)
    throw new Error('规则缺少 id，无法写入')
  await put('rules', normalized, normalized.id, ctx)
})

export const deleteRule = withReady(async (id: string, ctx?: TxContext): Promise<void> => {
  if (isReservedRuleId(id))
    return
  await del('rules', id, ctx)
})

/**
 * 上移 / 下移。
 *
 * 实现是「重排整张表后批量写」而不是「与邻居交换 priority」：交换需要处理
 * 「两条规则 priority 相同」的退化情形（用户手动改过、或并发新建），
 * 那种情况下交换是空操作，用户会看到「点了没反应」。重排把顺序写死成
 * `0..n-1`，天然消除重复值。
 */
export const moveRule = withReady(async (id: string, direction: 'up' | 'down'): Promise<PromptRule[]> => {
  const rules = await listRules()
  const index = rules.findIndex(rule => rule.id === id)
  if (index === -1)
    return rules

  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= rules.length)
    return rules

  const reordered = [...rules]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(target, 0, moved)

  const now = Date.now()
  const stamped = reordered.map((rule, position) => ({ ...rule, priority: position, updatedAt: now }))

  await runTx(['rules'], 'readwrite', async (ctx) => {
    for (const rule of stamped)
      await upsertRule(rule, ctx)
  })

  return stamped
})

export const countRules = withReady((): Promise<number> => count('rules'))

export const clearRules = withReady((ctx?: TxContext): Promise<void> => clearStore('rules', ctx))

export const importRules = withReady((rules: PromptRule[]): Promise<void> => {
  return runTx(['rules'], 'readwrite', async (ctx) => {
    for (const rule of rules) {
      if (isReservedRuleId(rule.id))
        continue
      await upsertRule(rule, ctx)
    }
  })
})
