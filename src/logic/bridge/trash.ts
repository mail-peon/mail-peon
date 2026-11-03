import type { Ref } from 'vue'
import type { Mail } from '~/logic/types'
import { onMounted, onUnmounted, ref } from 'vue'
import { dataChangeListeners, installBridgeListener, mailUpdateListeners } from './events'
import { send } from './transport'
// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

/**
 * 回收站页用的数据与操作。
 *
 * ## 两条语义（产品要求，别搞混）
 *
 * - **移入回收站**（`trash`）= 状态变更。只写一个 `trashedAt`，记录本身不动，
 *   所以「恢复」是零成本的。用户看到的「删除」按钮走的其实是这条。
 * - **彻底删除**（`deleteForever` / `empty`）= **硬删除**。直接从 IndexedDB 移除，
 *   没有撤销。刻意不做软删除：回收站本身已经是软删除层了，
 *   在它下面再叠一层只会让「彻底删除」名不副实。
 */
export function useTrash() {
  const mails = ref<Mail[]>([]) as Ref<Mail[]>
  const loading = ref(true)

  /**
   * 列表被 `readTrashedMails(500)` 截断，所以**总数单独给**。
   * 界面上的「{n} 封」和「将彻底删除 {n} 封」都得用这个，不能用 `mails.length`。
   */
  const total = ref(0)

  async function reload() {
    const result = await send<{ mails: Mail[], total: number }>('trash:list', undefined, { mails: [], total: 0 })
    mails.value = result.mails
    total.value = result.total ?? result.mails.length
    loading.value = false
  }

  /** 从回收站恢复（清掉 `trashedAt`，邮件回到主列表） */
  async function restore(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:restore', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
  }

  /** **彻底删除**一封（硬删除，不可撤销） */
  async function deleteForever(mail: Mail) {
    const result = await send<{ ok: boolean }>('trash:delete', { mailId: mail.id }, { ok: false })
    await reload()
    return result.ok
  }

  /**
   * 清空回收站。
   *
   * ⚠ 由调用方负责**二次确认** —— 这是全项目唯一一个不可撤销的批量操作。
   *   放在 UI 层确认而不是这里：这里拿不到「用户是不是真的点了确认」这个信息，
   *   而一个会自动执行确认的 `confirm()` 等于没有确认。
   *
   * @returns 删掉了几封
   */
  async function empty() {
    const result = await send<{ ok: boolean, count: number }>('trash:empty', undefined, { ok: false, count: 0 })
    await reload()
    return result.count
  }

  onMounted(() => {
    void reload()
    installBridgeListener()
    /*
     * ⚠ 同时监听两种广播：
     *   - `mail:updated`：单封邮件被移入/移出回收站；
     *   - `data:changed`：清空、以及「失效验证码自动删除」这类**批量**变化
     *     （它一次动很多封，逐封发 `mail:updated` 会把消息通道打满）。
     */
    mailUpdateListeners.add(reload)
    dataChangeListeners.add(reload)
  })

  onUnmounted(() => {
    mailUpdateListeners.delete(reload)
    dataChangeListeners.delete(reload)
  })

  return { mails, total, loading, reload, restore, deleteForever, empty }
}
