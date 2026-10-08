import type { MailConnectionHooks } from '~/adapters/mail/types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { MailAccount } from '~/logic/types'
import { onMessage } from 'webext-bridge/background'
import { AI_PLATFORM_OPTIONS } from '~/adapters/ai/platforms'
import { resetAccountCursor, testAccountConnection } from '~/adapters/mail/mailbox'
import { MAIL_PROVIDERS } from '~/adapters/mail/registry'
import { buildWatchRequest, openWatchChannel } from '~/adapters/mail/transport/watch'
import { createMailPipeline, recordManualCopy } from '~/logic/ai/pipeline'
import { createRuleCache } from '~/logic/ai/rule-engine'
import { testAiConnection } from '~/logic/ai/summarize'
import { broadcastToExtension } from '~/logic/messaging'
import { clearBadge, refreshBadge } from '~/logic/notification/badge'
import { deleteAccount, listAccounts, listEnabledAccounts, markAccountError, upsertAccount } from '~/logic/store/accounts'
import {
  clearMails,
  clearMailsByAccount,
  countMails,
  deleteMailForever,
  dismissMail,
  emptyTrash,
  estimateStorageUsage,
  markAllRead,
  pruneMailsNow,
  readMail,
  readRecentMails,
  readTrashedMails,
  restoreMail,
  setMailRead,
  trashExpiredCodes,
  trashMail,
} from '~/logic/store/mails'
import { ensureStoreReady, resetStoreReadyForTests } from '~/logic/store/ready'
import { countRules, deleteRule, listRules, moveRule, upsertRule } from '~/logic/store/rules'
import { patchAiSettings, patchAppSettings, readAiSettings, readAppSettings } from '~/logic/store/settings'
import { deleteDb } from '~/platform/idb/database'
import { copyViaContentScript } from './clipboard'
import { authorizeGmail } from './gmail-oauth'
import { createBrowserNotifier } from './notifier'
import { runSyncCycle } from './sync'

/**
 * 一轮同步的结果。
 *
 * ⚠ 刻意**不**从 `logic/bridge.ts` 导入它的同名类型：那个模块 import 了
 *   `webext-bridge/popup` 与 Vue 的组合式 API（它是 UI 侧的层）。
 *   只为借一个类型而把 UI 层的依赖拉进 background，是那种「以后某天突然
 *   发现 background 产物里多了半个 Vue」的隐患。
 */
interface SyncDonePayload {
  ok: boolean
  results: import('~/logic/types').SyncSummary[]
  error?: string
  /** 完成时刻（`Date.now()`）—— UI 用它判断「这是不是我这次点击的结果」 */
  finishedAt?: number
}

/**
 * 最近一轮同步的结果（UI 的**轮询兜底**）。
 *
 * ⚠ 为什么不能只靠 `sync:done` 广播：
 *
 *   广播的送达依赖 background 侧 `connMap` 里有没有那个端点，而它只在
 *   对方握手完成后才有条目。于是「页面在 background 重载之前就连上了」
 *   「同一 context 有多个连接」「端点名对不上」这三种情况都会让消息**静默消失** ——
 *   用户看到的是「一直转圈」，而且**没有任何错误**可查。真机上就这样卡过。
 *
 *   所以结果同时存一份在这里，UI 拿不到广播时可以**问**回来。
 *   这不会重新引入 MV3 的 30 秒问题：`accounts:sync-now` 已经立刻返回了，
 *   这个查询是同步**跑完之后**才发的短请求。
 */
let lastSync: SyncDonePayload | null = null

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
 * 兜底定时器。
 *
 * ⚠ 它**不是**主要收信手段 —— 正常路径是中继常驻 `IDLE`、有新邮件立刻推过来
 *   （见 `ai-docs/design/sync-flow.md`）。这个定时器的唯一职责是「推送失效时的保险丝」：
 *
 *   推送依赖两个前提 —— 「中继在跑」与「watch 连接活着」—— 而两个都可能不成立：
 *   用户没起中继、电脑睡眠后连接没恢复、网络切换导致 WebSocket 半死。
 *   没有兜底的话，那些情况下用户会**永远收不到邮件**，而且界面没有任何异常。
 *
 *   周期给得长（10 分钟）是刻意的：推送正常时它每次都拉 0 封，不该为此频繁打扰邮箱。
 *   `chrome.alarms` 的最小间隔由 Chrome 限制（约 30 秒 / 1 分钟），所以
 *   「更低频」是免费的，「更高频」做不到。
 */
const SYNC_ALARM = 'mail-peon:sync'
const SYNC_PERIOD_MINUTES = 10

/**
 * 失效验证码清理的定时器。
 *
 * ⚠ 为什么必须是 alarm 而不是 `setTimeout`：
 *   MV3 的 Service Worker 空闲约 30 秒就被回收，`setTimeout` **不会**在回收后触发 ——
 *   用它做「失效后 30 秒删除」在真机上基本永远不执行，而代码看起来完全正确。
 *
 *   `chrome.alarms` 的最小间隔是 1 分钟，所以实际精度落在「失效 + 30 秒 ~ +90 秒」。
 *   对本功能完全可以接受。
 */
const PURGE_ALARM = 'mail-peon:purge-expired'
const PURGE_PERIOD_MINUTES = 1

// ---------------------------------------------------------------------------
// 心跳与流水线
// ---------------------------------------------------------------------------

/**
 * 规则的进程内缓存：规则表在一轮同步里不会变，缓存能省掉「每封邮件读一遍全表」。
 * 用户在 Options 里改规则时通过 `rules:*` 消息显式失效。
 */
const ruleCache = createRuleCache()

function buildPipeline(): MailPipeline {
  return createMailPipeline({
    notifier: createBrowserNotifier(),
    browserLang: globalThis.navigator?.language ?? 'zh-CN',
    ruleCache,
  })
}

/**
 * Gmail 的 token 轮换回写。
 *
 * provider 层没有存储依赖（它要能在单测里跑），所以刷新出来的 token 通过
 * `hooks.onTokenRefreshed` 交回来，在这里写进账号配置 ——
 * 见 `MailConnectionHooks` 的说明（模块级 sink 会让两个账号并发时串号）。
 */
function hooksFor(account: MailAccount): MailConnectionHooks {
  return {
    async onTokenRefreshed(token) {
      // 重新读一遍账号：同步过程中用户可能改过配置，用闭包里的旧对象会把改动覆盖掉
      const fresh = (await listAccounts()).find(item => item.id === account.id)
      if (!fresh)
        return
      await upsertAccount({
        ...fresh,
        config: { ...fresh.config, accessToken: token.token, expiresAt: token.expiresAt },
      })
    },
  }
}

async function ensureAlarm(): Promise<void> {
  try {
    /*
     * ⚠ 两个定时器**各自判断各自创建**，不能因为「同步定时器已存在」就一起跳过。
     *
     *   它们可能在不同的版本里被引入：老用户已经有 `SYNC_ALARM`，
     *   而 `PURGE_ALARM` 是新加的 —— 用前者的存在性短路整个函数，
     *   会让新定时器**永远建不起来**，而代码看起来完全正确。
     */
    if (!await browser.alarms.get(SYNC_ALARM))
      await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES })

    if (!await browser.alarms.get(PURGE_ALARM))
      await browser.alarms.create(PURGE_ALARM, { periodInMinutes: PURGE_PERIOD_MINUTES })
  }
  catch (error) {
    console.warn('[mail-peon] 创建定时器失败', error)
  }
}

/**
 * 跑一轮同步（心跳与「立即同步」按钮共用）。
 *
 * 共用是有意的：分成两条路径的话，差别会表现为「手动同步能拉到、自动同步拉不到」，
 * 而这种 bug 在真机上极难排查 —— 两边看起来都「成功」了。
 */
async function runSyncCycleNow() {
  return runSyncCycle({ pipeline: buildPipeline(), hooksFor })
}

// ---------------------------------------------------------------------------
// 常驻监听：中继替我们挂 IMAP IDLE，有新邮件就推过来
// ---------------------------------------------------------------------------

/** 每个账号一条 watch 连接的停止函数 */
const watchStops = new Map<string, () => void>()

/**
 * 重建中的标记 —— 防止并发重建把连接搞成重复。
 *
 * ⚠ 这个守卫是必需的，不是保险：`restartWatchChannels()` 是 `async` 的，而它会被
 *   四个入口调用（模块加载 / `onInstalled` / `onStartup` / 账号变更）。
 *   这些调用**会重叠**（浏览器启动时 `onStartup` 与模块加载几乎同时），
 *   于是「先清空再重建」的两份执行交错：A 清空 → B 清空 → A 建 → B 建，
 *   结果是**每个账号两条 watch 连接**。
 *
 *   症状很有迷惑性：中继日志里 `开始常驻监听` 出现多次，而同一次新邮件被推送
 *   多遍（真机上看到过三条一模一样的 `新邮件：35505 → 35507`），
 *   于是同一轮同步被触发多次 —— 既浪费邮箱连接名额，也会触发限流。
 */
let watchRestartInFlight: Promise<void> | null = null

/**
 * 重新建立所有账号的 watch 连接。
 *
 * ⚠ 必须在四个时机都调用：
 *   1. **模块加载**（SW 冷启动）—— SW 被回收重启后 `onStartup` 不会再触发，
 *      只挂事件的话用户下午就收不到推送了；
 *   2. `onInstalled` / `onStartup`；
 *   3. 账号列表变化之后（`accounts:upsert` / `accounts:delete`）。
 *
 * 每次调用都**先全部停掉再重建**：增量更新需要判断「哪个账号的哪些字段变了」，
 * 而漏判的后果是「改了密码但推送还在用旧的」—— 那种 bug 表现为
 * 「同步能拉到邮件，但推送一直不响」，极难联想。全量重建的代价只是几条
 * WebSocket 握手，几毫秒的事。
 *
 * ⚠ 并发调用会被**合并**（见 `watchRestartInFlight`）。不合并就会产生重复连接。
 */
async function restartWatchChannels(): Promise<void> {
  if (watchRestartInFlight)
    return watchRestartInFlight

  watchRestartInFlight = rebuildWatchChannels().finally(() => {
    watchRestartInFlight = null
  })
  return watchRestartInFlight
}

async function rebuildWatchChannels(): Promise<void> {
  for (const stop of watchStops.values()) {
    try {
      stop()
    }
    catch {}
  }
  watchStops.clear()

  let accounts: MailAccount[]
  try {
    await ensureStoreReady()
    accounts = await listEnabledAccounts()
  }
  catch (error) {
    console.warn('[mail-peon] 读取账号失败，暂不建立监听', error)
    return
  }

  for (const account of accounts) {
    // Gmail 走 REST + OAuth，没有 IMAP 连接可挂
    if (account.provider !== 'imap')
      continue

    const request = buildWatchRequest(account)
    if (!request) {
      // 配置不全（缺中继地址 / 密码）—— 静默跳过。
      // UI 在「测试连接」时会明确报错，这里不需要再刷一遍日志
      continue
    }

    const relayUrl = String(account.config.relayUrl).trim()
    watchStops.set(account.id, openWatchChannel(relayUrl, request, (event) => {
      if (event.type === 'mail') {
        /*
         * ⚠ 这一行让「主动推送到底有没有生效」变成**可观测**的。
         *
         *   没有它时，「中继推了但插件没反应」与「中继根本没推」在插件侧
         *   完全无法区分 —— 而这两种情况的排查方向完全相反
         *   （一个查 watch 连接，一个查同步链路）。
         */
        console.warn(`[mail-peon] 收到中继推送：${account.label} 有 ${event.exists} 封邮件 → 触发同步`)

        /*
         * ⚠ 推送里只有「有几封」，所以这里走的是**普通的一轮同步** ——
         *   它抓的是游标之后的所有邮件，不依赖推送里带的数字。
         *
         *   不用 `await`：watch 的回调要尽快返回，否则后续推送会排在它后面。
         */
        void runSyncCycleNow().catch(error => console.warn('[mail-peon] 推送触发的同步失败', error))
        return
      }

      if (event.state === 'failed') {
        // 中继说重试无用（密码错 / 白名单拒绝）—— 记进账号状态，让 UI 能显示
        console.warn(`[mail-peon] 中继拒绝监听 ${account.label}：${event.error}`)
        void markAccountError(account.id, event.error)
      }
    }))

    console.warn(`[mail-peon] 已建立监听：${account.label} → ${relayUrl}`)
  }

  console.warn(`[mail-peon] 监听连接重建完成，共 ${watchStops.size} 个账号`)
}

/**
 * 把失效的验证码移入回收站（受 `autoDeleteExpiredCode` 开关控制）。
 *
 * ⚠ 30 秒宽限期的理由见 `AppSettings.autoDeleteExpiredCode`：
 *   失效时刻是「AI 读到的时长 + 入库时刻」推算的，本身有几十秒误差，
 *   立刻删会在边界上误删其实还有效的验证码 —— 而验证码是一次性的。
 */
const EXPIRED_CODE_GRACE_MS = 30_000

async function purgeExpiredCodes(): Promise<void> {
  try {
    await ensureStoreReady()
    const app = await readAppSettings()
    if (!app.autoDeleteExpiredCode)
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

// 模块加载即建立监听 + 装定时器（SW 冷启动路径 —— 不能只依赖 onInstalled / onStartup）
void restartWatchChannels()
void ensureAlarm()

if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  // load latest content script
  import('./contentScriptHMR')
}

/**
 * ⚠ **不**开 `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`。
 *
 * 它与「点击图标打开 Popup」互斥，而设计文档要求的是后者
 * （`features/02-ai-summary.md § 6.3`：「Chrome 默认行为就是打开 popup」）。
 * 开了的话 Popup 永远不会出现，而 Popup 是极简模式的主要界面。
 * 侧边栏仍然可用：权限与 `side_panel.default_path` 已在 manifest 里，
 * 用户可以从浏览器的侧边栏菜单打开。
 */

// ---------------------------------------------------------------------------
// 消息：邮件
// ---------------------------------------------------------------------------

onMessage('mail:list', async ({ data }) => {
  await ensureStoreReady()
  /*
   * ⚠ 计时。`mail:list` 是 Popup 打开时的**第一条**消息，也是它渲染列表的前提 ——
   *   如果它慢，界面就一直停在「加载中…」。
   *
   *   真机上出现过「background 已经入库，Popup 十几秒后才显示」，
   *   而链路上有三个可疑点（读库 / 标记已读 / 消息往返），
   *   没有计时就只能猜。这一行把它们分开。
   */
  const started = Date.now()
  const mails = await readRecentMails(data?.limit ?? 200)
  const elapsed = Date.now() - started
  if (elapsed > 200)
    console.warn(`[mail-peon] mail:list 读库慢：${mails.length} 条用了 ${elapsed}ms`)
  return { mails }
})

onMessage('mail:get', async ({ data }) => {
  await ensureStoreReady()
  return { mail: (await readMail(data.mailId)) ?? null }
})

onMessage('mail:dismiss', async ({ data }) => {
  await ensureStoreReady()

  if (data.dismissed)
    await dismissMail(data.mailId)
  else if (data.read !== undefined)
    await setMailRead(data.mailId, data.read)

  // badge 依赖 read / dismissed，改完必须重算
  await refreshBadge()
  broadcastToExtension('mail:updated', { mailId: data.mailId })
  return { ok: true as const }
})

onMessage('mail:mark-all-read', async () => {
  await ensureStoreReady()
  /*
   * ⚠ 计时。这个 handler 在 **Popup 每次打开时**都会跑，而它做的是
   *   「读最多 1000 条 + 在一个事务里把所有未读改写成已读」。
   *
   *   它是整条打开链路里唯一的重活，所以最可能是「Popup 十几秒才显示」的原因 ——
   *   因为它与 `mail:list` **并发**跑，两者抢同一个 IndexedDB 连接。
   */
  const started = Date.now()
  const count = await markAllRead()
  // 打开 Popup = 用户看了，badge 归零（设计文档 `ui-flows.md § 3.1`）
  await clearBadge()
  const elapsed = Date.now() - started
  if (elapsed > 200)
    console.warn(`[mail-peon] 标记全部已读慢：${count} 条用了 ${elapsed}ms`)
  return { ok: true as const, count }
})

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

onMessage('trash:list', async () => {
  await ensureStoreReady()
  return { mails: await readTrashedMails(500) }
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

/**
 * UI 上的「复制验证码」按钮。
 *
 * ⚠ 由 background **代转**给内容脚本，而不是让弹窗自己写剪贴板：
 *
 *   1. 弹窗自己调 `navigator.clipboard.writeText` 会在**弹窗关闭的瞬间**被打断
 *      （用户点完复制、随手点走，写入就丢了），而内容脚本跑在页面里、不受影响；
 *   2. 三级降级逻辑（SW → 内容脚本 → toast 按钮）只需要维护一份
 *      （`background/clipboard.ts`）。
 */
onMessage('mail:copy-code', async ({ data }) => {
  const ok = await copyViaContentScript(data.code)
  if (ok && data.mailId) {
    // 复制成功要把 copyStatus 落库，否则 badge 与列表状态对不上
    await recordManualCopy(data.mailId, true)
    broadcastToExtension('mail:updated', { mailId: data.mailId })
  }
  return { ok }
})

/**
 * 「点击复制」的回执。
 *
 * content script 自己先把验证码写进剪贴板（它在页面里，几乎必然成功），再把结果
 * 报回来 —— 由 background 落库。content script 不该有 IDB 访问路径，
 * 否则 schema 归一化要维护两遍。
 */
onMessage('mail:manual-copy-result', async ({ data }) => {
  await ensureStoreReady()
  if (data.mailId) {
    await recordManualCopy(data.mailId, data.ok)
    broadcastToExtension('mail:updated', { mailId: data.mailId })
  }
  return { ok: true as const }
})

// ---------------------------------------------------------------------------
// 消息：账号
// ---------------------------------------------------------------------------

onMessage('accounts:list', async () => {
  await ensureStoreReady()
  return { accounts: await listAccounts() }
})

onMessage('accounts:upsert', async ({ data }) => {
  await ensureStoreReady()
  await upsertAccount(data.account)
  return { ok: true as const, id: data.account.id }
})

onMessage('accounts:delete', async ({ data }) => {
  await ensureStoreReady()
  /*
   * 先删邮件再删账号。反过来的话，中途失败会留下一批「孤儿邮件」——
   * 它们的 accountId 指向一个不存在的账号，UI 上既显示不出来也删不掉。
   */
  await clearMailsByAccount(data.id)
  await deleteAccount(data.id)
  await refreshBadge()
  return { ok: true as const }
})

onMessage('accounts:test', async ({ data }) => {
  await ensureStoreReady()
  return testAccountConnection(data.account, hooksFor(data.account))
})

onMessage('accounts:reset-cursor', async ({ data }) => {
  await ensureStoreReady()
  const account = (await listAccounts()).find(item => item.id === data.id)
  if (!account)
    return { ok: false, error: '账号不存在' }

  try {
    // 语义：连一次、记下当前游标、**不拉历史**
    await resetAccountCursor(account, hooksFor(account))
    return { ok: true as const }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markAccountError(account.id, message)
    return { ok: false, error: message }
  }
})

/**
 * 手动触发一轮同步。
 *
 * ⚠ **立刻返回，不等待同步跑完**。这不是优化，是这个功能能不能用的前提：
 *
 *   MV3 的 Service Worker 在**没有事件** 30 秒后被回收，而一条**正在进行中**的
 *   `sendMessage` **不算事件**。所以「点同步 → 等它跑完 → 返回结果」这种写法在
 *   同步超过 30 秒时必然失败 —— worker 被杀，promise 永远不 settle，
 *   UI 停在「同步中」不动（真机上就是这么发生的：用户邮箱 3 万多封，
 *   一轮同步跑了 32 秒）。
 *
 *   同步本身继续在后台跑（它自己会 `await` 网络与 IDB，这些都会让 worker 保活）。
 *
 * ⚠ 结果**同时**走两条路（见 `lastSync` 的说明）：
 *   1. 广播 `sync:done` —— 快，但不保证送到；
 *   2. 存进 `lastSync` 供 UI **轮询**取回 —— 兜底，保证「同步中」一定会结束。
 */
onMessage('accounts:sync-now', async () => {
  await ensureStoreReady()

  void (async () => {
    try {
      const results = await runSyncCycleNow()
      lastSync = { ok: true, results, finishedAt: Date.now() }
      broadcastToExtension('data:changed', { reason: 'accounts' })
      broadcastToExtension('sync:done', { ok: true, results, finishedAt: lastSync.finishedAt })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[mail-peon] 手动同步失败', error)
      lastSync = { ok: false, results: [], error: message, finishedAt: Date.now() }
      // 失败也要通知 —— 否则 UI 会一直停在「同步中」（这正是修之前的行为）
      broadcastToExtension('sync:done', { ok: false, results: [], error: message, finishedAt: lastSync.finishedAt })
    }
  })()

  return { started: true as const }
})

onMessage('accounts:sync-status', async () => {
  return lastSync
})

onMessage('accounts:gmail-authorize', async ({ data }) => {
  return authorizeGmail(data.clientId)
})

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
  return { ok: true as const, id: data.rule.id }
})

onMessage('rules:delete', async ({ data }) => {
  await ensureStoreReady()
  await deleteRule(data.id)
  ruleCache.invalidate()
  return { ok: true as const }
})

onMessage('rules:move', async ({ data }) => {
  await ensureStoreReady()
  const rules = await moveRule(data.id, data.direction)
  ruleCache.invalidate()
  return { rules }
})

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

  return { app }
})

onMessage('settings:set-ai', async ({ data }) => {
  await ensureStoreReady()
  return { ai: await patchAiSettings(data.patch) }
})

onMessage('settings:usage', async () => {
  await ensureStoreReady()
  const [usage, app, accounts, rules] = await Promise.all([
    estimateStorageUsage(),
    readAppSettings(),
    listAccounts(),
    countRules(),
  ])

  return {
    usage,
    // 极简模式的实际上限是写死的 50，UI 要显示真实值而不是用户配置里的那个
    retention: app.minimalMode ? (50 as const) : app.mailRetention,
    accountCount: accounts.length,
    rules,
    lastSyncedAt: accounts.reduce<number | undefined>(
      (latest, account) =>
        account.lastSyncedAt && (!latest || account.lastSyncedAt > latest) ? account.lastSyncedAt : latest,
      undefined,
    ),
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

// ---------------------------------------------------------------------------
// 消息：AI 与协议元数据
// ---------------------------------------------------------------------------

onMessage('ai:test', async ({ data }) => {
  return testAiConnection(data.ai)
})

onMessage('ai:platforms', async () => {
  return { platforms: AI_PLATFORM_OPTIONS }
})

/**
 * 让 Options 动态渲染「新增账号」表单。
 *
 * 返回的是完整的 `fields` 声明 —— 于是「加了一家 provider 但设置页没有它的字段」
 * 在结构上不可能发生：表单是**读声明渲染**的，不是写死的。
 */
onMessage('mail:providers', async () => {
  return {
    providers: MAIL_PROVIDERS.map(definition => ({
      value: definition.id,
      label: definition.label,
      hint: definition.hint,
      availability: definition.availability,
      availabilityNote: definition.availabilityNote,
      fields: definition.fields.map(field => ({
        key: String(field.key),
        label: field.label,
        type: field.type,
        placeholder: field.placeholder,
        required: field.required,
        default: field.default,
      })),
    })),
  }
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(() => {
  void ensureAlarm()
  void restartWatchChannels()
  void (async () => {
    await ensureStoreReady()
    // 装完先把 badge 画对：用户看到「0」比看到空白更安心（空白像是坏了）
    await refreshBadge()
  })()
})

/**
 * 浏览器启动。
 *
 * ⚠ 这里**必须**重建 watch 连接：浏览器关掉时所有 WebSocket 都断了，
 *   而 `onStartup` 是这个时机唯一可靠的信号。
 *
 *   （注意它**不覆盖**「SW 被回收后重启」——那种情况下 `onStartup` 不会触发，
 *   所以才要在模块顶层也调一次。两个入口都不能省。）
 */
browser.runtime.onStartup.addListener(() => {
  void ensureAlarm()
  void restartWatchChannels()
})

if (browser.alarms?.onAlarm) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      /*
       * ⚠ 这里的任何异常都必须吞掉：`onAlarm` 的监听器抛错会让 Chrome 把这个
       *   监听器标成不可靠（历史上表现为「alarm 还在响，但 handler 不再被调用」）。
       */
      void runSyncCycleNow().catch(error => console.warn('[mail-peon] 定时抓取异常', error))

      /*
       * 顺带跑一次失效验证码清理。
       *
       * ⚠ 挂在这里而不是自建一个 `setTimeout`：MV3 的 Service Worker 空闲约 30 秒
       *   就被回收，`setTimeout` **不会**在回收后触发 —— 用它做「失效后 30 秒删除」
       *   在真机上基本永远不执行，而代码看起来完全正确。
       *
       *   代价是精度：`chrome.alarms` 的最小间隔是 1 分钟，所以实际延迟落在
       *   「失效 + 30 秒 ~ 失效 + 90 秒」。对本功能完全可以接受 ——
       *   验证码已经失效了，早删晚删几十秒不影响用户。
       */
      void purgeExpiredCodes()
      return
    }

    if (alarm.name === PURGE_ALARM)
      void purgeExpiredCodes()
  })
}
