import { onMessage } from 'webext-bridge/background'
import { broadcastToExtension } from '~/logic/messaging'
import { clearBadge, refreshBadge } from '~/logic/notification/badge'
import { clearMails, countMails, estimateStorageUsage, pruneMailsNow } from '~/logic/store/mails'
import { ensureStoreReady, resetStoreReadyForTests } from '~/logic/store/ready'
import { patchAiSettings, patchAppSettings, readAiSettings, readAppSettings } from '~/logic/store/settings'
import { deleteDb } from '~/platform/idb/database'
import { ensureAlarm } from '../runtime/maintenance'

export function registerSettingsHandlers() {
// ---------------------------------------------------------------------------
// 消息：设置
// ---------------------------------------------------------------------------

  onMessage('settings:get', async () => {
    await ensureStoreReady()
    const [app, ai] = await Promise.all([readAppSettings(), readAiSettings()])
    return { app, ai }
  })

  onMessage('settings:set-app', async ({ data }) => {
    await ensureStoreReady()
    const app = await patchAppSettings(data.patch)

    /*
     * 三件事在「模式 / 保留数量 / badge 开关」变化时要立刻生效：
     *   1. 保留上限可能变了（100 → 50），顺手淘汰一次 —— 否则用户切到极简后
     *      要等下一封邮件才会看到数量下降；
     *   2. badge 重算；
     *   3. 切到极简模式时 badge 必须是**空的**（设计文档 Q18：极简模式只有 toast）。
     */
    if (data.patch.minimalMode !== undefined || data.patch.mailRetention !== undefined || data.patch.notifyOnNew !== undefined) {
      await pruneMailsNow().catch(() => {})
      await refreshBadge()
      if (app.minimalMode)
        await clearBadge()
    }

    /*
     * ⚠ 广播**新的设置**，让其它还开着的扩展页面立刻跟上。
     *
     *   同一页面里的其它组件不需要它（`logic/bridge.ts` 里设置是模块级共享状态，
     *   拨开关时整页一起重渲染）；这一条服务的是**别的页面** ——
     *   开着 Popup / Sidepanel 时改模式，它们不该等到下次打开才知道。
     *
     * ⚠ 送达是**尽力而为**：webext-bridge 里三个界面共用 `popup` 端点名、
     *   每个名字只留最后一个连接（见 `logic/bridge.ts` 文件头）。所以丢一次是正常的，
     *   各界面在挂载时都会主动 `settings:get` 拉一次全量。
     */
    broadcastToExtension('settings:changed', { app })

    /*
     * 模式变了 ⇒ 适配器的「生效开关」也变了（极简模式强制 code+confirm）。
     * 适配器页订阅的是 `data:changed`（它要重拉合并后的列表），所以这里补一条。
     */
    if (data.patch.minimalMode !== undefined)
      broadcastToExtension('data:changed', { reason: 'mail-types' })

    // 自动检查间隔变了 ⇒ 立刻按新周期重建 alarm，不用等下一次 SW 重启
    if (data.patch.checkIntervalMinutes !== undefined)
      await ensureAlarm()

    return { app }
  })

  onMessage('settings:set-ai', async ({ data }) => {
    await ensureStoreReady()
    const ai = await patchAiSettings(data.patch)
    broadcastToExtension('settings:changed', { ai })
    return { ai }
  })

  /**
   * 存储用量（通用页）。
   *
   * ⚠ 这个 handler 曾经返回 5 个字段：`usage` / `retention` / `accountCount` /
   *   `rules` / `lastSyncedAt` —— 而界面**只读 `usage` 和 `retention`**：
   *
   *     - `accountCount` → 界面用的是自己那份 `accounts.length`（本来就有）；
   *     - `rules` / `lastSyncedAt` → 全项目无人读。
   *
   *   代价不只是几个字段：为了它们每次调用都要多跑 `listAccounts()` 和
   *   `countRules()` 两次 IndexedDB 查询，而那是个**每次打开通用页都会跑**的路径。
   *
   *   现在只返回真正被用的两个。要加字段请先确认有调用方 ——
   *   `shim.d.ts` 的 `ProtocolMap` 里同步改。
   */
  onMessage('settings:usage', async () => {
    await ensureStoreReady()
    const [usage, app] = await Promise.all([estimateStorageUsage(), readAppSettings()])

    return {
      usage,
      // 极简模式的实际上限是写死的 50，UI 要显示真实值而不是用户配置里的那个
      retention: app.minimalMode ? (50 as const) : app.mailRetention,
    }
  })

  onMessage('settings:clear-mails', async () => {
    await ensureStoreReady()
    const removed = await countMails()
    await clearMails()
    await clearBadge()
    return { ok: true as const, removed }
  })

  onMessage('settings:clear-all', async () => {
    /*
     * 「清空所有数据」= 删掉整个库。设计文档 `decisions/open-questions.md` Q2 要求
     * 这个按钮必须存在（因为凭据是明文存的）。
     *
     * 用 `deleteDatabase` 而不是逐仓库 `clear`：前者能一并清掉 meta 里的迁移标记，
     * 下次打开是一次完整的全新初始化；后者会留下「迁移已完成但数据全没了」的中间态，
     * 将来真加迁移时会踩到。
     */
    await deleteDb()
    // 让下一次读写重新走一遍 openDb + 迁移
    resetStoreReadyForTests()
    await ensureStoreReady()
    await clearBadge()
    return { ok: true as const }
  })
}
