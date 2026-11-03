import type { SyncDonePayload } from '~/logic/types'
import { ref } from 'vue'
import { send } from './transport'
// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

export function useAccounts() {
  const accounts = ref<import('~/logic/types').MailAccount[]>([])

  async function reload() {
    const result = await send<{ accounts: import('~/logic/types').MailAccount[] }>('accounts:list', undefined, { accounts: [] })
    accounts.value = result.accounts
  }

  async function save(account: import('~/logic/types').MailAccount) {
    const result = await send<{ ok: boolean }>('accounts:upsert', { account }, { ok: false })
    await reload()
    return result.ok
  }

  async function remove(id: string) {
    await send('accounts:delete', { id }, { ok: false })
    await reload()
  }

  async function test(account: import('~/logic/types').MailAccount) {
    return send<{ ok: boolean, detail?: string, error?: string }>('accounts:test', { account }, { ok: false, error: '请求失败' })
  }

  async function resetCursor(id: string) {
    return send<{ ok: boolean, error?: string }>('accounts:reset-cursor', { id }, { ok: false, error: '请求失败' })
  }

  /**
   * 触发一轮同步。
   *
   * ⚠ 只负责「让后台开始」，不等待结果。原因见 `background/main.ts` 里
   *   `accounts:sync-now` 的注释（MV3 worker 30 秒回收，挂着的 `sendMessage`
   *   不算事件）。
   *
   * @returns 是否成功启动；`startedAt` 是本次点击的时刻，
   *          调用方拿它和 `syncStatus()` 的 `finishedAt` 比对
   */
  async function syncNow() {
    const startedAt = Date.now()
    const result = await send<{ started: boolean }>('accounts:sync-now', undefined, { started: false })
    return { ...result, startedAt }
  }

  /**
   * 取最近一轮同步的结果（**轮询兜底**）。
   *
   * `setTimeout` / `setInterval` 都不好在这里用（组件卸载后还要能取消），
   * 所以只暴露「问一次」，节奏交给调用方。
   */
  async function syncStatus() {
    return send<SyncDonePayload | null>('accounts:sync-status', undefined, null)
  }

  async function authorizeGmail(clientId: string) {
    return send<{ ok: boolean, refreshToken?: string, error?: string }>('accounts:gmail-authorize', { clientId }, { ok: false, error: '请求失败' })
  }

  return { accounts, reload, save, remove, test, resetCursor, syncNow, syncStatus, authorizeGmail }
}
