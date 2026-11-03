import { ref } from 'vue'
import { send } from './transport'
// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export function useRules() {
  const rules = ref<import('~/logic/types').PromptRule[]>([])

  async function reload() {
    const result = await send<{ rules: import('~/logic/types').PromptRule[] }>('rules:list', undefined, { rules: [] })
    rules.value = result.rules
  }

  async function save(rule: import('~/logic/types').PromptRule) {
    await send('rules:upsert', { rule }, { ok: false })
    await reload()
  }

  async function remove(id: string) {
    await send('rules:delete', { id }, { ok: false })
    await reload()
  }

  async function move(id: string, direction: 'up' | 'down') {
    const result = await send<{ rules: import('~/logic/types').PromptRule[] }>('rules:move', { id, direction }, { rules: rules.value })
    rules.value = result.rules
  }

  return { rules, reload, save, remove, move }
}
