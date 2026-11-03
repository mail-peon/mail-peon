import { onMessage } from 'webext-bridge/background'
import { broadcastToExtension } from '~/logic/messaging'
import { ensureStoreReady } from '~/logic/store/ready'
import { deleteRule, listRules, moveRule, upsertRule } from '~/logic/store/rules'
import { ruleCache } from '../runtime/pipeline'

export function registerRuleHandlers() {
// ---------------------------------------------------------------------------
// 消息：规则
// ---------------------------------------------------------------------------

  onMessage('rules:list', async () => {
    await ensureStoreReady()
    return { rules: await listRules() }
  })

  onMessage('rules:upsert', async ({ data }) => {
    await ensureStoreReady()
    await upsertRule(data.rule)
    // ⚠ 规则改了必须失效缓存，否则要等下一次 SW 重启才生效 ——
    //   用户会看到「改完规则、发封测试邮件，没反应」
    ruleCache.invalidate()
    broadcastToExtension('data:changed', { reason: 'rules' })
    return { ok: true as const, id: data.rule.id }
  })

  onMessage('rules:delete', async ({ data }) => {
    await ensureStoreReady()
    await deleteRule(data.id)
    ruleCache.invalidate()
    broadcastToExtension('data:changed', { reason: 'rules' })
    return { ok: true as const }
  })

  onMessage('rules:move', async ({ data }) => {
    await ensureStoreReady()
    const rules = await moveRule(data.id, data.direction)
    ruleCache.invalidate()
    broadcastToExtension('data:changed', { reason: 'rules' })
    return { rules }
  })
}
