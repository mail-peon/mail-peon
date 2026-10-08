import type { MailConnectionHooks } from '~/adapters/mail/types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { MailAccount } from '~/logic/types'
import { onMessage } from 'webext-bridge/background'
import { AI_PLATFORM_OPTIONS } from '~/adapters/ai/platforms'
import { resetAccountCursor, testAccountConnection } from '~/adapters/mail/mailbox'
import { MAIL_PROVIDERS } from '~/adapters/mail/registry'
import { createMailPipeline, recordManualCopy } from '~/logic/ai/pipeline'
import { createRuleCache } from '~/logic/ai/rule-engine'
import { testAiConnection } from '~/logic/ai/summarize'
import { broadcastToExtension } from '~/logic/messaging'
import { clearBadge, refreshBadge } from '~/logic/notification/badge'
import { deleteAccount, listAccounts, markAccountError, upsertAccount } from '~/logic/store/accounts'
import {
  clearMails,
  clearMailsByAccount,
  countMails,
  dismissMail,
  estimateStorageUsage,
  markAllRead,
  pruneMailsNow,
  readMail,
  readRecentMails,
  setMailRead,
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

/** 轮询周期（分钟）。Chrome 的 `alarms` 最小间隔是 1 分钟 */
const SYNC_ALARM = 'mail-peon:sync'
const SYNC_PERIOD_MINUTES = 5

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
    const existing = await browser.alarms.get(SYNC_ALARM)
    if (existing)
      return
    await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES })
  }
  catch (error) {
    console.warn('[mail-peon] 创建心跳 alarm 失败', error)
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

// 模块加载即装心跳（SW 冷启动路径 —— 不能只依赖 onInstalled / onStartup）
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
  return { mails: await readRecentMails(data?.limit ?? 200) }
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
  const count = await markAllRead()
  // 打开 Popup = 用户看了，badge 归零（设计文档 `ui-flows.md § 3.1`）
  await clearBadge()
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

onMessage('accounts:sync-now', async () => {
  await ensureStoreReady()
  const results = await runSyncCycleNow()
  return { ok: true as const, results }
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
  void (async () => {
    await ensureStoreReady()
    // 装完先把 badge 画对：用户看到「0」比看到空白更安心（空白像是坏了）
    await refreshBadge()
  })()
})

browser.runtime.onStartup.addListener(() => {
  void ensureAlarm()
})

if (browser.alarms?.onAlarm) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM)
      return
    /*
     * ⚠ 心跳里的任何异常都必须吞掉：`onAlarm` 的监听器抛错会让 Chrome 把这个
     *   监听器标成不可靠（历史上表现为「alarm 还在响，但 handler 不再被调用」）。
     */
    void runSyncCycleNow().catch(error => console.warn('[mail-peon] 心跳异常', error))
  })
}
