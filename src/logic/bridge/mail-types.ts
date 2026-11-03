import { onMounted, onUnmounted, ref } from 'vue'
import { dataChangeListeners, installBridgeListener } from './events'
import { send } from './transport'
// ---------------------------------------------------------------------------
// 邮件类型适配器（Feature 08）
// ---------------------------------------------------------------------------

export interface MailTypeCreateInput {
  name: string
  prompt: string
  fallback?: boolean
}

export function useMailTypes() {
  const adapters = ref<import('~/logic/types').MailTypeAdapter[]>([])

  async function reload() {
    const result = await send<{ adapters: import('~/logic/types').MailTypeAdapter[] }>(
      'mail-types:list',
      undefined,
      { adapters: [] },
    )
    adapters.value = result.adapters
  }

  async function setEnabled(id: string, enabled: boolean) {
    await send('mail-types:update', { id, patch: { enabled } }, { ok: false })
    await reload()
  }

  async function setUserPrompt(id: string, userPrompt: string) {
    await send('mail-types:update', { id, patch: { userPrompt } }, { ok: false })
    await reload()
  }

  /** 适配器自己的参数（当前只有验证码的 `autoCopyCode`） */
  async function setParams(id: string, params: Record<string, unknown>) {
    await send('mail-types:update', { id, patch: { params } }, { ok: false })
    await reload()
  }

  async function create(input: MailTypeCreateInput) {
    const result = await send<{ ok: boolean, id?: string, error?: string }>(
      'mail-types:create',
      input,
      { ok: false },
    )
    await reload()
    return result
  }

  async function update(id: string, patch: { name?: string, prompt?: string, fallback?: boolean, params?: Record<string, unknown> }) {
    await send('mail-types:update', { id, patch }, { ok: false })
    await reload()
  }

  async function remove(id: string) {
    await send('mail-types:delete', { id }, { ok: false })
    await reload()
  }

  async function move(id: string, direction: 'up' | 'down') {
    await send('mail-types:move', { id, direction }, { ok: false })
    await reload()
  }

  /** 内置类型：清掉 override（开关 / 补充提示词），恢复 catalog 默认 */
  async function reset(id: string) {
    await send('mail-types:reset', { id }, { ok: false })
    await reload()
  }

  onMounted(() => {
    void reload()
    installBridgeListener()
    dataChangeListeners.add(reload)
  })

  onUnmounted(() => {
    dataChangeListeners.delete(reload)
  })

  return { adapters, reload, setEnabled, setUserPrompt, setParams, create, update, remove, move, reset }
}
