<script setup lang="ts">
import type { Mail } from '~/logic/types'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import EmptyState from '~/components/EmptyState.vue'
import MailListItem from '~/components/MailListItem.vue'
import { useMailActions } from '~/composables/useMailActions'
import { useMailView } from '~/composables/useMailView'
import { useMails, useMailTypes, useSettings } from '~/logic/bridge'
import { useMailFocus } from '~/logic/mail-focus'
import { t } from '~/logic/strings'

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

// ⚠ `reload` 这个名字已经被下面的 `useSettings()` 占了，重命名避免遮蔽
const { mails, loading, loadFailed, justCopied, copyCode, setRead, dismiss, trash, reload: reloadMails } = useMails(300)
const { app, reload } = useSettings()
const { adapters } = useMailTypes()
const { activeFilter, minimalMode, filters, visibleMails, codeMails, emptyText } = useMailView(mails, app, adapters)
const { trashPending, trashDialog, askTrashConfirm, cancelTrashConfirm, onConfirmTrash, onConfirm } = useMailActions({
  trash,
  setRead,
  openUrl: url => browser.tabs.create({ url }),
})

/** 「点 toast → 把这封滚到眼前」，与 Popup 共用同一套（见 `logic/mail-focus.ts`） */
const { focusedId } = useMailFocus()

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
      <a-tag v-else class="mode-tag" :bordered="false">
        {{ t('app.customSuffix') }}
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
        <!-- 失败态排在空态前面 —— 理由见 `popup/Popup.vue` 同处 -->
        <EmptyState
          v-else-if="loadFailed"
          :text="t('mail.loadFailed')"
          :hint="t('mail.loadFailedHint')"
          :action-text="t('common.retry')"
          @action="reloadMails"
        />
        <EmptyState v-else-if="!codeMails.length" :text="t('popup.codeEmpty')" />
        <!-- `v-if` 放在外层 `<template>` 上 —— 见 `popup/Popup.vue` 里同处的说明 -->
        <template v-if="codeMails.length">
          <MailListItem
            v-for="mail in codeMails"
            :key="mail.id"
            :mail="mail"
            :just-copied="justCopied.has(mail.id)"
            :focused="focusedId === mail.id"
            minimal
            @copy="(item: Mail) => copyCode(item)"
            @confirm="onConfirm"
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
      <a-tabs v-model:active-key="activeFilter" class="tabs" size="small">
        <a-tab-pane v-for="filter in filters" :key="filter.id">
          <template #tab>
            <span class="tab-label">
              {{ filter.label }}
              <a-badge
                v-if="filter.count > 0"
                :count="filter.count"
                :overflow-count="99"
              />
            </span>
          </template>

          <div class="list">
            <a-spin v-if="loading" class="loading" size="small" />
            <!-- 失败态排在空态前面 —— 理由见 `popup/Popup.vue` 同处 -->
            <EmptyState
              v-else-if="loadFailed"
              :text="t('mail.loadFailed')"
              :hint="t('mail.loadFailedHint')"
              :action-text="t('common.retry')"
              @action="reloadMails"
            />
            <EmptyState v-else-if="!visibleMails.length" :text="emptyText(filter.id, filter.label)" />
            <!-- `v-if` 放在外层 `<template>` 上 —— 理由见上面极简模式那段 -->
            <template v-if="visibleMails.length">
              <MailListItem
                v-for="mail in visibleMails"
                :key="mail.id"
                :mail="mail"
                :just-copied="justCopied.has(mail.id)"
                :focused="focusedId === mail.id"
                @copy="(item: Mail) => copyCode(item)"
                @confirm="onConfirm"
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
      @confirm="onConfirmTrash"
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
