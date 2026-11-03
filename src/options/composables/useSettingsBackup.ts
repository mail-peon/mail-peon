import type { Ref } from 'vue'
import type { AiSettings, AppSettings, MailAccount } from '~/logic/types'
import { ref } from 'vue'
import { send } from '~/logic/bridge'
import { ERROR_DURATION, useAppMessage } from '~/logic/ui-message'
import { createSettingsBackup, parseSettingsBackup } from '../settings-backup'

export function useSettingsBackup(options: {
  app: Ref<AppSettings | null>
  ai: Ref<AiSettings | null>
  accounts: Ref<MailAccount[]>
  setApp: (patch: Partial<AppSettings>) => Promise<boolean>
  reload: () => Promise<unknown>
}) {
  const importing = ref(false)
  const uiMessage = useAppMessage()

  function onExport() {
    if (!options.app.value || !options.ai.value)
      return
    const payload = createSettingsBackup(options.app.value, options.ai.value, options.accounts.value)
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `mail-peon-settings-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    uiMessage.success('已导出（不含密码与 AI Key）')
  }

  async function onImportFile(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || importing.value)
      return
    importing.value = true
    try {
      const parsed = parseSettingsBackup(JSON.parse(await file.text()))
      if (parsed.app && await options.setApp(parsed.app) === false)
        throw new Error('保存设置失败，导入已停止，请重试')
      let added = 0
      for (const account of parsed.accounts) {
        const id = `${account.provider}-${Math.random().toString(36).slice(2, 10)}`
        const result = await send('accounts:upsert', {
          account: {
            ...account,
            id,
            label: `${account.label || account.email}（导入）`,
            enabled: false,
            cursor: null,
            lastSyncedAt: undefined,
            lastError: undefined,
          },
        }, { ok: false })
        if (!result.ok)
          throw new Error(`导入中断：已新增 ${added} 个账号，保存「${account.label || account.email}」失败，请重试`)
        added++
      }
      uiMessage.success(`导入完成：设置已覆盖，新增 ${added} 个账号（已停用，请补填凭据后再启用）`)
    }
    catch (error) {
      uiMessage.error(error instanceof Error ? error.message : String(error), ERROR_DURATION)
    }
    finally {
      input.value = ''
      importing.value = false
      await options.reload()
    }
  }
  return { importing, onExport, onImportFile }
}
