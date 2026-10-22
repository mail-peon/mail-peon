import type { MailConnectionHooks } from '~/adapters/mail/types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { MailAccount, MailTypeRecord } from '~/logic/types'
import { nanoid } from 'nanoid'
import { onMessage } from 'webext-bridge/background'
import { AI_PLATFORM_OPTIONS } from '~/adapters/ai/platforms'
import { resetAccountCursor, testAccountConnection } from '~/adapters/mail/mailbox'
import { mailProviderOptionPayloads } from '~/adapters/mail/registry'
import { buildWatchRequest, openWatchChannel } from '~/adapters/mail/transport/watch'
import { createMailPipeline, recordManualCopy } from '~/logic/ai/pipeline'
import { createRuleCache } from '~/logic/ai/rule-engine'
import { testAiConnection } from '~/logic/ai/summarize'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import { broadcastToExtension } from '~/logic/messaging'
import { clearBadge, refreshBadge } from '~/logic/notification/badge'
import { deleteAccount, listAccounts, listEnabledAccounts, markAccountError, upsertAccount } from '~/logic/store/accounts'
import {
  deleteMailTypeRecord,
  listMailTypeRecords,
  moveCustomMailType,
  nextCustomPriority,
  readMailTypeRecord,
  upsertMailTypeRecord,
} from '~/logic/store/mail-types'
import {
  clearMails,
  clearMailsByAccount,
  countMails,
  countTrashedMails,
  deleteMailForever,
  dismissMail,
  emptyTrash,
  estimateStorageUsage,
  markAllRead,
  pruneMailsNow,
  readRecentMails,
  readTrashedMails,
  restoreMail,
  setMailRead,
  trashExpiredCodes,
  trashMail,
} from '~/logic/store/mails'
import { ensureStoreReady, resetStoreReadyForTests } from '~/logic/store/ready'
import { deleteRule, listRules, moveRule, upsertRule } from '~/logic/store/rules'
import { patchAiSettings, patchAppSettings, readAiSettings, readAppSettings } from '~/logic/store/settings'
import { BUILTIN_CODE_ID } from '~/logic/types'
import { deleteDb } from '~/platform/idb/database'
import { createSingleFlight } from '~/platform/single-flight'
import { copyViaContentScript } from './clipboard'
import { fireAndForget } from './deferred-task'
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
const SYNC_ALARM = 'mail-peon:sync'

/**
 * 旧版本遗留的「失效验证码清理」独立定时器。
 *
 * 现在清理已经并入 `SYNC_ALARM`（见 onAlarm），这里只负责把老用户的旧 alarm
 * 清掉，避免同一分钟被唤醒两次。
 */
const LEGACY_PURGE_ALARM = 'mail-peon:purge-expired'

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
 * 同步周期的**单飞闸门**（见 `platform/single-flight.ts`）。
 *
 * ⚠ 为什么必须有它：同步周期有三个**互不协调**的入口 —— watch 推送（`openWatchChannel`
 *   的回调）、自动检查 `alarm`、手动「立即同步」—— 而 `runSyncCycle` 每轮都会**重新从库里
 *   读游标**（`adapters/mail/mailbox.ts`），整条链路上也没有「这封已经处理过」的判据。
 *   两轮重叠的后果是具体的：
 *
 *     1. 两轮读到同一个游标 → 同一批邮件被拉两次；
 *     2. 每封邮件各调一次 AI（`logic/ai/pipeline.ts`）→ **重复计费**；
 *     3. 同一封邮件重复弹 toast。
 *
 *   而这不是边界情况：推送是「新邮件一到立刻发」的，一轮同步又可能跑几十秒
 *   （真机上有 3 万多封的邮箱跑过 32 秒），所以「推送撞上在途同步」是常态。
 *   同一份文件里 `watchRestartInFlight` 处理的是同一类竞态（见它的说明）。
 */
const syncFlight = createSingleFlight()

/**
 * 跑一轮同步（心跳与「立即同步」按钮共用）。
 *
 * 共用是有意的：分成两条路径的话，差别会表现为「手动同步能拉到、自动同步拉不到」，
 * 而这种 bug 在真机上极难排查 —— 两边看起来都「成功」了。
 */
async function runSyncCycleNow() {
  return runSyncCycle({ pipeline: buildPipeline(), hooksFor })
}

/**
 * 跑一轮同步，且**不与在途的那一轮重叠**（搭车复用）。
 *
 * 推送与手动「立即同步」都用它。`started === false` 表示本次没有真的跑 ——
 * 已经有一轮在途，而那一轮的抓取范围（游标之后的所有邮件）本来就覆盖了本次的诉求。
 *
 * @returns 那一轮的结果，以及本次是否真的执行了
 */
async function syncOnce() {
  return syncFlight.run(runSyncCycleNow)
}

/**
 * 跑一轮同步，并且保证**至少有一轮是在「现在」之后开始的**。
 *
 * 只给自动检查 `alarm` 用：它按用户配置的周期跑，语义是「每一跳都必须真的去问一次邮箱」，
 * 于是它排到在途那一轮**之后**按顺序执行。
 *
 * ⚠ 刻意**不**给 watch 推送用：推送的诉求（游标之后的邮件）已经被在途那一轮覆盖，
 *   再排一轮只是白连一次邮箱（腾讯对同账号的并发 / 频率连接数有限制，见
 *   `ai-docs/decisions/imap-testing.md § 11`）。真在那一瞬间到的邮件由下一跳兜底 ——
 *   而它本来就是这个定时器存在的意义（推送失效时的兜底）。
 *
 * ⚠ 也不给手动「立即同步」用：那会让 `sendMessage` 的 promise 挂上两整轮同步的时间，
 *   而「一条未完成的 `sendMessage` 不算事件」会让 MV3 的 SW 在 30 秒后被回收 ——
 *   这正是 `accounts:sync-now` 立刻返回、结果走轮询的原因（见它的说明）。
 */
async function syncAfterCurrent() {
  return syncFlight.chain(runSyncCycleNow)
}

// ---------------------------------------------------------------------------
// 常驻监听：中继替我们挂 IMAP IDLE，有新邮件就推过来
// ---------------------------------------------------------------------------

/** 每个账号一条 watch 连接的停止函数 */
const watchStops = new Map<string, () => void>()

/**
 * 上一次 watch 报给我们的 `EXISTS`（邮箱总封数）。
 *
 * ⚠ 这是**补漏的关键**：watch 重连时中继会重新 `SELECT`，把当时的 `EXISTS` 当新基线，
 *   于是「插件睡着期间到达的邮件」不会被当作新邮件推送。这里拿上一次的值做比较：
 *   新基线更大 ⇒ 沉睡期间确实有邮件到达 ⇒ 补一轮同步。
 *
 *   没有它时，真机表现就是：中继日志里 `exists` 从 36117 涨到 36119，
 *   但插件一条推送都没收到 —— 下次手动点「立即同步」才看到。
 */
const watchExists = new Map<string, number>()

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
  watchExists.clear()

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
        watchExists.set(account.id, event.exists)

        /*
         * ⚠ 推送里只有「有几封」，所以这里走的是**普通的一轮同步** ——
         *   它抓的是游标之后的所有邮件，不依赖推送里带的数字。
         *
         *   不用 `await`：watch 的回调要尽快返回，否则后续推送会排在它后面。
         *
         * ⚠ 走 `syncOnce()` 而不是直接跑：推送可能在**一轮同步跑到一半**时到达
         *   （真机上很常见），那时直接再跑一轮会和在途那轮读到同一个游标、
         *   把同一批邮件重复喂给 AI。在途时的诉求已经被那一轮的抓取范围覆盖，
         *   所以这里搭车复用即可 —— 详见 `syncFlight` 的说明。
         */
        void syncOnce().catch(error => console.warn('[mail-peon] 推送触发的同步失败', error))
        return
      }

      if (event.state === 'watching') {
        /*
         * 新 watch 连上来了：中继会重新 SELECT，并把当前 EXISTS 当基线。
         *
         * ⚠ 这一步是**补漏**，不是重复推送：watch 断开期间（SW 被回收、
         *   网络切换、中继重启）到达的邮件不会被 `mail` 事件推到我们这边，
         *   但重连后的 EXISTS 会比上次大。看到这个差值就补一轮同步。
         */
        const previous = watchExists.get(account.id)
        watchExists.set(account.id, event.exists)
        if (previous === undefined || event.exists > previous) {
          console.warn(
            `[mail-peon] 监听基线变化：${account.label} ${previous ?? '首次'} → ${event.exists}，补一轮同步`,
          )
          void syncOnce().catch(error => console.warn('[mail-peon] 监听补漏同步失败', error))
        }
        return
      }

      if (event.state === 'failed') {
        // 中继说重试无用（密码错 / 白名单拒绝）—— 记进账号状态，让 UI 能显示
        console.warn(`[mail-peon] 中继拒绝监听 ${account.label}：${event.error}`)
        watchExists.delete(account.id)
        void markAccountError(account.id, event.error)
        return
      }

      if (event.state === 'error') {
        // 中继说本轮失败但还在退避重试——可观测，不打断 sync 调度
        console.warn(`[mail-peon] 中继监听 ${account.label} 本轮出错：${event.error}`)
      }
    }))
  }

  /*
   * ⚠ 这里**不**打「已建立监听：<账号> → <中继地址>」，也不打重建完成的汇总。
   *
   *   重建在 SW 每次冷启动都会跑（`restartWatchChannels` 的四个时机），
   *   每次都是同样的几行「成功」播报，只能把失败那几行淹掉 ——
   *   而这一段的诊断价值全在失败路径上（读取账号失败 / 中继拒绝 / 本轮出错），
   *   连接是否真的活着则由「收到中继推送」那行证明。
   */
}

/**
 * 把失效的验证码移入回收站（受验证码适配器的 `params.autoDeleteExpiredCode` 控制）。
 *
 * ⚠ 30 秒宽限期的理由见 `store/mails.ts` 的 `trashExpiredCodes` 说明：
 *   失效时刻是「AI 读到的时长 + 入库时刻」推算的，本身有几十秒误差，
 *   立刻删会在边界上误删其实还有效的验证码 —— 而验证码是一次性的。
 */
const EXPIRED_CODE_GRACE_MS = 30_000

async function purgeExpiredCodes(): Promise<void> {
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

/*
 * ⚠ 这里**曾经**有一个 `mail:get` handler（按 id 取单封邮件）。
 *   删掉的理由：**全项目没有任何发送方** —— 界面要列表就整表拿（`mail:list`），
 *   要单封就在拿到的那份数据里找，从来没有按 id 单独取过。
 *
 *   留着它的代价不是几行代码，而是它看起来像一条可用的通道：
 *   下一个人会以为「已经有人按 id 取邮件了」，于是照着它写调用方，
 *   而那条路从来没被跑过、也没被测过。
 */

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

/**
 * 「复制验证码」的**回退通道**。
 *
 * ⚠ 正常情况下**不会走到这里** —— 弹窗 / 侧边栏自己就是 focused 文档，
 *   它们直接调 `navigator.clipboard.writeText`（几乎必然成功）。
 *   只有在那边写失败时（失焦、权限被策略禁用、某些 Linux 桌面）
 *   UI 才把活派过来，让内容脚本再试一次。
 *
 * ⚠ 这里**不写 `copyStatus`**。
 *   用户手动点一下复制**不是持久状态** —— 界面上的「√ 复制成功」是纯前端的
 *   瞬时反馈（几秒后自己消失），不该被记进库。
 *   写库会带来一个具体的坏后果：`copyStatus` 变成 `'copied'` 之后
 *   广播 + `reload()` 会把它读回来，而前端那个「几秒后复原」的定时器
 *   改的是已经被换掉的对象 —— 界面上的成功提示就**永远清不掉**（真机现象）。
 *
 *   `copyStatus` 只由**自动复制**那条流水线写（`pipeline.ts` 的
 *   `shouldAutoCopyCode` 分支），语义是「收到验证码时后台帮用户复制过了」。
 *
 * ⚠ 只广播 `mail:updated` 是为了让**别开着的界面**也刷新 ——
 *   例如弹窗开着复制了，侧边栏也该看到同一封的正文变化。但因为它不再改库，
 *   这次广播其实只会触发一次无变化的重读；留着是为了行为一致。
 */
onMessage('mail:copy-code', async ({ data }) => {
  const ok = await copyViaContentScript(data.code)
  if (ok && data.mailId)
    broadcastToExtension('mail:updated', { mailId: data.mailId })
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
  /*
   * ⚠ **必须重建 watch**：账号可能是刚加的（此前没有连接），也可能是改了
   *   密码 / 中继地址（旧连接还在用旧配置）。
   *
   *   漏掉这一步的症状正是「手动同步能拉到、自动推送一直不响」——
   *   手动同步每次都从库里读新配置，而 watch 只在模块加载 / 浏览器启动时建立。
   */
  void restartWatchChannels()
  /*
   * ⚠ 广播出去，否则「通用」页会一直显示旧的账号数。
   *
   *   这一页用 `v-show` 常驻（见 `Options.vue`），它 `onMounted` 里读的那次账号
   *   是「用户还没添加账号」时读的；没有这条广播，用户去「账号」页新建一个再切回来，
   *   看到的还是「账号 · 0 个」—— 真机症状就是「账号页明明有账号，通用页说没有」。
   */
  broadcastToExtension('data:changed', { reason: 'accounts' })
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
  // 停掉这个账号的 watch（重建会顺带清掉已删除账号的连接）
  void restartWatchChannels()
  await refreshBadge()
  broadcastToExtension('data:changed', { reason: 'accounts' })
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
 *
 * ⚠ 用 `syncOnce()`（搭车复用）而不是 `syncAfterCurrent()`（排到本轮之后）：
 *   后者会让这条 `sendMessage` 的 promise 挂上两整轮同步的时间，而那正是上面
 *   那个 MV3 故障的成因。点下去时若已有一轮在途，它抓的同样是「游标之后的所有
 *   邮件」，结果照样会写进 `lastSync`（`finishedAt` 一定晚于本次点击），
 *   UI 的轮询兜底能拿到 —— 见 `pages/GeneralPage.vue` 的 `startSyncWatchdog`。
 */
onMessage('accounts:sync-now', async () => {
  await ensureStoreReady()
  return fireAndForget(async () => {
    try {
      const { value: results } = await syncOnce()
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
  }, (error) => {
    // 同步到这里都不应该失败（try / catch 里走完了）；兜底把异常吃掉 + 记日志，
    // 不能再让 promise 走 unhandled rejection（MV3 worker 会被报错）。
    console.warn('[mail-peon] 手动同步未捕获异常', error)
  })
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

// ---------------------------------------------------------------------------
// 消息：邮件类型适配器（Feature 08）
// ---------------------------------------------------------------------------

/**
 * 把「catalog + override + 自定义」合并成 UI 需要的运行时视图。
 *
 * 极简模式的开关锁定是**生效层**的事：这里返回的 `enabled` 已经是
 * 「极简模式强制 code+confirm」之后的值，UI 只管渲染 + 禁用开关。
 */
async function effectiveMailTypes() {
  const [records, app] = await Promise.all([listMailTypeRecords(), readAppSettings()])
  return resolveMailTypeAdapters(records, {
    minimalMode: app.minimalMode,
    lang: 'zh',
  })
}

/**
 * 极简模式下适配器配置是**只读**的（模式 overlay 强制 code+confirm）。
 *
 * 例外：适配器自己的 `params` 仍然可写 —— 例如「验证码自动复制」已经从通用设置
 * 迁到验证码适配器里，它控制的是行为，不是「这个类型生不生效」。如果连它也锁住，
 * 极简模式用户就再也关不掉自动复制了。
 */
async function adapterEditGuard(
  patch?: Record<string, unknown>,
): Promise<{ ok: false, error: string } | null> {
  const app = await readAppSettings()
  if (!app.minimalMode)
    return null

  const keys = Object.keys(patch ?? {})
  if (keys.length > 0 && keys.every(key => key === 'params'))
    return null

  return { ok: false as const, error: '极简模式下适配器开关被锁定，请切到「自定义」模式' }
}

onMessage('mail-types:list', async () => {
  await ensureStoreReady()
  return { adapters: await effectiveMailTypes() }
})

/**
 * 更新一条适配器。
 *
 * - 内置：只接受 `enabled` / `userPrompt` / `params`（名称 / 提示词 / 优先级由 catalog 决定）；
 * - 自定义：接受 `name` / `prompt` / `fallback` / `enabled` / `params`。
 *
 * 不存在时对内置是「新建一条 override」，对自定义是错误（防止 UI 拿错 id）。
 */
onMessage('mail-types:update', async ({ data }) => {
  await ensureStoreReady()
  const guard = await adapterEditGuard(data.patch)
  if (guard)
    return guard

  const records = await listMailTypeRecords()
  const existing = records.find(record => record.id === data.id)
  const isBuiltin = data.id.startsWith('builtin:')

  if (!isBuiltin && !existing)
    return { ok: false as const, error: '自定义类型不存在' }

  const now = Date.now()
  const base: MailTypeRecord = existing ?? {
    id: data.id,
    kind: isBuiltin ? 'builtin' : 'custom',
    createdAt: now,
    updatedAt: now,
  }

  const next: MailTypeRecord = { ...base, updatedAt: now }

  if (typeof data.patch.enabled === 'boolean')
    next.enabled = data.patch.enabled

  if (data.patch.params && typeof data.patch.params === 'object' && !Array.isArray(data.patch.params))
    next.params = { ...(next.params ?? {}), ...data.patch.params }

  if (isBuiltin) {
    if (typeof data.patch.userPrompt === 'string')
      next.userPrompt = data.patch.userPrompt
  }
  else {
    if (typeof data.patch.name === 'string')
      next.name = data.patch.name
    if (typeof data.patch.prompt === 'string')
      next.prompt = data.patch.prompt
    if (typeof data.patch.fallback === 'boolean')
      next.fallback = data.patch.fallback
  }

  await upsertMailTypeRecord(next)
  broadcastToExtension('data:changed', { reason: 'mail-types' })
  return { ok: true as const }
})

onMessage('mail-types:create', async ({ data }) => {
  await ensureStoreReady()
  const guard = await adapterEditGuard()
  if (guard)
    return guard

  const name = data.name.trim()
  const prompt = data.prompt.trim()
  if (!name)
    return { ok: false as const, error: '请填写类型名' }
  if (!prompt)
    return { ok: false as const, error: '请填写提示词' }

  const records = await listMailTypeRecords()
  const now = Date.now()
  const id = `custom:${nanoid(10)}`

  await upsertMailTypeRecord({
    id,
    kind: 'custom',
    name,
    prompt,
    enabled: true,
    fallback: data.fallback === true,
    priority: nextCustomPriority(records),
    createdAt: now,
    updatedAt: now,
  })

  broadcastToExtension('data:changed', { reason: 'mail-types' })
  return { ok: true as const, id }
})

onMessage('mail-types:delete', async ({ data }) => {
  await ensureStoreReady()
  const guard = await adapterEditGuard()
  if (guard)
    return guard

  // 内置不能删；删除请求对内置等价于「恢复默认」（清掉 override）
  await deleteMailTypeRecord(data.id)
  broadcastToExtension('data:changed', { reason: 'mail-types' })
  return { ok: true as const }
})

onMessage('mail-types:reset', async ({ data }) => {
  await ensureStoreReady()
  const guard = await adapterEditGuard()
  if (guard)
    return guard

  const existing = await readMailTypeRecord(data.id)
  if (existing?.kind === 'custom')
    return { ok: false as const, error: '自定义类型没有默认值' }

  await deleteMailTypeRecord(data.id)
  broadcastToExtension('data:changed', { reason: 'mail-types' })
  return { ok: true as const }
})

onMessage('mail-types:move', async ({ data }) => {
  await ensureStoreReady()
  const guard = await adapterEditGuard()
  if (guard)
    return guard

  const existing = await readMailTypeRecord(data.id)
  if (!existing || existing.kind !== 'custom')
    return { ok: false as const, error: '只有自定义类型可以排序' }

  await moveCustomMailType(data.id, data.direction)
  broadcastToExtension('data:changed', { reason: 'mail-types' })
  return { ok: true as const }
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
 *
 * ⚠ 实际拼装放在 `mailProviderOptionPayloads()`（`adapters/mail/registry.ts`）。
 *   以前这里是一段**逐个字段手抄的白名单**，漏了 `presets`，导致 IMAP 的
 *   13 个服务器预设到了界面就没了 —— 详见那个函数上的注释。
 *   挪出去同时也是为了能被单测覆盖（本文件一 import 就注册监听器，没法单独测）。
 */
onMessage('mail:providers', async () => {
  return { providers: mailProviderOptionPayloads() }
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
       *
       * ⚠ 走 `syncAfterCurrent()` 而不是 `syncOnce()`：这一跳的语义是「必须真的
       *   问一次邮箱」，所以它在途时排到那一轮之后（不会和在途那轮抢同一批邮件）。
       */
      void syncAfterCurrent().catch(error => console.warn('[mail-peon] 定时抓取异常', error))

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
    }
  })
}
