<script setup lang="ts">
import type { AccountBusyKind, AccountProbeResult, AccountStatus } from './accounts-status'
import type { MailProviderOptionPayload } from '~/adapters/mail/registry'
import type { MailAccount } from '~/logic/types'
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { send, useAccounts } from '~/logic/bridge'
import { looksLikeClipboardRelayUrl, readClipboardText } from '~/logic/clipboard-relay'
import { useConfirmAction } from '~/logic/confirm-action'
import { t } from '~/logic/strings'
import { ERROR_DURATION, useAppMessage } from '~/logic/ui-message'
import { describeCursor, relativeTime } from '../account-format'
import { validateAccount } from '../account-validation'
import AccountCard from '../components/accounts/AccountCard.vue'
import AccountEditor from '../components/accounts/AccountEditor.vue'
import { useAccountFields } from '../composables/useAccountFields'
import { accountStatus } from './accounts-status'

/**
 * 账号页（`design/ui-flows.md § 4.2`）。
 *
 * ⚠ 表单是**读 provider 声明渲染**的（`mail:providers` 通道），不是写死的：
 *   字段清单来自 `src/adapters/mail/providers/<id>/index.ts` 的 `fields`，
 *   所以「加了一家 provider 但设置页没有它的输入框」这件事在结构上不可能发生。
 *   写死表单的话，加 provider 要改两个地方，而漏改的表现是「新协议保存后字段全空」。
 *
 * 界面构件是 Ant Design Vue 的（`a-card` / `a-form` / `a-select` / `a-input` /
 * `a-input-number` / `a-switch` / `a-alert`）。
 */

/**
 * 直接用通道那头的类型，**不再本地重抄一份**。
 *
 * ⚠ 这里曾经是一个手写的 `interface ProviderOption`，而它漏了 `fields[].presets` ——
 *   于是模板里 `v-else-if="field.presets"` 在类型上不成立，运行时也拿不到值
 *   （另有一处白名单错误，见 `registry.ts` 的 `mailProviderOptionPayloads`）。
 *   更麻烦的是：因为 `.vue` 当时不在 `tsc` 的检查范围内，这份抄件和真类型
 *   不一致**没有任何人会发现**。
 *
 *   现在 `typecheck` 走 `vue-tsc`，抄件会立刻变成错误 —— 所以直接引用源类型，
 *   让它从「第三份拷贝」变回「同一个类型」。
 */
type ProviderOption = MailProviderOptionPayload

const { accounts, reload, save, remove, test, resetCursor, authorizeGmail } = useAccounts()

const providers = ref<ProviderOption[]>([])
const editing = ref<MailAccount | null>(null)
const fields = useAccountFields(editing, providers)
const { setField, defaultConfigFor, syncCustomHostFields, fieldValue } = fields
const editorRef = ref<{ revealField: (key: string) => void } | null>(null)
function revealField(key: string) {
  editorRef.value?.revealField(key)
}

/**
 * 最近一次「测试连接」的结果（**只有这一个操作会写它**）。
 *
 * ⚠⚠ 它曾经还兼着「重置同步位置」的状态，于是模板里那句
 *   `:loading="testState[id]?.status === 'busy'"` 在**重置**进行时命中了
 *   **测试连接**那个按钮 —— 用户看到的是「点重置，测试连接转圈」，而真正的
 *   重置按钮毫无反馈。根因是把「哪个操作在忙」和「上一个结果是什么」塞进了
 *   同一个槽位，而 loading 判据只能看到后者。现在两者分开：
 *   进行中在 `busyOps`，结果在 `probeState`。
 */
const probeState = ref<Record<string, AccountProbeResult | undefined>>({})

/**
 * 每个账号**正在跑**的耗时操作。
 *
 * 用途有三个，都要靠「种类」才说得清：按钮的 loading、另一个按钮要不要禁用
 * （同一个账号上并发两个操作没有意义，而且结果会互相覆盖）、以及状态徽标上那句
 * 「测试中… / 重置中…」。
 */
const busyOps = ref<Record<string, AccountBusyKind | undefined>>({})

const pageError = ref('')
const authorizing = ref(false)
const uiMessage = useAppMessage()

/**
 * 剪贴板里**可能**有用户刚从 peon-hall 复制过来的中继地址。
 *
 * 不是「自动填」：我们只把候选放进 `clipboardCandidate`，在弹窗顶部显示一条
 * 提示，由用户**显式**点【填入】才会写进字段 —— 见 `clipboard-relay.ts` 的说明。
 */
const clipboardCandidate = ref<string | null>(null)

onMounted(async () => {
  await reload()
  const result = await send<{ providers: ProviderOption[] }>('mail:providers', undefined, { providers: [] })
  providers.value = result.providers ?? []

  // 剪贴板检测：等 reload 完了再读（reload 失败时也能填，用户复制没受影响）。
  void probeClipboard()
})

/**
 * 读一次剪贴板，命中就放进 `clipboardCandidate` 等用户确认。
 *
 * ⚠️ 故意**不**在 `onMounted` 期间自动填字段 —— 见 `clipboard-relay.ts` 的
 *   「为什么是『提示 + 按钮』而不是『自动填入』」一段。
 *
 * ⚠️ 只在用户**真正打开账号表单**（`editing` 变非空）时检测才有意义；这一层
 *   让候选常驻是为了「用户先开扩展、剪贴板里已经有 peon-hall 复制的内容、
 *   再点【+ 新增账号】时立刻提示」那条路径。`openEditor()` 在这里重新触发一次，
 *   因为用户从「打开扩展」到「点 + 新增」可能隔几秒，剪贴板内容也可能在这
 *   期间被换（覆盖即可让用户看到新候选 —— 也会因为「不是中继 URL」自动不显示）。
 */
async function probeClipboard(): Promise<void> {
  const text = await readClipboardText()
  if (text && looksLikeClipboardRelayUrl(text)) {
    clipboardCandidate.value = text.trim()
  }
  else {
    clipboardCandidate.value = null
  }
}

/** 用户点【填入】 —— 把候选写进字段，banner 收起。 */
function applyClipboardFromClipboard(): void {
  if (!editing.value || !clipboardCandidate.value)
    return
  setField('relayUrl', clipboardCandidate.value)
  clipboardCandidate.value = null
}

/**
 * 每个账号的连接状态（颜色 / 状态词 / 悬停详情）。
 *
 * ⚠ 做成 `computed` 的**映射**而不是在模板里逐处调 `accountStatus()`：
 *   模板里要同时用它的三个字段，逐处调用等于每次渲染算三遍，
 *   而且三处参数必须一致（漏传一次就会得到与颜色不匹配的详情）。
 *
 * ⚠ 校验逻辑在 `accounts-status.ts`（纯函数、有单测），这里只负责喂数据。
 */
const accountStatuses = computed<Record<string, AccountStatus>>(() =>
  Object.fromEntries(accounts.value.map(account => [account.id, statusOf(account)])),
)

/** 编辑表单那张卡片的状态（新建的账号也走这里 —— 它还没入库，自然没有同步记录） */
const editingStatus = computed(() =>
  editing.value ? statusOf(editing.value) : undefined,
)

function statusOf(account: MailAccount): AccountStatus {
  return accountStatus({
    account,
    probe: probeState.value[account.id],
    busy: busyOps.value[account.id],
    meta: {
      lastSyncText: relativeTime(account.lastSyncedAt),
      cursorText: describeCursor(account.cursor),
    },
  })
}

/**
 * 在账号上跑一个耗时操作（统一处理「标记忙 → 收尾」）。
 *
 * ⚠ `finally` 不能省：操作**抛错**（而不是返回 `{ ok:false }`）时，没有它
 *   `busyOps` 会永远留着那一项 —— 按钮一直转、另一个按钮一直禁用，而界面上
 *   没有任何报错可查。bridge 层虽然包了兜底返回值，但这里不该依赖那个假设。
 *
 * ⚠ 同一个账号上已有操作在跑时直接返回（按钮那边也会禁用，这里是第二道闸）。
 *
 * ⚠ 抛出的错**由各操作自己 catch 并报出去**，不要指望这里吞掉：吞掉会让
 *   「点了一下什么都没发生」成为可能。这里只负责清忙。
 */
async function runOnAccount(account: MailAccount, kind: AccountBusyKind, run: () => Promise<void>) {
  if (busyOps.value[account.id])
    return
  busyOps.value[account.id] = kind
  try {
    await run()
  }
  finally {
    busyOps.value[account.id] = undefined
  }
}

/** 把异常变成一句能给用户看的话 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 打开编辑弹窗。
 *
 * ⚠ 拷一份再编辑（与 `editing.value = { ...account }` 同理）：直接改列表里那条
 *   记录的话，「取消」就失效了 —— 改动已经落在那条记录上。
 *
 * ⚠ 顺手清掉上一次留下的 `pageError`：弹窗是同一个实例（`v-if` 只在开/关时
 *   挂载/卸载，但错误文案是页面级的 ref）。不清的话，新开一个弹窗会先看到
 *   上一次那条「请填写「密码 / 授权码」」。
 */
function openEditor(account: MailAccount) {
  pageError.value = ''
  editing.value = { ...account, config: { ...account.config } }
  syncCustomHostFields(editing.value)
  void probeClipboard()
}

/** 关闭编辑弹窗（取消 / 点遮罩 / Esc 都走这里） */
function closeEditor() {
  editing.value = null
  pageError.value = ''
}

function newAccount() {
  const first = providers.value[0]
  pageError.value = ''
  editing.value = {
    id: `${first?.value ?? 'account'}-${Math.random().toString(36).slice(2, 10)}`,
    label: '',
    email: '',
    provider: first?.value ?? 'gmail',
    config: defaultConfigFor(first),
    blockedList: [],
    enabled: true,
    createdAt: Date.now(),
    cursor: null,
  }
  syncCustomHostFields(editing.value)
  void probeClipboard()
}

async function onSave() {
  if (!editing.value)
    return
  pageError.value = ''

  if (!editing.value.email.trim()) {
    pageError.value = '请填写邮箱地址'
    revealField('email')
    return
  }

  const invalid = validateAccount(editing.value, providers.value)
  if (invalid) {
    pageError.value = invalid.message
    revealField(invalid.key)
    return
  }

  // 邮箱地址同时作为 account.email，改它会让 `by-email` 索引失效 —— 需要重新写
  editing.value.email = editing.value.email.trim().toLowerCase()
  if (!editing.value.label.trim())
    editing.value.label = editing.value.email
  // 顺手把中继地址的首尾空白去掉（用户复制粘贴时很常见）
  if (editing.value.config.relayUrl)
    editing.value.config.relayUrl = editing.value.config.relayUrl.trim()

  try {
    const saved = await save(editing.value)
    if (!saved) {
      pageError.value = '保存账号失败，请重试'
      return
    }
    editing.value = null
    pageError.value = ''
  }
  catch (error) {
    pageError.value = error instanceof Error ? error.message : String(error)
  }
}

/**
 * 「测试连接」也要走同一套校验。
 *
 * 理由：这个按钮是用户**第一次**发现配置有问题的地方。放过格式错误的话，
 * 它会去建一个必然失败的连接，然后把「无法连接中继」当成结论显示出来 ——
 * 而真实原因是「地址没写 ws://」。
 */
async function onTest(account: MailAccount) {
  const invalid = validateAccount(account, providers.value)
  if (invalid) {
    // 这里是**列表卡片**上的「测试连接」，没有可滚动的表单 —— 只报文案
    probeState.value[account.id] = { ok: false, text: invalid.message }
    return
  }

  await runOnAccount(account, 'test', async () => {
    try {
      const result = await test(account)
      probeState.value[account.id] = result.ok
        ? { ok: true, text: result.detail || t('accounts.testOk') }
        : { ok: false, text: result.error || '测试失败' }
    }
    catch (error) {
      // 抛错也要给出结论：否则用户点了「测试连接」，界面上什么都没发生
      probeState.value[account.id] = { ok: false, text: describeError(error) }
    }
  })
}

async function onTestEditing() {
  if (!editing.value)
    return
  await onTest(editing.value)
}

/**
 * 删除账号（不可撤销：该账号已保存的邮件也会一并删除）。
 *
 * ⚠ 从原生 `window.confirm` 换成弹窗组件 —— 理由见 `confirm-action.ts`。
 *   这里必须**解构**返回值（同上）。
 */
const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

function onDelete(account: MailAccount) {
  askConfirm({
    title: t('common.delete'),
    message: t('accounts.deleteConfirm'),
    confirmText: t('common.delete'),
    run: () => remove(account.id),
  })
}

/**
 * 重置同步位置。
 *
 * 语义：连一次、记下当前游标、**不拉历史**。
 *
 * ⚠ 它的结果走**全局 message**，不写进 `probeState`。
 *   这是一次性操作的回执（与「通用」页的导出 / 导入 / 清空同一类），
 *   而 `probeState` 表达的是「这个账号现在能不能连上」。两者混在一起的话，
 *   一次成功的重置会让卡片一直顶着一条与维护动作有关的 tooltip。
 *
 * ⚠ 失败时**不需要**在这里写 `lastError`：background 的
 *   `accounts:reset-cursor` 已经 `markAccountError` 了，所以下面那句 `reload()`
 *   会让徽标自己变红（连不上就是连不上，和测试连接失败是同一档）。
 */
async function onResetCursor(account: MailAccount) {
  await runOnAccount(account, 'reset', async () => {
    try {
      const result = await resetCursor(account.id)
      if (result.ok)
        uiMessage.success(t('accounts.resetCursorDone'))
      else
        uiMessage.error(result.error || '重置失败', ERROR_DURATION)
    }
    catch (error) {
      uiMessage.error(describeError(error), ERROR_DURATION)
    }
    // 无论成败都重读一次：失败时后台刚写过 lastError，徽标要跟着变红
    await reload()
  })
}

/**
 * Gmail 授权。
 *
 * 授权完把 `refreshToken` 填回表单（而不是直接存库）：用户可能还想改 label，
 * 而「授权」与「保存」分成两步时，中途反悔不会留下半成品账号。
 */
async function onAuthorizeGmail() {
  if (!editing.value)
    return
  const clientId = fieldValue('clientId')
  if (!clientId) {
    pageError.value = '请先填写 Google OAuth Client ID'
    return
  }

  authorizing.value = true
  pageError.value = ''
  try {
    const result = await authorizeGmail(clientId)
    if (result.ok && result.refreshToken) {
      setField('refreshToken', result.refreshToken)
      // 一次性回执走全局 message（与重置同步位置同理：它不是账号的连接状态）
      uiMessage.success('授权成功，refresh token 已填入')
    }
    else {
      pageError.value = result.error || '授权失败'
    }
  }
  finally {
    authorizing.value = false
  }
}

/** 表单标题：编辑已有账号还是新增 */
const formTitle = computed(() =>
  editing.value && accounts.value.some(item => item.id === editing.value!.id)
    ? t('accounts.editTitle')
    : t('accounts.addTitle'),
)
</script>

<template>
  <section class="page">
    <div class="header">
      <a-button type="primary" @click="newAccount">
        <span class="i-pixelarticons-plus" aria-hidden="true" />
        {{ t('accounts.add') }}
      </a-button>
    </div>

    <!-- ============ 列表 ============ -->
    <a-card v-if="!accounts.length && !editing" size="small">
      <a-empty :description="t('accounts.empty')" />
    </a-card>

    <AccountCard
      v-for="account in accounts" :key="account.id"
      :account="account" :status="accountStatuses[account.id]" :busy="busyOps[account.id]"
      @test="onTest(account)" @edit="openEditor(account)"
      @reset="onResetCursor(account)" @delete="onDelete(account)"
    />

    <AccountEditor
      v-if="editing" ref="editorRef" v-model:account="editing"
      :fields="fields" :title="formTitle" :status="editingStatus" :error="pageError"
      :clipboard-candidate="clipboardCandidate" :authorizing="authorizing" :busy="busyOps[editing.id]"
      @close="closeEditor" @save="onSave" @test="onTestEditing" @authorize="onAuthorizeGmail"
      @apply-clipboard="applyClipboardFromClipboard" @dismiss-clipboard="clipboardCandidate = null"
    />

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

.header {
  display: flex;
  gap: 8px;
}

/*
 * ⚠ 按钮里「图标 + 文字」的间距统一由 `shared.css` 的
 *   `.ant-btn > [class^='i-']` 负责，这里不再各写一遍。
 */
</style>
