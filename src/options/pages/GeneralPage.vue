<script setup lang="ts">
import type { AppSettings, MailRetention, PopupTab, StorageUsage } from '~/logic/types'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { onDataChanged, onSyncDone, send, useAccounts, useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'
import { MAIL_RETENTION_OPTIONS } from '~/logic/types'

/**
 * 通用设置（`design/ui-flows.md § 4.6a` 极简 / `§ 4.6b` 完整）。
 *
 * 两套布局在**同一个组件**里按 `minimalMode` 分支，而不是拆成两个文件：
 * 它们的上半部分（模式切换）完全相同，拆开后「模式切换」这个最关键的控件
 * 会有两份实现 —— 而它正是两套布局之间唯一的通路，重复实现迟早会分叉。
 */

const { app, ai, setApp, reload } = useSettings()
const { accounts, syncNow, syncStatus, reload: reloadAccounts } = useAccounts()

const busy = ref(false)
const message = ref('')
const error = ref('')

/**
 * 把一轮同步的结果呈现出来（成功与失败都走这里）。
 *
 * ⚠ 抽成函数是因为它有**两个**调用方（广播与轮询兜底），而两边必须给出
 *   完全一致的结果 —— 分成两份实现的话，差别会表现为「有时显示拉取 N 封、
 *   有时什么都不显示」，这种不一致极难排查。
 *
 * @param result 后台给出的一轮同步结果
 */
function applySyncResult(result: { ok: boolean, results: SyncSummary[], error?: string }) {
  busy.value = false
  message.value = ''
  error.value = ''

  if (!result.ok) {
    // 失败如实说。不要用「没有启用的账号」这种猜测 —— 那是另一个原因，
    // 会把用户引去反复检查一个本来就正常的账号页
    error.value = `同步失败：${result.error ?? '未知原因'}`
    void reloadUsage()
    return
  }

  const summaries = result.results
  if (!summaries.length) {
    error.value = '没有启用的账号；请先在「账号」页添加（并确认「启用（参与后台同步）」是勾上的）'
    return
  }

  /*
   * 首次同步单独说清楚：用户看到「拉取 0 封」会以为坏了，而实际上这正是
   * 设计文档要求的「首次只记同步位置，不拉历史」。
   */
  const firstSync = summaries.filter(item => item.firstSync)
  const fetched = summaries.reduce((sum, item) => sum + item.fetched, 0)
  const blocked = summaries.reduce((sum, item) => sum + item.blocked, 0)
  const failed = summaries.reduce((sum, item) => sum + item.failed, 0)

  const parts: string[] = []
  if (firstSync.length)
    parts.push(`${firstSync.map(item => item.label).join('、')}：${t('general.syncFirstTime')}`)
  if (fetched || blocked || failed)
    parts.push(t('general.syncDone', { fetched, blocked, failed }))

  const warnings = summaries.filter(item => item.warning)
  if (warnings.length)
    parts.push(...warnings.map(item => `⚠️ ${item.label}：${item.warning}`))

  message.value = parts.join('\n') || t('general.syncDone', { fetched: 0, blocked: 0, failed: 0 })
  void reloadUsage()
  void reloadAccounts()
}

/**
 * 轮询兜底：等后台给出「比本次点击更晚完成」的结果。
 *
 * ⚠ 为什么必须有它 —— 广播**不能**当成唯一通路：
 *
 *   `sync:done` 的送达依赖 background 侧 `connMap` 里有没有对应端点，而它只在
 *   对方握手完成后才有条目。于是「页面在 background 重载之前就连上了」
 *   「同一 context 有多个连接」「端点名对不上」这三种情况都会让消息**静默消失**。
 *   真机上就这样卡过：点同步 → `busy = true` → 消息没到 → 永远转圈，
 *   而且**没有任何错误**可查（中继日志显示同步根本就是成功的）。
 *
 *   所以点击之后一边等广播、一边按间隔问 `accounts:sync-status`；
 *   谁先拿到算谁的（`applySyncResult` 里会先判断 `busy`）。
 *
 * @param startedAt 本次点击的时刻
 * @returns 清理函数（组件卸载时必须调用，否则会一直轮询下去）
 */
function startSyncWatchdog(startedAt: number): () => void {
  const POLL_INTERVAL_MS = 1500
  /** 上限 6 分钟：比「一轮同步最长可能多久」宽松，同时保证不会无限轮询 */
  const DEADLINE_MS = 6 * 60 * 1000

  const timer = window.setInterval(async () => {
    // 广播先到了 —— 停掉轮询
    if (!busy.value) {
      stop()
      return
    }

    if (Date.now() - startedAt > DEADLINE_MS) {
      stop()
      busy.value = false
      error.value = '同步超过 6 分钟仍未返回。请检查中继是否在运行，然后重试。'
      return
    }

    const result = await syncStatus()
    // `finishedAt` 必须晚于本次点击 —— 否则是**上一轮**的结果，
    // 拿它来结束本次会让界面显示过期的数字
    if (result && (result.finishedAt ?? 0) >= startedAt) {
      stop()
      applySyncResult(result)
    }
  }, POLL_INTERVAL_MS)

  function stop() {
    window.clearInterval(timer)
  }

  return stop
}

let stopWatchdog: (() => void) | null = null

const minimalMode = computed(() => app.value?.minimalMode ?? true)
const retention = computed(() => (minimalMode.value ? 50 : (app.value?.mailRetention ?? 100)))

const usage = ref<{ count: number, bytesApprox: number } | null>(null)
const codeCount = ref(0)

const POPUP_TABS: Array<{ value: PopupTab, label: string }> = [
  { value: 'important', label: '重要' },
  { value: 'all', label: '全部' },
  { value: 'code', label: '验证码' },
  { value: 'ad', label: '营销' },
]

/**
 * ⚠ 这一页用 `v-show` 挂在 Options 里（见 `Options.vue`），所以它**在打开设置页时
 *   就挂载了**，`onMounted` 那次读账号时用户还没添加任何账号。之后切到「账号」页
 *   新建、再切回来，组件不会重新挂载 —— 没有下面这个订阅，这页会一直显示
 *   「账号 · 0 个」，而「立即同步增量」也会说「没有启用的账号」。
 *
 *   （真机上就是这么表现过一次：账号页有账号、测试连接通过，通用页坚持说没有。）
 */
let stopDataListener: (() => void) | null = null
let stopSyncListener: (() => void) | null = null

onMounted(async () => {
  await reload()
  await Promise.all([reloadAccounts(), reloadUsage()])

  stopDataListener = onDataChanged(() => {
    void reloadAccounts()
    void reloadUsage()
  })

  /*
   * ⚠ 同步结果走**广播**而不是 `syncNow()` 的返回值。
   *
   *   MV3 的 worker 在没有事件 30 秒后被回收，而挂着一条未完成的 `sendMessage`
   *   不算事件 —— 「等同步跑完再返回」在同步超过 30 秒时必然失败，UI 会永远停在
   *   「同步中」（真机上就这样卡过一次，一轮跑了 32 秒）。
   */
  stopSyncListener = onSyncDone((result) => {
    // 广播可能重复到达（后台与轮询各给一次），只认第一次
    if (!busy.value)
      return
    stopWatchdog?.()
    stopWatchdog = null
    applySyncResult(result)
  })
})

onUnmounted(() => {
  stopDataListener?.()
  stopDataListener = null
  stopSyncListener?.()
  stopSyncListener = null
  stopWatchdog?.()
  stopWatchdog = null
})

async function reloadUsage() {
  const result = await send<{ usage: StorageUsage } | null>('settings:usage', undefined, null)
  if (!result?.usage)
    return

  usage.value = { count: result.usage.count, bytesApprox: result.usage.bytesApprox }
  /*
   * ⚠ 极简模式下列表里其实只有含验证码的记录，而 `usage.count` 统计的是**全部**。
   *   两者在极简模式下相等（不含验证码的邮件根本不入库），所以这里直接用同一个数字；
   *   但这一行不能删 —— 它把这个「为什么相等」的推理留在代码里，
   *   将来若极简模式开始存别的记录，这里就是需要改的那一处。
   */
  codeCount.value = result.usage.count
}

function patch(patchValue: Partial<AppSettings>) {
  void setApp(patchValue).then(reloadUsage)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const usageText = computed(() => {
  const count = usage.value?.count ?? 0
  const size = formatBytes(usage.value?.bytesApprox ?? 0)
  if (minimalMode.value)
    return t('general.usageUnlimitedText', { count: codeCount.value, size })
  return t('general.usageText', { count, limit: retention.value, size })
})

/**
 * 点「立即同步增量」。
 *
 * ⚠ 这里**不等结果**：只负责转成「进行中」，结果由上面的 `onSyncDone` 订阅填。
 *
 *   一个真实的坑（真机上卡过）：MV3 的 worker 在**没有事件** 30 秒后被回收，
 *   而一条**正在进行中**的 `sendMessage` **不算事件**。所以「点一下 → 等它跑完
 *   → 拿返回值」这个写法在同步超过 30 秒时必然失败 —— worker 被杀，
 *   promise 永远不 settle，界面停在「同步中」不动（用户的邮箱 3 万多封，
 *   一轮同步正好跑了 32 秒）。
 */
async function onSyncNow() {
  busy.value = true
  message.value = ''
  error.value = ''

  const result = await syncNow()

  if (!result?.started) {
    // 连「开始」都没成功 —— 这时才需要自己收尾（正常路径由广播/轮询收尾）
    busy.value = false
    error.value = '无法启动同步：与后台通信失败，请重试'
    return
  }

  /*
   * ⚠ 这里**必须**开看门狗，而不是只等 `sync:done` 广播。
   *
   *   广播的送达依赖 background 侧 `connMap`，任何一环没接上它就静默消失 ——
   *   那时 `busy` 会永远停在 true，用户看到「同步中」不动，而且没有任何错误可查
   *   （真机上就这样卡过，而中继日志显示同步根本是成功的）。
   */
  stopWatchdog?.()
  stopWatchdog = startSyncWatchdog(result.startedAt)
}

/**
 * `window.confirm` 在这个文件里是**刻意**的用法（下面三处）。
 *
 * 这是扩展自己的 Options 页（`chrome-extension://` 下的一个普通标签页），
 * 不存在「页面被第三方脚本劫持弹窗」的风险；而这三件事都是**不可撤销**的
 * （清空邮件列表 / 清空所有数据 / 导入覆盖设置），必须有一道明确的确认。
 *
 * 用一个自研的 modal 组件能得到更漂亮的样式，但代价是：在「确认」这件事上，
 * 浏览器原生弹窗的**行为**（阻塞、ESC 取消、焦点管理、键盘可达）比自己写的更可靠 ——
 * 而它一年只会被看到几次。
 */
function confirmOrAbort(message: string): boolean {
  // eslint-disable-next-line no-alert -- 见上方说明：Options 页里的不可撤销操作确认
  return window.confirm(message)
}

async function onClearMails() {
  if (!confirmOrAbort(t('general.confirmClearMails')))
    return
  busy.value = true
  try {
    await send('settings:clear-mails', undefined, { ok: false })
    message.value = '已清空邮件列表'
    await reloadUsage()
  }
  finally {
    busy.value = false
  }
}

async function onClearAll() {
  if (!confirmOrAbort(t('general.confirmClearAll')))
    return
  busy.value = true
  try {
    await send('settings:clear-all', undefined, { ok: false })
    message.value = '已清空所有数据'
    await Promise.all([reload(), reloadUsage(), reloadAccounts()])
  }
  finally {
    busy.value = false
  }
}

/** 导出 / 导入设置（`design/data-model.md § 9`） */
function onExport() {
  if (!app.value || !ai.value)
    return

  /*
   * ⚠ 不导出凭据（账号密码 / OAuth token / AI Key）与邮件正文 —— 设计文档明确要求。
   *   导出的文件会被用户随手丢进云盘 / 聊天窗口，而明文凭据一旦离开本机就不再可控。
   */
  const payload = {
    kind: 'mail-peon-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    app: app.value,
    ai: { ...ai.value, apiKey: '' },
    accounts: accounts.value.map(account => ({
      ...account,
      config: stripSecrets(account.config),
      // 同步游标也不导出：换台机器时那个游标指的是**另一台机器的**同步位置
      cursor: null,
      lastSyncedAt: undefined,
      lastError: undefined,
    })),
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mail-peon-settings-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
  message.value = '已导出（不含密码与 AI Key）'
}

function stripSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...config }
  for (const key of ['pass', 'refreshToken', 'accessToken', 'apiKey'])
    delete clone[key]
  return clone
}

const importInput = ref<HTMLInputElement | null>(null)

async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return

  error.value = ''
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as {
      kind?: string
      app?: Partial<AppSettings>
      accounts?: Array<Record<string, unknown>>
    }

    if (parsed.kind !== 'mail-peon-settings')
      throw new Error('这个文件不是 mail-peon 导出的设置')

    // 设置：覆盖除凭据外的项（凭据本来就没导出）
    if (parsed.app)
      await setApp(parsed.app)

    /*
     * 账号：**追加**而不是覆盖（设计文档 § 9）。覆盖的话，用户在两台机器上各配了
     * 一半账号时会互相清掉对方 —— 而追加出来的重复账号用户自己删得掉，
     * 被清掉的账号却找不回来。
     */
    let added = 0
    for (const raw of parsed.accounts ?? []) {
      const account = raw as unknown as import('~/logic/types').MailAccount
      if (!account?.id || !account.email)
        continue
      // 导出的记录里没有凭据，所以除了 id 之外要重新生成，避免撞上已有账号
      const id = `${account.provider}-${Math.random().toString(36).slice(2, 10)}`
      await send('accounts:upsert', {
        account: {
          ...account,
          id,
          label: `${account.label || account.email}（导入）`,
          // 没有密码的账号同步必然失败，先停用，等用户补完凭据再开
          enabled: false,
          cursor: null,
        },
      }, { ok: false })
      added++
    }

    message.value = `导入完成：设置已覆盖，新增 ${added} 个账号（已停用，请补填凭据后再启用）`
    await Promise.all([reload(), reloadAccounts()])
  }
  catch (importError) {
    error.value = importError instanceof Error ? importError.message : String(importError)
  }
  finally {
    // 清掉 input 的值，否则连续导入同一个文件不会触发 change
    if (importInput.value)
      importInput.value.value = ''
  }
}
</script>

<template>
  <section class="page">
    <!-- ============ 模式切换（两套布局共用） ============ -->
    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('general.mode') }}
      </p>
      <div class="mp-radio-group">
        <label class="mp-radio">
          <input
            type="radio"
            :checked="minimalMode"
            @change="patch({ minimalMode: true })"
          >
          <span>{{ t('general.modeMinimal') }}</span>
        </label>
        <label class="mp-radio">
          <input
            type="radio"
            :checked="!minimalMode"
            @change="patch({ minimalMode: false })"
          >
          <span>{{ t('general.modeFull') }}</span>
        </label>
      </div>
      <p v-if="minimalMode" class="mp-hint mode-hint">
        {{ t('options.minimalOnlyNote') }}
      </p>
    </div>
    <!-- ============ 极简模式的通用页 ============ -->
    <template v-if="minimalMode">
      <div class="mp-card">
        <label class="mp-checkbox">
          <input
            type="checkbox"
            :checked="app?.autoCopyCode ?? true"
            @change="patch({ autoCopyCode: ($event.target as HTMLInputElement).checked })"
          >
          <span>{{ t('general.autoCopyCode') }}</span>
        </label>
        <p class="mp-hint">
          极简模式下强制开启：看到验证码就自动复制并弹提示。
        </p>

        <hr class="mp-divider">

        <div class="stat-row">
          <span class="stat-label">{{ t('general.accountCount', { n: accounts.length }) }}</span>
          <span class="stat-value">{{ accounts.map(item => item.email).join('、') || '—' }}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">{{ t('general.codeCount', { n: codeCount }) }}</span>
          <span class="stat-value">{{ usageText }}</span>
        </div>

        <div class="actions">
          <button class="mp-btn mp-btn-primary" type="button" :disabled="busy" @click="onSyncNow">
            {{ busy ? t('general.syncing') : t('general.syncNow') }}
          </button>
          <button class="mp-btn mp-btn-danger" type="button" :disabled="busy" @click="onClearAll">
            {{ t('general.clearAll') }}
          </button>
        </div>
      </div>
    </template>

    <!-- ============ 完整模式的通用页 ============ -->
    <template v-else>
      <div class="mp-card">
        <p class="mp-section-title">
          行为
        </p>
        <div class="checks">
          <label class="mp-checkbox">
            <input
              type="checkbox"
              :checked="app?.excludeAds ?? true"
              @change="patch({ excludeAds: ($event.target as HTMLInputElement).checked })"
            >
            <span>{{ t('general.excludeAds') }}</span>
          </label>
          <p class="mp-hint indent">
            {{ t('general.excludeAdsHint') }}
          </p>

          <label class="mp-checkbox">
            <input
              type="checkbox"
              :checked="app?.autoCopyCode ?? true"
              @change="patch({ autoCopyCode: ($event.target as HTMLInputElement).checked })"
            >
            <span>{{ t('general.autoCopyCode') }}</span>
          </label>

          <label class="mp-checkbox">
            <input
              type="checkbox"
              :checked="app?.blockedEnabled ?? true"
              @change="patch({ blockedEnabled: ($event.target as HTMLInputElement).checked })"
            >
            <span>{{ t('general.blockedEnabled') }}</span>
          </label>

          <label class="mp-checkbox">
            <input
              type="checkbox"
              :checked="app?.notifyOnNew ?? true"
              @change="patch({ notifyOnNew: ($event.target as HTMLInputElement).checked })"
            >
            <span>{{ t('general.notifyOnNew') }}</span>
          </label>
        </div>

        <hr class="mp-divider">

        <div class="mp-field">
          <span class="mp-field-label">{{ t('general.popupDefaultTab') }}</span>
          <select
            class="mp-select"
            :value="app?.popupDefaultTab ?? 'important'"
            @change="patch({ popupDefaultTab: ($event.target as HTMLSelectElement).value as PopupTab })"
          >
            <option v-for="item in POPUP_TABS" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="mp-card">
        <p class="mp-section-title">
          {{ t('general.retention') }}
        </p>
        <div class="mp-radio-group">
          <label v-for="option in MAIL_RETENTION_OPTIONS" :key="String(option)" class="mp-radio">
            <input
              type="radio"
              :checked="(app?.mailRetention ?? 100) === option"
              @change="patch({ mailRetention: option as MailRetention })"
            >
            <span>{{ option === 'unlimited' ? t('general.retentionUnlimited') : `${option} ${t('general.retentionUnit')}` }}</span>
          </label>
        </div>

        <hr class="mp-divider">

        <div class="stat-row">
          <span class="stat-label">{{ t('general.usage') }}</span>
          <span class="stat-value">{{ usageText }}</span>
        </div>

        <div class="actions">
          <button class="mp-btn mp-btn-primary" type="button" :disabled="busy" @click="onSyncNow">
            {{ busy ? t('general.syncing') : t('general.syncNow') }}
          </button>
        </div>
      </div>

      <div class="mp-card">
        <p class="mp-section-title">
          数据
        </p>
        <div class="actions">
          <button class="mp-btn" type="button" :disabled="busy" @click="onExport">
            {{ t('general.exportSettings') }}
          </button>
          <button class="mp-btn" type="button" :disabled="busy" @click="importInput?.click()">
            {{ t('general.importSettings') }}
          </button>
          <button class="mp-btn" type="button" :disabled="busy" @click="onClearMails">
            {{ t('general.clearMails') }}
          </button>
        </div>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="hidden-input"
          @change="onImportFile"
        >
        <p class="mp-hint">
          导出不含密码 / OAuth token / AI Key，也不含邮件正文。
        </p>
      </div>

      <div class="mp-card privacy">
        <p class="mp-section-title">
          {{ t('general.privacyTitle') }}
        </p>
        <p class="mp-hint">
          {{ t('general.privacyBody') }}
        </p>
        <div class="actions">
          <button class="mp-btn mp-btn-danger" type="button" :disabled="busy" @click="onClearAll">
            {{ t('general.clearAll') }}
          </button>
        </div>
      </div>
    </template>

    <p v-if="message" class="result ok">
      {{ message }}
    </p>
    <p v-if="error" class="result err">
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.indent {
  margin: -4px 0 4px 20px;
}

.mode-hint {
  margin-top: 8px;
}

.stat-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  padding: 2px 0;
}

.stat-label {
  color: var(--mp-text-dim);
}

.stat-value {
  color: var(--mp-text);
  text-align: right;
  min-width: 0;
  word-break: break-all;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.hidden-input {
  display: none;
}

.privacy {
  border-color: color-mix(in srgb, var(--mp-warn) 35%, var(--mp-border));
}

.result {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.result.ok {
  color: var(--mp-success);
}

.result.err {
  color: var(--mp-danger);
}
</style>
