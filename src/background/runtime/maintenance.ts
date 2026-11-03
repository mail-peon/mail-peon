import { broadcastToExtension } from '~/logic/messaging'
import { refreshBadge } from '~/logic/notification/badge'
import { readMailTypeRecord } from '~/logic/store/mail-types'
import { trashExpiredCodes } from '~/logic/store/mails'
import { ensureStoreReady } from '~/logic/store/ready'
import { readAppSettings } from '~/logic/store/settings'
import { BUILTIN_CODE_ID } from '~/logic/types'

/**
 * Background Service Worker —— 插件的**心跳**（`ai-docs/01-architecture.md § 1`）。
 *
 * 职责：轮询邮箱、解析邮件、调用 AI、写存储、更新 badge、推送 toast。
 * **所有** AI 调用 / 邮件解析 / HTTP 都在这里（架构文档第 1 节的硬规矩）——
 * Popup / Options 只渲染 + 收发消息，Content Script 只负责「在用户当前页面反馈」。
 *
 * ⚠ MV3 的 SW 会休眠（架构文档 § 6），三件事必须做对：
 *   - 长连接（IMAP socket）会被砍 → 用「alarms 周期性轮询 + 单次连接抓增量」；
 *   - `onInstalled` / `onStartup` **以及模块加载本身**都要恢复心跳 —— 只挂事件的话，
 *     SW 被回收重启后 `onStartup` 不会再触发，用户下午就收不到邮件了；
 *   - 每个消息回调的第一步都是 `await ensureStoreReady()`（SW 冷启动时 IDB 迁移
 *     可能还没跑完）。
 */

/**
 * 自动检查新邮件的定时器。
 *
 * ⚠ 它不是「推送」：MV3 的 Service Worker 有硬性生命周期，watch WebSocket 只能
 *   活在 SW 里，QQ 这类服务器又未必会在 IDLE 上推 `EXISTS`。所以真正能保证
 *   「过一会儿就能收到」的是这个 alarm。
 *
 *   间隔由用户在「设置 · 通用 · 自动检查新邮件」里配置（默认 5 分钟，1–60）。
 *   打开 Popup 时会立即检查一次，所以日常使用不需要等满一个周期。
 *
 *   ⚠ 不要写死成 10 分钟：QQ 的 IDLE 实测不推送，10 分钟对等验证码来说太长；
 *     现在由 `app.checkIntervalMinutes` 决定（默认 5，范围 1–60）。
 */
export const SYNC_ALARM = 'mail-peon:sync'

/**
 * 旧版本遗留的「失效验证码清理」独立定时器。
 *
 * 现在清理已经并入 `SYNC_ALARM`（见 onAlarm），这里只负责把老用户的旧 alarm
 * 清掉，避免同一分钟被唤醒两次。
 */
const LEGACY_PURGE_ALARM = 'mail-peon:purge-expired'

export async function ensureAlarm(): Promise<void> {
  try {
    await ensureStoreReady()
    const app = await readAppSettings()
    const minutes = app.checkIntervalMinutes

    /*
     * ⚠ 不能只在「不存在」时创建：用户改了间隔，或者老版本留下的是别的周期，
     *   只判断存在性的话周期**永远不会变**。`alarms.create` 对同名 alarm 是替换语义，
     *   所以周期不一致时直接重建。
     */
    const existing = await browser.alarms.get(SYNC_ALARM)
    if (!existing || existing.periodInMinutes !== minutes)
      await browser.alarms.create(SYNC_ALARM, { periodInMinutes: minutes })

    // 清理旧版本遗留的独立 purge alarm（已并入 SYNC_ALARM）
    await browser.alarms.clear(LEGACY_PURGE_ALARM)
  }
  catch (error) {
    console.warn('[mail-peon] 创建定时器失败', error)
  }
}

/**
 * 把失效的验证码移入回收站（受验证码适配器的 `params.autoDeleteExpiredCode` 控制）。
 *
 * ⚠ 30 秒宽限期的理由见 `store/mails.ts` 的 `trashExpiredCodes` 说明：
 *   失效时刻是「AI 读到的时长 + 入库时刻」推算的，本身有几十秒误差，
 *   立刻删会在边界上误删其实还有效的验证码 —— 而验证码是一次性的。
 */
const EXPIRED_CODE_GRACE_MS = 30_000

export async function purgeExpiredCodes(): Promise<void> {
  try {
    await ensureStoreReady()
    const [app, codeRecord] = await Promise.all([
      readAppSettings(),
      readMailTypeRecord(BUILTIN_CODE_ID),
    ])
    const configured = codeRecord?.params?.autoDeleteExpiredCode
    const enabled = typeof configured === 'boolean' ? configured : app.autoDeleteExpiredCode
    if (!enabled)
      return

    const moved = await trashExpiredCodes(EXPIRED_CODE_GRACE_MS)
    if (!moved)
      return

    console.warn(`[mail-peon] ${moved} 封失效验证码已移入回收站`)
    await refreshBadge()
    broadcastToExtension('data:changed', { reason: 'trash' })
  }
  catch (error) {
    console.warn('[mail-peon] 清理失效验证码失败', error)
  }
}
