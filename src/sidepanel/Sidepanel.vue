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
 *
 * 构件同样是 Ant Design Vue（`a-tabs` / `a-button` / `a-spin` / `a-tag`），
 * 与 Popup 保持同一套视觉语言 —— 两者是同一个产品的两个入口。
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
      <a-tag v-if="minimalMode" class="mode-tag" :bordered="false">
        {{ t('app.minimalSuffix') }}
      </a-tag>
      <a-button class="open-options" size="small" @click="openOptions">
        <span class="i-pixelarticons-settings-2" aria-hidden="true" />
        {{ t('popup.openOptions') }}
      </a-button>
    </header>

    <!-- 极简模式：只有验证码 -->
    <template v-if="minimalMode">
      <div class="list">
        <a-spin v-if="loading" class="loading" size="small" />
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
      <!--
        ⚠ tab 面板的高度要一路撑到列表上（下面的 `:deep` 几行）：
          侧边栏是 100vh 的固定高度，面板不撑满的话列表不会滚动。
          链条与 `Popup.vue` 里的完全相同，那边有更详细的说明。
      -->
      <a-tabs v-model:active-key="activeTab" class="tabs" size="small">
        <a-tab-pane v-for="tab in TAB_ORDER" :key="tab">
          <template #tab>
            <span class="tab-label">
              {{ t(tabLabelKey(tab)) }}
              <a-badge
                v-if="displayCount(counts[tab])"
                :count="counts[tab]"
                :overflow-count="99"
              />
            </span>
          </template>

          <div class="list">
            <a-spin v-if="loading" class="loading" size="small" />
            <EmptyState v-else-if="!visibleMails.length" :text="t(tabEmptyKey(activeTab))" />
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
        </a-tab-pane>
      </a-tabs>
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

.mode-tag {
  margin: 0;
  font-size: 11px;
  line-height: 18px;
}

.open-options {
  margin-left: auto;
}

/*
 * tab 条与面板：整块占满中间的高度（理由同 `Popup.vue`，那边写得更细）。
 * 侧边栏比弹窗宽得多，所以 tab 条左右留白给足一点。
 */
.tabs {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tabs :deep(.ant-tabs-nav) {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 12px;
}

.tabs :deep(.ant-tabs-content-holder) {
  flex: 1 1 auto;
  min-height: 0;
}

.tabs :deep(.ant-tabs-content) {
  height: 100%;
}

.tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
}

.tabs :deep(.ant-badge-count) {
  height: 16px;
  min-width: 16px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 16px;
  box-shadow: none;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.list {
  height: 100%;
  /* `min-height: 0` 与 `overflow-y: auto` 是一对 —— 见 `popup/Popup.vue` 里的说明 */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.loading {
  align-self: center;
  margin: 24px 0;
}
</style>
