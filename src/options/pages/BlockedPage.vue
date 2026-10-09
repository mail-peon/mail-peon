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

/** 账号下拉的选项 */
const accountOptions = computed(() =>
  accounts.value.map(account => ({
    value: account.id,
    label: `${account.label || account.email}（${account.email}）`,
  })),
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
    <a-card size="small">
      <a-checkbox
        :checked="app?.blockedEnabled ?? true"
        @update:checked="(value: boolean) => setApp({ blockedEnabled: value })"
      >
        {{ t('blocked.enabled') }}
      </a-checkbox>
      <p class="mp-hint indent">
        {{ t('blocked.hint') }}
      </p>
    </a-card>

    <a-card v-if="!accounts.length" size="small">
      <a-empty description="还没有邮箱账号；请先在「账号」页添加。" />
    </a-card>

    <template v-else>
      <a-card size="small">
        <a-form layout="vertical">
          <a-form-item :label="t('blocked.account')">
            <a-select
              v-model:value="selectedId"
              class="control"
              :options="accountOptions"
            />
          </a-form-item>
        </a-form>
      </a-card>

      <a-card size="small">
        <div class="add-row">
          <a-input
            v-model:value="input"
            :placeholder="t('blocked.addPlaceholder')"
            spellcheck="false"
            @press-enter="onAdd"
          />
          <a-button type="primary" @click="onAdd">
            {{ t('blocked.add') }}
          </a-button>
          <a-button @click="batchVisible = !batchVisible">
            {{ t('blocked.batch') }}
          </a-button>
        </div>

        <a-alert v-if="error" class="add-error" type="error" show-icon :message="error" />

        <div v-if="batchVisible" class="batch">
          <a-textarea
            v-model:value="batchText"
            :rows="6"
            :placeholder="t('blocked.batchPlaceholder')"
            spellcheck="false"
          />
          <a-space :size="8">
            <a-button type="primary" @click="onApplyBatch">
              {{ t('blocked.batchApply') }}
            </a-button>
            <a-button @click="batchVisible = false">
              {{ t('common.cancel') }}
            </a-button>
          </a-space>
        </div>

        <a-divider class="divider" />

        <a-empty v-if="!blockedList.length" :description="t('blocked.empty')" />

        <a-list v-else size="small">
          <a-list-item v-for="entry in blockedList" :key="`${entry.kind}:${entry.value}`">
            <a-tag :bordered="false">
              {{ kindLabel(entry) }}
            </a-tag>
            <code class="value">{{ label(entry) }}</code>
            <template #actions>
              <a-button size="small" type="text" danger @click="onRemove(entry)">
                {{ t('common.delete') }}
              </a-button>
            </template>
          </a-list-item>
        </a-list>
      </a-card>
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
  margin: 6px 0 0 24px;
}

.control {
  max-width: 320px;
}

.add-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.add-error {
  margin-top: 10px;
}

.batch {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.divider {
  margin: 14px 0;
}

/*
 * `a-list-item` 的默认布局是「左侧内容 + 右侧 actions」两栏，
 * 这里让左侧内容自己排成一行（标签 + 等宽字体的条目）。
 */
.page :deep(.ant-list-item) {
  padding: 6px 0;
  gap: 8px;
}

.value {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--mp-font-mono);
  font-size: 12px;
  word-break: break-all;
}
</style>
