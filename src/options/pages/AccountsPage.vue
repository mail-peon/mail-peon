<script setup lang="ts">
import type { MailAccount, SyncCursor } from '~/logic/types'
import { computed, onMounted, ref } from 'vue'
import SecretInput from '~/components/SecretInput.vue'
import { send, useAccounts } from '~/logic/bridge'
import { t } from '~/logic/strings'

/**
 * 账号页（`design/ui-flows.md § 4.2`）。
 *
 * ⚠ 表单是**读 provider 声明渲染**的（`mail:providers` 通道），不是写死的：
 *   字段清单来自 `src/adapters/mail/providers/<id>/index.ts` 的 `fields`，
 *   所以「加了一家 provider 但设置页没有它的输入框」这件事在结构上不可能发生。
 *   写死表单的话，加 provider 要改两个地方，而漏改的表现是「新协议保存后字段全空」。
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

function newAccount() {
  const first = providers.value[0]
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

function onProviderChange(value: string) {
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
  editing.value.provider = value
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

async function onDelete(account: MailAccount) {
  // Options 页里的不可撤销操作走原生 confirm（理由见 GeneralPage.vue 的 confirmOrAbort）
  // eslint-disable-next-line no-alert
  if (!window.confirm(t('accounts.deleteConfirm')))
    return
  await remove(account.id)
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
</script>

<template>
  <section class="page">
    <div class="header">
      <button class="mp-btn mp-btn-primary" type="button" @click="newAccount">
        {{ t('accounts.add') }}
      </button>
    </div>

    <p v-if="pageError" class="mp-error">
      {{ pageError }}
    </p>

    <!-- ============ 列表 ============ -->
    <div v-if="!accounts.length && !editing" class="mp-card empty">
      {{ t('accounts.empty') }}
    </div>

    <div v-for="account in accounts" :key="account.id" class="mp-card account">
      <div class="account-head">
        <span class="account-label">{{ account.label || account.email }}</span>
        <span class="account-email">{{ account.email }}</span>
        <span class="mp-badge">{{ account.provider }}</span>
        <span v-if="!account.enabled" class="mp-badge off">已停用</span>
      </div>

      <div class="account-meta">
        <span>{{ t('accounts.lastSync') }}：{{ relativeTime(account.lastSyncedAt) }}</span>
        <span>同步位置：{{ describeCursor(account.cursor) }}</span>
      </div>

      <p v-if="account.lastError" class="mp-error">
        {{ account.lastError }}
      </p>

      <div class="actions">
        <button class="mp-btn" type="button" :disabled="testState[account.id]?.status === 'busy'" @click="onTest(account)">
          {{ t('accounts.test') }}
        </button>
        <button class="mp-btn" type="button" @click="editing = { ...account }">
          {{ t('common.edit') }}
        </button>
        <button class="mp-btn" type="button" @click="onResetCursor(account)">
          {{ t('accounts.resetCursor') }}
        </button>
        <button class="mp-btn mp-btn-danger" type="button" @click="onDelete(account)">
          {{ t('common.delete') }}
        </button>
      </div>

      <p v-if="testState[account.id]" class="test-result" :class="testState[account.id].status">
        {{ testState[account.id].text }}
      </p>
    </div>

    <!-- ============ 编辑表单 ============ -->
    <div v-if="editing" class="mp-card">
      <p class="mp-section-title">
        {{ accounts.some(item => item.id === editing!.id) ? t('accounts.editTitle') : t('accounts.addTitle') }}
      </p>

      <div class="form">
        <label class="mp-field">
          <span class="mp-field-label">{{ t('accounts.label') }}</span>
          <input v-model="editing.label" class="mp-input" :placeholder="t('accounts.labelPlaceholder')">
        </label>

        <label class="mp-field">
          <span class="mp-field-label">邮箱地址</span>
          <input v-model="editing.email" class="mp-input" placeholder="me@example.com" type="email">
        </label>

        <label class="mp-field">
          <span class="mp-field-label">{{ t('accounts.provider') }}</span>
          <select
            class="mp-select"
            :value="editing.provider"
            @change="onProviderChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="item in providers" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
          <span v-if="currentProvider?.hint" class="mp-hint">{{ currentProvider.hint }}</span>
        </label>

        <!-- 协议可用性提示：走不通的路要提前说，而不是等「测试连接」报一个看不懂的错 -->
        <p v-if="currentProvider?.availability !== 'ready'" class="notice">
          ⚠️ {{ currentProvider?.availabilityNote }}
        </p>

        <!-- 字段由 provider 声明生成 -->
        <template v-for="field in currentProvider?.fields ?? []" :key="field.key">
          <label v-if="field.type === 'toggle'" class="mp-checkbox">
            <input
              type="checkbox"
              :checked="fieldBool(field.key)"
              @change="setField(field.key, ($event.target as HTMLInputElement).checked)"
            >
            <span>{{ field.label }}</span>
          </label>

          <label v-else-if="field.type === 'password'" class="mp-field">
            <span class="mp-field-label">
              {{ field.label }}<span v-if="field.required" class="req">*</span>
            </span>
            <SecretInput
              :model-value="fieldValue(field.key)"
              :placeholder="field.placeholder"
              @update:model-value="setField(field.key, $event)"
            />
          </label>

          <label v-else class="mp-field">
            <span class="mp-field-label">
              {{ field.label }}<span v-if="field.required" class="req">*</span>
            </span>
            <input
              class="mp-input"
              :type="field.type === 'number' ? 'number' : 'text'"
              :value="fieldValue(field.key)"
              :placeholder="field.placeholder"
              @input="setField(field.key, field.type === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)"
            >
          </label>

          <!-- Gmail 专属：一键授权 -->
          <div v-if="field.key === 'refreshToken' && editing.provider === 'gmail'" class="oauth">
            <button class="mp-btn" type="button" :disabled="authorizing" @click="onAuthorizeGmail">
              {{ authorizing ? '授权中…' : '使用 Google 授权' }}
            </button>
            <span class="mp-hint">
              需要先在 Google Cloud 建一个「Chrome 扩展」类型的 OAuth 客户端，
              并把此扩展的授权回调地址加进重定向白名单。
            </span>
          </div>
        </template>

        <label class="mp-checkbox">
          <input v-model="editing.enabled" type="checkbox">
          <span>{{ t('accounts.enableLabel') }}</span>
        </label>
      </div>

      <p v-if="testState[editing.id]" class="test-result" :class="testState[editing.id].status">
        {{ testState[editing.id].text }}
      </p>

      <div class="actions">
        <button class="mp-btn mp-btn-primary" type="button" @click="onSave">
          {{ t('common.save') }}
        </button>
        <button class="mp-btn" type="button" :disabled="testState[editing.id]?.status === 'busy'" @click="onTestEditing">
          {{ t('accounts.test') }}
        </button>
        <button class="mp-btn" type="button" @click="editing = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
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

.empty {
  color: var(--mp-text-faint);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}

.account-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}

.account-label {
  font-size: 13px;
  font-weight: 600;
}

.account-email {
  font-size: 12px;
  color: var(--mp-text-dim);
}

.mp-badge.off {
  color: var(--mp-warn);
}

.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.req {
  color: var(--mp-danger);
  margin-left: 2px;
}

.notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--mp-warn) 40%, transparent);
  background: color-mix(in srgb, var(--mp-warn) 10%, transparent);
  font-size: 11px;
  line-height: 1.6;
}

.oauth {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.test-result {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
}

.test-result.busy { color: var(--mp-text-faint); }
.test-result.ok { color: var(--mp-success); }
.test-result.fail { color: var(--mp-danger); }
</style>
