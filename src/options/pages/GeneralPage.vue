<script setup lang="ts">
import type { AppSettings, MailRetention, PopupTab, StorageUsage } from '~/logic/types'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { onDataChanged, onSyncDone, send, useAccounts, useSettings } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { t } from '~/logic/strings'
import { MAIL_RETENTION_OPTIONS } from '~/logic/types'
import { ERROR_DURATION, useAppMessage, WARNING_DURATION } from '~/logic/ui-message'

/**
 * 通用设置（`design/ui-flows.md § 4.6a` 极简 / `§ 4.6b` 完整）。
 *
 * 两套布局在**同一个组件**里按 `minimalMode` 分支，而不是拆成两个文件：
 * 它们的上半部分（模式切换）完全相同，拆开后「模式切换」这个最关键的控件
 * 会有两份实现 —— 而它正是两套布局之间唯一的通路，重复实现迟早会分叉。
 *
 * 卡片、开关、下拉全部是 Ant Design Vue 的组件（`a-card` / `a-switch` /
 * `a-checkbox` / `a-select` / `a-descriptions`）。
 *
 * ⚠ 操作结果（同步成功/失败、导入导出、清空数据）**不画在页面里**，走全局轻提示
 *   （`logic/ui-message.ts`）。理由与代价都写在那里：颜色必须由「这句话是什么性质」
 *   决定，而页面内的一行文字会把失败跟成功渲染成同一个样子。
 */

const { app, ai, setApp, reload } = useSettings()
const { accounts, syncNow, syncStatus, reload: reloadAccounts } = useAccounts()

const busy = ref(false)
const uiMessage = useAppMessage()

/**
 * 把一轮同步的结果呈现出来（成功与失败都走这里）。
 *
 * ⚠ 抽成函数是因为它有**两个**调用方（广播与轮询兜底），而两边必须给出
 *   完全一致的结果 —— 分成两份实现的话，差别会表现为「有时显示拉取 N 封、
 *   有时什么都不显示」，这种不一致极难排查。
 *
 * ⚠⚠ 这里按**性质**分成四种提示，不能合并成一条：
 *
 *   - 整体失败（`ok: false`）⇒ `error`（红）
 *   - 有账号级故障 / 有邮件失败 ⇒ `warning`（黄）
 *   - 正常拉取 ⇒ `success`（绿）
 *   - 「首次同步只记位置」⇒ `info`（蓝，它不是结果而是说明）
 *
 *   合并成一条 `success` 正是用户报过的问题：「无法连接中继」曾经以绿色出现。
 *
 * @param result 后台给出的一轮同步结果
 */
function applySyncResult(result: { ok: boolean, results: SyncSummary[], error?: string }) {
  busy.value = false

  if (!result.ok) {
    // 失败如实说。不要用「没有启用的账号」这种猜测 —— 那是另一个原因，
    // 会把用户引去反复检查一个本来就正常的账号页
    uiMessage.error(`同步失败：${result.error ?? '未知原因'}`, ERROR_DURATION)
    void reloadUsage()
    return
  }

  const summaries = result.results
  if (!summaries.length) {
    uiMessage.warning('没有启用的账号；请先在「账号」页添加（并确认「启用（参与后台同步）」是勾上的）')
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

  // 「首次同步只记位置」是**说明**，不是结果 —— 用 info（蓝）而不是 success
  if (firstSync.length)
    uiMessage.info(`${firstSync.map(item => item.label).join('、')}：${t('general.syncFirstTime')}`)

  /*
   * ⚠ 有失败就**不能是绿色**：`同步完成：拉取 3 封，失败 1 封` 用绿底显示，
   *   用户会读成「一切正常」，而实际上有个账号根本没拉到信。
   */
  if (fetched || blocked || failed) {
    const text = t('general.syncDone', { fetched, blocked, failed })
    if (failed)
      uiMessage.warning(text, WARNING_DURATION)
    else
      uiMessage.success(text)
  }

  /*
   * 账号级的「这一轮出了事」，例如
   * `无法连接中继：ws://127.0.0.1:8787/imap.qq.com:993?tls=1`。
   *
   * ⚠ 这类文案走的是 `SyncSummary.warning` 字段（见 `adapters/mail/mailbox.ts`：
   *   连接抛错时会把它塞进 `warning`），所以**字段名看着像警告、内容可能是故障**。
   *   之前它跟成功文案拼成一整段、整体按 success 渲染 ⇒ 故障是绿色的。
   *   现在按**警告色**单独提示，并且带上账号名（多账号时才知道该去修哪个）。
   */
  for (const item of summaries.filter(entry => entry.warning))
    uiMessage.warning(`${item.label}：${item.warning}`, WARNING_DURATION)

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
      uiMessage.error('同步超过 6 分钟仍未返回。请检查中继是否在运行，然后重试。', ERROR_DURATION)
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
 * 模式切换（开关在中间，左边「极简模式」、右边「完整功能」）。
 *
 * ⚠ `a-switch` 的语义是「开 = 右侧那项」。所以 checked 是 `!minimalMode`，
 *   而**不是** `minimalMode` —— 写反了会得到一个「往右拨却变成极简」的开关，
 *   而且它看起来完全正常（两种模式都能用，只是与标签相反）。
 */
function onModeToggle(checked: boolean | string | number) {
  patch({ minimalMode: !checked })
}

function onRetentionChange(value: unknown) {
  patch({ mailRetention: value as MailRetention })
}

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

  const result = await syncNow()

  if (!result?.started) {
    // 连「开始」都没成功 —— 这时才需要自己收尾（正常路径由广播/轮询收尾）
    busy.value = false
    uiMessage.error('无法启动同步：与后台通信失败，请重试', ERROR_DURATION)
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
 * 待确认的破坏性操作（三个动作共用）。
 *
 * ⚠ 从「`window.confirm` + `if (!confirm()) return`」改成**弹窗组件 + 待办动作**
 *   之后，流程变成两段：点击只登记「想做什么」，真正的动作在弹窗的确认回调里跑。
 *   这么改是因为原生 `confirm` 的样式与产品完全脱节（深色主题下尤其突兀），
 *   而这里的三个动作（清空邮件列表 / 清空所有数据）都不可撤销，
 *   正需要弹窗把后果写清楚。
 *
 * ⚠ 必须**解构**（理由见 `confirm-action.ts` 的文件头）。
 */
const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

/** 清空邮件列表（不可撤销） */
function onClearMails() {
  askConfirm({
    title: t('general.clearMails'),
    message: t('general.confirmClearMails'),
    confirmText: t('general.clearMails'),
    run: async () => {
      busy.value = true
      try {
        await send('settings:clear-mails', undefined, { ok: false })
        uiMessage.success('已清空邮件列表')
        await reloadUsage()
      }
      finally {
        busy.value = false
      }
    },
  })
}

/** 清空所有数据（不可撤销） */
function onClearAll() {
  askConfirm({
    title: t('general.clearAll'),
    message: t('general.confirmClearAll'),
    confirmText: t('general.clearAll'),
    run: async () => {
      busy.value = true
      try {
        await send('settings:clear-all', undefined, { ok: false })
        uiMessage.success('已清空所有数据')
        await Promise.all([reload(), reloadUsage(), reloadAccounts()])
      }
      finally {
        busy.value = false
      }
    },
  })
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
  uiMessage.success('已导出（不含密码与 AI Key）')
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

    uiMessage.success(`导入完成：设置已覆盖，新增 ${added} 个账号（已停用，请补填凭据后再启用）`)
    await Promise.all([reload(), reloadAccounts()])
  }
  catch (importError) {
    uiMessage.error(importError instanceof Error ? importError.message : String(importError), ERROR_DURATION)
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
    <a-card size="small" :title="t('general.mode')">
      <!--
        一行靠左：`极简模式 (开关) 完整功能`。
        两个标签是**短标签**（括号里的解释在下面两行）——
        长标签挤在开关两边会把它推歪。
      -->
      <div class="mode-row">
        <span class="mode-label" :class="{ active: minimalMode }">
          {{ t('general.modeMinimal') }}
        </span>
        <a-switch
          class="mode-switch"
          :checked="!minimalMode"
          @update:checked="onModeToggle"
        />
        <span class="mode-label" :class="{ active: !minimalMode }">
          {{ t('general.modeFull') }}
        </span>
      </div>

      <!-- 两个模式各一行说明（共两行），每行前面是自己的名字 -->
      <div class="mode-desc">
        <p>
          <span class="mode-desc-title">{{ t('general.modeMinimal') }}</span>：{{ t('general.modeMinimalDesc') }}
        </p>
        <p>
          <span class="mode-desc-title">{{ t('general.modeFull') }}</span>：{{ t('general.modeFullDesc') }}
        </p>
      </div>
    </a-card>

    <!-- ============ 极简模式的通用页 ============ -->
    <template v-if="minimalMode">
      <a-card size="small">
        <!--
          ⚠ 这里**不是** disabled。
             「验证码自动复制」在极简模式里也是一个普通开关：关掉之后验证码照旧
             提取、照旧进列表，只是不写剪贴板 —— toast 上给「点击复制」按钮兜底
             （见 `logic/ai/pipeline.ts` 的 `processMinimal`）。
        -->
        <a-checkbox
          :checked="app?.autoCopyCode ?? true"
          @update:checked="(value: boolean) => patch({ autoCopyCode: value })"
        >
          {{ t('general.autoCopyCode') }}
        </a-checkbox>

        <a-divider class="divider" />

        <a-descriptions :column="1" size="small" class="stats">
          <a-descriptions-item :label="t('general.accountCount', { n: accounts.length })">
            {{ accounts.map(item => item.email).join('、') || '—' }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('general.codeCount', { n: codeCount })">
            {{ usageText }}
          </a-descriptions-item>
        </a-descriptions>

        <div class="actions">
          <a-button type="primary" :loading="busy" @click="onSyncNow">
            {{ busy ? t('general.syncing') : t('general.syncNow') }}
          </a-button>
          <a-button danger :disabled="busy" @click="onClearAll">
            {{ t('general.clearAll') }}
          </a-button>
        </div>
      </a-card>
    </template>

    <!-- ============ 完整模式的通用页 ============ -->
    <template v-else>
      <a-card size="small" :title="t('general.behavior')">
        <div class="checks">
          <div>
            <a-checkbox
              :checked="app?.excludeAds ?? true"
              @update:checked="(value: boolean) => patch({ excludeAds: value })"
            >
              {{ t('general.excludeAds') }}
            </a-checkbox>
            <p class="mp-hint checkbox-hint">
              {{ t('general.excludeAdsHint') }}
            </p>
          </div>

          <a-checkbox
            :checked="app?.autoCopyCode ?? true"
            @update:checked="(value: boolean) => patch({ autoCopyCode: value })"
          >
            {{ t('general.autoCopyCode') }}
          </a-checkbox>

          <a-checkbox
            :checked="app?.blockedEnabled ?? true"
            @update:checked="(value: boolean) => patch({ blockedEnabled: value })"
          >
            {{ t('general.blockedEnabled') }}
          </a-checkbox>

          <a-checkbox
            :checked="app?.notifyOnNew ?? true"
            @update:checked="(value: boolean) => patch({ notifyOnNew: value })"
          >
            {{ t('general.notifyOnNew') }}
          </a-checkbox>
        </div>

        <a-divider class="divider" />

        <div class="field">
          <span class="field-label">{{ t('general.popupDefaultTab') }}</span>
          <a-select
            class="field-control"
            :value="app?.popupDefaultTab ?? 'important'"
            :options="POPUP_TABS"
            @update:value="(value: unknown) => patch({ popupDefaultTab: value as PopupTab })"
          />
        </div>
      </a-card>

      <a-card size="small" :title="t('general.retention')">
        <a-radio-group
          class="vertical"
          :value="app?.mailRetention ?? 100"
          @update:value="onRetentionChange"
        >
          <a-radio v-for="option in MAIL_RETENTION_OPTIONS" :key="String(option)" :value="option">
            {{ option === 'unlimited' ? t('general.retentionUnlimited') : `${option} ${t('general.retentionUnit')}` }}
          </a-radio>
        </a-radio-group>

        <a-divider class="divider" />

        <a-descriptions :column="1" size="small" class="stats">
          <a-descriptions-item :label="t('general.usage')">
            {{ usageText }}
          </a-descriptions-item>
        </a-descriptions>

        <div class="actions">
          <a-button type="primary" :loading="busy" @click="onSyncNow">
            {{ busy ? t('general.syncing') : t('general.syncNow') }}
          </a-button>
        </div>
      </a-card>

      <a-card size="small" :title="t('general.data')">
        <div class="actions actions-tight">
          <a-button :disabled="busy" @click="onExport">
            {{ t('general.exportSettings') }}
          </a-button>
          <a-button :disabled="busy" @click="importInput?.click()">
            {{ t('general.importSettings') }}
          </a-button>
          <a-button :disabled="busy" @click="onClearMails">
            {{ t('general.clearMails') }}
          </a-button>
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
      </a-card>

      <a-card size="small" class="privacy" :title="t('general.privacyTitle')">
        <p class="mp-hint">
          {{ t('general.privacyBody') }}
        </p>
        <div class="actions">
          <a-button danger :disabled="busy" @click="onClearAll">
            {{ t('general.clearAll') }}
          </a-button>
        </div>
      </a-card>
    </template>

    <!--
      ⚠ 这里**故意没有**结果提示块。
        操作结果（同步成功/失败/警告、导入导出、清空数据）全部走全局轻提示
        （`logic/ui-message.ts`）—— 画在页面里时，一句「无法连接中继」会和
        「拉取 3 封」共用一个绿色 Alert，而且它会一直占着版面。
    -->

    <!-- 不可撤销动作共用一个确认弹窗（见脚本里 `useConfirmAction` 的说明） -->
    <ConfirmDialog
      :open="pending !== null"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :confirm-text="pending?.confirmText ?? t('common.confirm')"
      danger
      @confirm="runPending"
      @cancel="cancelConfirm"
    />
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
  gap: 10px;
}

/* 说明文字挂在被说明的那个开关下面，缩进一级 */
.checkbox-hint {
  margin: 2px 0 0 24px;
}

/*
 * 模式切换：`极简模式 (开关) 完整功能`，**靠左**一行。
 *
 * ⚠ 不用 `justify-content: center` 居中：这一行下面的两段说明是左对齐的，
 *   开关居中的话整张卡片会看起来「一半居中一半靠左」。
 */
.mode-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mode-label {
  font-size: 12px;
  color: var(--mp-text-faint);
  transition: color 0.15s;
}

/* 当前生效的那一侧亮起来（另一侧保持灰，一眼能看出现在在哪边） */
.mode-label.active {
  color: var(--mp-text);
  font-weight: 600;
}

/*
 * 两个模式的说明（两行），每行以模式名开头。
 *
 * ⚠ `margin: 0` 不能省：它们挂在 `<p>` 上，而 antd 的 reset 给 `p` 留了
 *   `margin-bottom: 1em`（见 `styles/index.ts` 的说明）—— 两行之间会多出 16px。
 */
.mode-desc {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-desc p {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--mp-text-faint);
}

.mode-desc-title {
  color: var(--mp-text-dim);
  font-weight: 600;
}

.divider {
  margin: 14px 0;
}

/*
 * 描述列表：antd 默认把标签放进左侧固定宽度的列，窄卡片里正文会被挤成竖条。
 * 这里把标签宽度收到 140px 并让它不换行。
 */
.stats :deep(.ant-descriptions-item-label) {
  width: 140px;
  color: var(--mp-text-dim);
}

.stats :deep(.ant-descriptions-item-content) {
  word-break: break-all;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--mp-text-dim);
}

/* 宽度交给内容自己算，但别撑满整张卡片（下拉框太宽看起来像输入框） */
.field-control {
  max-width: 200px;
}

.vertical :deep(.ant-radio-wrapper) {
  display: flex;
  margin-bottom: 6px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

/* 「数据」那张卡片的按钮紧跟在标题下面，不需要额外的上边距 */
.actions-tight {
  margin-top: 0;
}

.hidden-input {
  display: none;
}

.privacy {
  border-color: color-mix(in srgb, var(--mp-warn) 35%, var(--mp-border));
}
</style>
