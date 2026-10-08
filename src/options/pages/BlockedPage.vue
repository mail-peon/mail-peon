<script setup lang="ts">
import type { BlockedEntry, MailAccount } from '~/logic/types'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccounts, useSettings } from '~/logic/bridge'
import { parseBlockedText } from '~/logic/rules/blocked'
import { t } from '~/logic/strings'

/**
 * 屏蔽列表页（`design/ui-flows.md § 4.5` + `features/06-blocked-senders.md § 5`）。
 *
 * ⚠ 列表是 **per-account** 的（挂在 `MailAccount.blockedList` 上，不是全局设置）——
 *   见 `decisions/open-questions.md` Q7：同一个发件人在不同账号里的意义完全不同。
 *   所以这一页必须有「当前账号」选择器，即便 MVP 只有一个账号。
 *
 * ⚠ 改动**立即写库**（没有「保存」按钮）：屏蔽列表是「越用越长」的工具，
 *   用户通常是一封封加进去的。要求每次点保存会把这件事变得很烦 ——
 *   而它完全可逆（删掉那一项即可），不像密码那样需要「确认才生效」。
 */

const { accounts, reload: reloadAccounts, save } = useAccounts()
const { app, setApp } = useSettings()

const selectedId = ref<string>('')
const input = ref('')
const batchVisible = ref(false)
const batchText = ref('')
const error = ref('')

onMounted(async () => {
  await reloadAccounts()
  selectedId.value = accounts.value[0]?.id ?? ''
})

// 账号列表加载完之后如果还没选中，选第一个
watch(accounts, (list) => {
  if (!selectedId.value && list.length)
    selectedId.value = list[0].id
})

const selected = computed<MailAccount | undefined>(() =>
  accounts.value.find(account => account.id === selectedId.value),
)

const blockedList = computed<BlockedEntry[]>(() => selected.value?.blockedList ?? [])

async function persist(list: BlockedEntry[]) {
  const account = selected.value
  if (!account)
    return
  await save({ ...account, blockedList: list })
}

async function onAdd() {
  error.value = ''
  const entries = parseBlockedText(input.value)
  if (!entries.length) {
    error.value = '请填一个邮箱地址或域名'
    return
  }
  if (!selected.value) {
    error.value = '请先添加一个邮箱账号'
    return
  }

  // 去重：重复项在列表里会让用户以为「加了两次却没生效」
  const existing = new Set(blockedList.value.map(item => `${item.kind}\u0000${item.value}`))
  const additions = entries.filter(item => !existing.has(`${item.kind}\u0000${item.value}`))

  await persist([...blockedList.value, ...additions])
  input.value = ''
}

async function onRemove(entry: BlockedEntry) {
  await persist(blockedList.value.filter(item => !(item.kind === entry.kind && item.value === entry.value)))
}

async function onApplyBatch() {
  error.value = ''
  const entries = parseBlockedText(batchText.value)
  if (!entries.length) {
    error.value = '没有解析出任何有效条目'
    return
  }
  const existing = new Set(blockedList.value.map(item => `${item.kind}\u0000${item.value}`))
  const additions = entries.filter(item => !existing.has(`${item.kind}\u0000${item.value}`))
  await persist([...blockedList.value, ...additions])
  batchText.value = ''
  batchVisible.value = false
}

function label(entry: BlockedEntry): string {
  return entry.kind === 'domain' ? `@${entry.value}` : entry.value
}

function kindLabel(entry: BlockedEntry): string {
  return entry.kind === 'email' ? t('blocked.kindEmail') : t('blocked.kindDomain')
}
</script>

<template>
  <section class="page">
    <div class="mp-card">
      <label class="mp-checkbox">
        <input
          type="checkbox"
          :checked="app?.blockedEnabled ?? true"
          @change="setApp({ blockedEnabled: ($event.target as HTMLInputElement).checked })"
        >
        <span>{{ t('blocked.enabled') }}</span>
      </label>
      <p class="mp-hint indent">
        {{ t('blocked.hint') }}
      </p>
    </div>

    <div v-if="!accounts.length" class="mp-card empty">
      还没有邮箱账号；请先在「账号」页添加。
    </div>

    <template v-else>
      <div class="mp-card">
        <label class="mp-field">
          <span class="mp-field-label">{{ t('blocked.account') }}</span>
          <select v-model="selectedId" class="mp-select">
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.label || account.email }}（{{ account.email }}）
            </option>
          </select>
        </label>
      </div>

      <div class="mp-card">
        <div class="add-row">
          <input
            v-model="input"
            class="mp-input"
            :placeholder="t('blocked.addPlaceholder')"
            spellcheck="false"
            @keydown.enter="onAdd"
          >
          <button class="mp-btn mp-btn-primary" type="button" @click="onAdd">
            {{ t('blocked.add') }}
          </button>
          <button class="mp-btn" type="button" @click="batchVisible = !batchVisible">
            {{ t('blocked.batch') }}
          </button>
        </div>

        <p v-if="error" class="mp-error">
          {{ error }}
        </p>

        <div v-if="batchVisible" class="batch">
          <textarea
            v-model="batchText"
            class="mp-textarea"
            rows="6"
            :placeholder="t('blocked.batchPlaceholder')"
            spellcheck="false"
          />
          <div class="actions">
            <button class="mp-btn mp-btn-primary" type="button" @click="onApplyBatch">
              {{ t('blocked.batchApply') }}
            </button>
            <button class="mp-btn" type="button" @click="batchVisible = false">
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <hr class="mp-divider">

        <p v-if="!blockedList.length" class="empty-inline">
          {{ t('blocked.empty') }}
        </p>

        <ul v-else class="list">
          <li v-for="entry in blockedList" :key="`${entry.kind}:${entry.value}`" class="item">
            <span class="mp-badge">{{ kindLabel(entry) }}</span>
            <code class="value">{{ label(entry) }}</code>
            <button class="mp-btn remove" type="button" @click="onRemove(entry)">
              {{ t('common.delete') }}
            </button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.indent {
  margin: 6px 0 0 20px;
}

.empty {
  color: var(--mp-text-faint);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}

.empty-inline {
  margin: 0;
  font-size: 12px;
  color: var(--mp-text-faint);
}

.add-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.batch {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.value {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.remove {
  flex: 0 0 auto;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
