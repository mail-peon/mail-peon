<script setup lang="ts">
import type { AccountStatus } from './accounts-status'
import type { MailAccount, SyncCursor } from '~/logic/types'
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import SecretInput from '~/components/SecretInput.vue'
import { send, useAccounts } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { t } from '~/logic/strings'
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

interface ProviderOption {
  value: string
  label: string
  hint: string
  availability: 'ready' | 'needs-relay'
  availabilityNote?: string
  fields: Array<{
    key: string
    label: string
    type: 'text' | 'password' | 'number' | 'toggle'
    placeholder?: string
    required?: boolean
    default?: string | number | boolean
  }>
}

const { accounts, reload, save, remove, test, resetCursor, authorizeGmail } = useAccounts()

const providers = ref<ProviderOption[]>([])
const editing = ref<MailAccount | null>(null)
const testState = ref<Record<string, { status: 'idle' | 'busy' | 'ok' | 'fail', text: string }>>({})
const pageError = ref('')
const authorizing = ref(false)

onMounted(async () => {
  await reload()
  const result = await send<{ providers: ProviderOption[] }>('mail:providers', undefined, { providers: [] })
  providers.value = result.providers ?? []
})

const currentProvider = computed(() =>
  providers.value.find(item => item.value === editing.value?.provider) ?? null,
)

/** 协议下拉的选项（antd 的 `Select` 要的是 `{ label, value }` 数据） */
const providerOptions = computed(() =>
  providers.value.map(item => ({ value: item.value, label: item.label })),
)

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
  return accountStatus(account, testState.value[account.id], {
    lastSyncText: relativeTime(account.lastSyncedAt),
    cursorText: describeCursor(account.cursor),
  })
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
  editing.value = { ...account }
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
}

function defaultConfigFor(provider: ProviderOption | null | undefined): MailAccount['config'] {
  const config: MailAccount['config'] = {}
  for (const field of provider?.fields ?? []) {
    if (field.default !== undefined)
      (config as Record<string, unknown>)[field.key] = field.default
  }
  return config
}

function onProviderChange(value: unknown) {
  if (!editing.value)
    return
  const provider = providers.value.find(item => item.value === value) ?? null
  /*
   * 切协议时**保留用户已填的通用字段**（如 user / email 里复用的地址），
   * 但把新协议专属字段补上默认值。
   *
   * 不能整个重置成 `defaultConfigFor()`：用户填了一半再切协议时，
   * 那些填过的值会全部消失 —— 而「切错了再切回来」是很常见的操作。
   */
  editing.value.provider = String(value)
  editing.value.config = { ...defaultConfigFor(provider), ...editing.value.config }
}

function setField(key: string, value: unknown) {
  if (!editing.value)
    return
  const config = editing.value.config as Record<string, unknown>
  config[key] = value
}

function fieldValue(key: string): string {
  const raw = (editing.value?.config as Record<string, unknown> | undefined)?.[key]
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * 数字字段的当前值。
 *
 * ⚠ 单独一个函数而不是复用 `fieldValue()` 再 `Number(...)`：
 *   `a-input-number` 要的是**数字或 null**，而「清空输入框」拿到的是 null。
 *   传一个字符串 "NaN" 进去会让那个输入框显示成乱七八糟的东西。
 */
function fieldNumber(key: string): number | null {
  const raw = (editing.value?.config as Record<string, unknown> | undefined)?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function fieldBool(key: string): boolean {
  return (editing.value?.config as Record<string, unknown> | undefined)?.[key] === true
}

/**
 * 按 provider 声明校验必填字段。
 *
 * ⚠ 之前 `required: true` **只用来渲染一个 `*`**，保存与「测试连接」都不检查 ——
 *   于是漏填中继地址、或把地址填成 `127.0.0.1:8787` / `https://…`，
 *   都会一路存下去，直到建立 WebSocket 时才失败。而那时的报错是
 *   「无法连接中继：…」，用户根本不会联想到是「地址少写了协议头」。
 *
 * 校验规则来自 `definition.fields`（单一信源），所以加一个 provider 字段就会自动
 * 被校验，不需要在这里补 `if`。
 *
 * @returns 错误信息；通过时返回空串
 */
function validateAccount(account: MailAccount): string {
  const provider = providers.value.find(item => item.value === account.provider)

  for (const field of provider?.fields ?? []) {
    if (!field.required)
      continue

    const value = (account.config as Record<string, unknown>)[field.key]
    const missing = field.type === 'number'
      // 数字字段：`0` 与空串都算没填（端口 0 不是有效值）
      ? typeof value !== 'number' || !Number.isFinite(value) || value <= 0
      : typeof value !== 'string' || !value.trim()

    if (missing)
      return `请填写「${field.label}」`
  }

  return validateRelayUrl(account)
}

/**
 * 中继地址的格式校验。
 *
 * 单独一条而不是塞进上面的通用循环：这里能给出**可操作**的提示
 * （「要写 `ws://` 开头」），而通用循环只能说「请填写」。
 */
function validateRelayUrl(account: MailAccount): string {
  const raw = account.config.relayUrl?.trim()
  // 只有用得上中继的 provider 才校验（Gmail 那条路不经过中继）
  if (account.provider !== 'imap')
    return ''

  if (!raw)
    return '请填写「WebSocket 中继地址」（本机运行 `pnpm relay` 后填 ws://127.0.0.1:8787/）'

  if (!/^wss?:\/\//i.test(raw)) {
    return `中继地址要以 ws:// 或 wss:// 开头（当前是「${raw}」）。`
      + '本机中继写 ws://127.0.0.1:8787/'
  }

  try {
    void new URL(raw)
  }
  catch {
    return `中继地址不是合法 URL：「${raw}」`
  }

  return ''
}

async function onSave() {
  if (!editing.value)
    return
  pageError.value = ''

  if (!editing.value.email.trim()) {
    pageError.value = '请填写邮箱地址'
    return
  }

  const invalid = validateAccount(editing.value)
  if (invalid) {
    pageError.value = invalid
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
    await save(editing.value)
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
  const invalid = validateAccount(account)
  if (invalid) {
    testState.value[account.id] = { status: 'fail', text: invalid }
    return
  }

  testState.value[account.id] = { status: 'busy', text: t('accounts.testing') }
  const result = await test(account)
  testState.value[account.id] = result.ok
    ? { status: 'ok', text: result.detail || t('accounts.testOk') }
    : { status: 'fail', text: result.error || '测试失败' }
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

async function onResetCursor(account: MailAccount) {
  testState.value[account.id] = { status: 'busy', text: '重置中…' }
  const result = await resetCursor(account.id)
  testState.value[account.id] = result.ok
    ? { status: 'ok', text: t('accounts.resetCursorDone') }
    : { status: 'fail', text: result.error || '重置失败' }
  await reload()
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
      testState.value[editing.value.id] = { status: 'ok', text: '授权成功，refresh token 已填入' }
    }
    else {
      pageError.value = result.error || '授权失败'
    }
  }
  finally {
    authorizing.value = false
  }
}

/** 描述同步游标（让用户知道「同步到哪了」，而不只是一个时间） */
function describeCursor(cursor: SyncCursor | undefined): string {
  if (!cursor)
    return '未建立'
  if (typeof cursor.historyId === 'string')
    return `historyId ${cursor.historyId.slice(0, 10)}…`
  if (typeof cursor.uid === 'number')
    return `UID ${cursor.uid}`
  return '已建立'
}

function relativeTime(ts: number | undefined): string {
  if (!ts)
    return t('accounts.never')
  const diff = Date.now() - ts
  if (diff < 60_000)
    return t('common.justNow')
  if (diff < 3_600_000)
    return t('common.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000)
    return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return new Date(ts).toLocaleString('zh-CN')
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

    <a-card v-for="account in accounts" :key="account.id" size="small">
      <template #title>
        <div class="account-head">
          <span class="account-label">{{ account.label || account.email }}</span>
          <span class="account-email">{{ account.email }}</span>
          <a-tag :bordered="false">
            {{ account.provider }}
          </a-tag>
        </div>
      </template>

      <!--
        连接状态放在卡片**右上角**（`#extra`），与左边的账号信息两端对齐。
        颜色只有圆点，具体原因在悬停的 tooltip 里 —— 这样「坏消息」不再是一整条
        红色横幅把卡片撑开（那是用户报的「突兀的提示」），但信息一点没少。
      -->
      <template #extra>
        <StatusBadge v-bind="accountStatuses[account.id]" />
      </template>

      <div class="account-meta">
        <span>{{ t('accounts.lastSync') }}：{{ relativeTime(account.lastSyncedAt) }}</span>
        <span>同步位置：{{ describeCursor(account.cursor) }}</span>
      </div>

      <a-space class="actions" :size="8" wrap>
        <a-button size="small" :loading="testState[account.id]?.status === 'busy'" @click="onTest(account)">
          {{ t('accounts.test') }}
        </a-button>
        <a-button size="small" @click="openEditor(account)">
          {{ t('common.edit') }}
        </a-button>
        <a-button size="small" @click="onResetCursor(account)">
          {{ t('accounts.resetCursor') }}
        </a-button>
        <a-button size="small" danger @click="onDelete(account)">
          {{ t('common.delete') }}
        </a-button>
      </a-space>
    </a-card>

    <!--
      ============ 新增 / 编辑（弹窗） ============

      ⚠ 原来这块是页面**下方的一张卡片**：点了「编辑」之后表单出现在列表底下，
        用户要往下滚才知道发生了什么，而且它会一直留在页面上（像个幽灵）。
        改成弹窗之后「在编辑哪个账号」是明确的，关掉即消失。

      ⚠ `v-if` + `:open="true"` + `:get-container="false"` —— 与 `ConfirmDialog`
        同一套（那边有详细说明）：关闭时整棵子树不存在，不会留在 Tab 顺序里。
    -->
    <a-modal
      v-if="editing"
      class="editor"
      :open="true"
      :width="560"
      :get-container="false"
      :mask-closable="false"
      :body-style="{ maxHeight: '60vh', overflowY: 'auto' }"
      centered
      @cancel="closeEditor"
    >
      <!--
        标题行：左边「新增 / 编辑账号」，右边这个账号的连接状态。
        ⚠ 与列表卡片保持一致 —— 编辑一个正在报错的账号时，那一目了然的状态不该消失。
        ⚠ `padding-right` 是给右上角的关闭按钮让位（它是绝对定位的）。
      -->
      <template #title>
        <div class="editor-title">
          <span>{{ formTitle }}</span>
          <StatusBadge v-bind="editingStatus" />
        </div>
      </template>

      <!--
        ⚠ 校验/授权失败留在弹窗里（而不是弹一个全局 message）：
          它要跟出错的那个输入框待在一起，而且用户改的时候必须还看得见 ——
          toast 会在两三秒后消失，那时他可能还在改。
      -->
      <a-alert v-if="pageError" class="editor-error" type="error" show-icon :message="pageError" />

      <a-form layout="vertical" class="form">
        <a-form-item :label="t('accounts.label')">
          <a-input v-model:value="editing.label" :placeholder="t('accounts.labelPlaceholder')" />
        </a-form-item>

        <a-form-item :label="t('accounts.email')">
          <a-input v-model:value="editing.email" placeholder="me@example.com" type="email" />
        </a-form-item>

        <a-form-item :label="t('accounts.provider')" :help="currentProvider?.hint">
          <a-select
            class="control"
            :value="editing.provider"
            :options="providerOptions"
            @update:value="onProviderChange"
          />
        </a-form-item>

        <!-- 协议可用性提示：走不通的路要提前说，而不是等「测试连接」报一个看不懂的错 -->
        <a-alert
          v-if="currentProvider && currentProvider.availability !== 'ready'"
          class="notice"
          type="warning"
          show-icon
          :message="currentProvider.availabilityNote"
        />

        <!-- 字段由 provider 声明生成 -->
        <template v-for="field in currentProvider?.fields ?? []" :key="field.key">
          <a-form-item v-if="field.type === 'toggle'" :label="field.label">
            <a-switch
              :checked="fieldBool(field.key)"
              @update:checked="(value: boolean) => setField(field.key, value)"
            />
          </a-form-item>

          <a-form-item
            v-else-if="field.type === 'password'"
            :label="field.label"
            :required="field.required"
          >
            <SecretInput
              :model-value="fieldValue(field.key)"
              :placeholder="field.placeholder"
              @update:model-value="setField(field.key, $event)"
            />
          </a-form-item>

          <a-form-item
            v-else-if="field.type === 'number'"
            :label="field.label"
            :required="field.required"
          >
            <a-input-number
              class="control"
              :value="fieldNumber(field.key)"
              :min="1"
              :placeholder="field.placeholder"
              @update:value="(value: number | null) => setField(field.key, value ?? undefined)"
            />
          </a-form-item>

          <a-form-item v-else :label="field.label" :required="field.required">
            <a-input
              :value="fieldValue(field.key)"
              :placeholder="field.placeholder"
              spellcheck="false"
              @update:value="(value: string) => setField(field.key, value)"
            />
          </a-form-item>

          <!-- Gmail 专属：一键授权 -->
          <div v-if="field.key === 'refreshToken' && editing.provider === 'gmail'" class="oauth">
            <a-button :loading="authorizing" @click="onAuthorizeGmail">
              {{ authorizing ? '授权中…' : '使用 Google 授权' }}
            </a-button>
            <span class="mp-hint">
              需要先在 Google Cloud 建一个「Chrome 扩展」类型的 OAuth 客户端，
              并把此扩展的授权回调地址加进重定向白名单。
            </span>
          </div>
        </template>

        <a-form-item>
          <a-checkbox v-model:checked="editing.enabled">
            {{ t('accounts.enableLabel') }}
          </a-checkbox>
        </a-form-item>
      </a-form>

      <!--
        底部按钮。顺序：诊断动作（测试连接）靠左，取消 / 保存靠右 ——
        「保存」在最右是 antd 的约定（主操作在最外侧）。
      -->
      <template #footer>
        <div class="editor-footer">
          <a-button :loading="testState[editing.id]?.status === 'busy'" @click="onTestEditing">
            {{ t('accounts.test') }}
          </a-button>
          <span class="editor-footer-spacer" />
          <a-button @click="closeEditor">
            {{ t('common.cancel') }}
          </a-button>
          <a-button type="primary" @click="onSave">
            {{ t('common.save') }}
          </a-button>
        </div>
      </template>
    </a-modal>

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

.account-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.account-label {
  font-size: 13px;
  font-weight: 600;
}

.account-email {
  font-size: 12px;
  font-weight: 400;
  color: var(--mp-text-dim);
}

.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

/*
 * 卡片右上角的状态徽标。
 *
 * ⚠ 用 `flex: 0 0 auto` 顶住宽度：`#extra` 里的内容默认可以被压缩，
 *   而「同步失败」这种稍长的状态词被压成两行会很难看（卡片头部是单行高度）。
 *   徽标本身的字号 / 配色在 `components/StatusBadge.vue` 里。
 */
.page :deep(.ant-card-extra) {
  flex: 0 0 auto;
  margin-inline-start: 8px;
}

.form {
  max-width: 520px;
}

/*
 * 弹窗标题行：左边标题、右边连接状态。
 * ⚠ `padding-right: 28px` 给右上角的关闭按钮让位（它是绝对定位的，会盖住内容）。
 */
.editor-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 28px;
}

.editor-error {
  margin-bottom: 12px;
}

/* 底部：诊断动作用左，取消 / 保存靠右 */
.editor-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-footer-spacer {
  flex: 1 1 auto;
}

/* 弹窗里的状态词与列表卡片保持同样的字号 */
.editor :deep(.ant-badge-status-text) {
  font-size: 12px;
  color: var(--mp-text-dim);
}
/* 下拉 / 数字输入不要撑满整行（撑满看起来像「随便填点什么」的文本框） */
.control {
  max-width: 260px;
}

.notice {
  margin-bottom: 14px;
}

.oauth {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 14px;
}

.actions {
  margin-top: 4px;
}
</style>
