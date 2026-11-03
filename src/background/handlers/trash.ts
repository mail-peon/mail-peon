import { onMessage } from 'webext-bridge/background'
import { broadcastToExtension } from '~/logic/messaging'
import { refreshBadge } from '~/logic/notification/badge'
import { countTrashedMails, deleteMailForever, emptyTrash, readTrashedMails, restoreMail, trashMail } from '~/logic/store/mails'
import { ensureStoreReady } from '~/logic/store/ready'

export function registerTrashHandlers() {
// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

  /**
   * 回收站列表。
   *
   * ⚠ 除了列表本身还要给 **`total`（真实总数）**：列表被 `readTrashedMails(500)`
   *   截断，而界面上的「{n} 封」和清空确认里的「将彻底删除 {n} 封」都必须说真话 ——
   *   拿 `mails.length` 当总数时，回收站超过 500 封就会**少报**，
   *   而紧跟着执行的 `emptyTrash()` 删的是**全部**。在一个不可撤销的操作上
   *   少报数量，是这个界面最不该犯的错。
   */
  onMessage('trash:list', async () => {
    await ensureStoreReady()
    const [mails, total] = await Promise.all([readTrashedMails(500), countTrashedMails()])
    return { mails, total }
  })

  onMessage('trash:trash', async ({ data }) => {
    await ensureStoreReady()
    const mail = await trashMail(data.mailId)
    if (!mail)
      return { ok: false as const, error: '邮件不存在' }

    // 移出主列表 ⇒ 未读数与 badge 都可能变
    await refreshBadge()
    broadcastToExtension('mail:updated', { mailId: data.mailId })
    broadcastToExtension('data:changed', { reason: 'trash' })
    return { ok: true as const }
  })

  onMessage('trash:restore', async ({ data }) => {
    await ensureStoreReady()
    const mail = await restoreMail(data.mailId)
    if (!mail)
      return { ok: false as const, error: '邮件不存在' }

    await refreshBadge()
    broadcastToExtension('mail:updated', { mailId: data.mailId })
    broadcastToExtension('data:changed', { reason: 'trash' })
    return { ok: true as const }
  })

  onMessage('trash:delete', async ({ data }) => {
    await ensureStoreReady()
    const removed = await deleteMailForever(data.mailId)
    broadcastToExtension('data:changed', { reason: 'trash' })
    return { ok: removed }
  })

  onMessage('trash:empty', async () => {
    await ensureStoreReady()
    const count = await emptyTrash()
    console.warn(`[mail-peon] 已清空回收站：${count} 封`)
    broadcastToExtension('data:changed', { reason: 'trash' })
    return { ok: true as const, count }
  })
}
