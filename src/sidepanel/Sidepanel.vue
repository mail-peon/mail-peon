<script setup lang="ts">
import type { Mail, PopupTab } from '~/logic/types'
import { computed, ref } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import EmptyState from '~/components/EmptyState.vue'
import MailListItem from '~/components/MailListItem.vue'
import { useMails, useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'
import { useTrashConfirm } from '~/logic/trash-confirm'
import {
  countByTab,
  displayCount,
  filterMails,
  minimalModeMails,
  sortMails,
  TAB_ORDER,
  tabEmptyKey,
  tabLabelKey,
} from '~/popup/list-filter'

/**
 * Sidepanel —— 「展开后的完整视图」（`design/ui-flows.md § 2`）。
 *
 * 与 Popup 的两个行为差异，都是「它不会自动关闭」这个事实推出来的：
 *
 *   1. **不自动标已读**。Popup 打开 = 用户主动看了一眼（标已读合理）；而侧边栏
 *      常常是「开着但没在看」—— 自动标已读会把 badge 清掉，用户就真漏了邮件。
 *   2. **保留完整的展开 / 收起操作**，因为它有空间，而 Popup 的 480px 高度下
 *      展开两封就到底了。
 */

const { mails, loading, justCopied, copyCode, setRead, dismiss, trash } = useMails(300)
const { app, reload } = useSettings()

/**
 * 删除确认（与 Popup 共用同一套交互）。
 *
 * ⚠ 必须**解构**：Vue 的模板自动解包只对 setup 直接暴露的 ref 生效，
 *   不会递归进普通对象。写成 `tc.pending` 会拿到 ref 对象本身（恒为真值）
 *   ⇒ 弹窗一打开就铺满界面且没有内容。详见 `popup/Popup.vue` 里的同处说明。
 */
const {
  pending: trashPending,
  dialog: trashDialog,
  ask: askTrashConfirm,
  cancel: cancelTrashConfirm,
  confirm: confirmTrashConfirm,
} = useTrashConfirm(trash)

const activeTab = ref<PopupTab>('important')

const minimalMode = computed(() => app.value?.minimalMode ?? true)
const excludeAds = computed(() => app.value?.excludeAds ?? true)

const counts = computed(() => countByTab(mails.value, { excludeAds: excludeAds.value }))
const visibleMails = computed(() =>
  sortMails(filterMails(mails.value, activeTab.value, { excludeAds: excludeAds.value })),
)
const codeMails = computed(() => minimalModeMails(mails.value))

void reload()

function openOptions() {
  browser.runtime.openOptionsPage()
}
</script>

<template>
  <main class="panel">
    <header class="head">
      <span class="brand">{{ t('app.name') }}</span>
      <span v-if="minimalMode" class="mode">{{ t('app.minimalSuffix') }}</span>
      <button class="mp-btn open-options" type="button" @click="openOptions">
        {{ t('popup.openOptions') }}
      </button>
    </header>

    <!-- 极简模式：只有验证码 -->
    <template v-if="minimalMode">
      <div class="list">
        <p v-if="loading" class="loading">
          {{ t('common.loading') }}
        </p>
        <EmptyState v-else-if="!codeMails.length" :text="t('popup.codeEmpty')" />
        <!-- `v-if` 放在外层 `<template>` 上 —— 见 `popup/Popup.vue` 里同处的说明 -->
        <template v-if="codeMails.length">
          <MailListItem
            v-for="mail in codeMails"
            :key="mail.id"
            :mail="mail"
            :just-copied="justCopied.has(mail.id)"
            minimal
            @copy="(item: Mail) => copyCode(item)"
            @trash="(item: Mail) => askTrashConfirm(item)"
            @open="(item: Mail) => { if (!item.read) setRead(item, true) }"
          />
        </template>
      </div>
    </template>

    <template v-else>
      <nav class="tabs">
        <button
          v-for="tab in TAB_ORDER"
          :key="tab"
          class="tab"
          type="button"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >
          {{ t(tabLabelKey(tab)) }}
          <span v-if="displayCount(counts[tab])" class="mp-badge">{{ counts[tab] }}</span>
        </button>
      </nav>

      <div class="list">
        <p v-if="loading" class="loading">
          {{ t('common.loading') }}
        </p>
        <EmptyState v-else-if="!visibleMails.length" :text="t(tabEmptyKey(activeTab))" />
        <!-- `v-if` 而不是 `v-else` —— 理由见上面极简模式那段 -->
        <!-- `v-if` 放在外层 `<template>` 上 —— 理由见上面极简模式那段 -->
        <template v-if="visibleMails.length">
          <MailListItem
            v-for="mail in visibleMails"
            :key="mail.id"
            :mail="mail"
            :just-copied="justCopied.has(mail.id)"
            @copy="(item: Mail) => copyCode(item)"
            @read="(item: Mail, read: boolean) => setRead(item, read)"
            @dismiss="(item: Mail) => dismiss(item)"
            @trash="(item: Mail) => askTrashConfirm(item)"
            @open="(item: Mail) => { if (!item.read) setRead(item, true) }"
          />
        </template>
      </div>
    </template>

    <!-- 删除确认（与 Popup 共用同一套交互）—— 变量来自 `useTrashConfirm` 的解构，见脚本里的说明 -->
    <ConfirmDialog
      :open="trashPending !== null"
      :title="trashDialog.title"
      :message="trashDialog.message"
      :confirm-text="t('mail.trash')"
      danger
      @confirm="confirmTrashConfirm"
      @cancel="cancelTrashConfirm"
    />
  </main>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mp-border);
}

.brand {
  font-size: 13px;
  font-weight: 600;
}

.mode {
  font-size: 11px;
  color: var(--mp-text-faint);
}

.open-options {
  margin-left: auto;
}

.tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--mp-border);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--mp-text-dim);
  font-size: 12px;
  font-family: inherit;
  padding: 6px 8px 7px;
  cursor: pointer;
  white-space: nowrap;
}

.tab:hover {
  color: var(--mp-text);
}

.tab.active {
  color: var(--mp-text);
  border-bottom-color: var(--mp-accent);
  font-weight: 600;
}

.list {
  flex: 1 1 auto;
  /* `min-height: 0` 与 `overflow-y: auto` 是一对 —— 见 `popup/Popup.vue` 里的说明 */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.loading {
  margin: 0;
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--mp-text-faint);
}
</style>
