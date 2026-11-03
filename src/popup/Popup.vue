<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, onMounted, watch } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import EmptyState from '~/components/EmptyState.vue'
import MailListItem from '~/components/MailListItem.vue'
import { useMailActions } from '~/composables/useMailActions'
import { useMailView } from '~/composables/useMailView'
import { useSyncRequest } from '~/composables/useSyncRequest'
import { useAccounts, useMails, useMailTypes, useSettings } from '~/logic/bridge'
import { useMailFocus } from '~/logic/mail-focus'
import { t } from '~/logic/strings'

/**
 * Popup（点工具栏图标）—— 两种模式两套布局（`design/ui-flows.md § 1`）。
 *
 * ⚠ 顶层按 `minimalMode` **分发**，而不是在同一个模板里到处写 `v-if`：
 *   两套模式的**信息架构**不同（极简只有一列验证码；完整有四个分区 + 摘要 + 展开），
 *   混在一个模板里会让两边都变得难改 —— 而它们本来是独立的两个产品面。
 *
 * 界面全部构件在 Ant Design Vue 上（`a-tabs` / `a-alert` / `a-button` / `a-spin`），
 * 主题由 `mount-app.ts` 里的 `ConfigProvider` 注入。这里只写「antd 没提供的东西」
 * 的样式：360×480 的窗口骨架、列表自身的滚动。
 */
const { mails, loading, loadFailed, justCopied, copyCode, setRead, dismiss, trash, markAllRead, reload } = useMails(200)
const { app, ai, reload: reloadSettings } = useSettings()
const { syncNow, syncStatus } = useAccounts()
const { adapters } = useMailTypes()
const { activeFilter, minimalMode, filters, visibleMails, codeMails, emptyText } = useMailView(mails, app, adapters)
const { trashPending, trashDialog, askTrashConfirm, cancelTrashConfirm, onConfirmTrash, onConfirm } = useMailActions({
  trash,
  setRead,
  openUrl: url => browser.tabs.create({ url }),
})
const { syncing: refreshing, start: refresh } = useSyncRequest({
  start: syncNow,
  status: syncStatus,
  timeoutMs: 90_000,
})

/**
 * 「点 toast → 把这封滚到眼前」（见 `logic/mail-focus.ts`）。
 *
 * ⚠ 这个功能以前是**只做了一半**的：内容脚本一直在发 `mail:focus`，
 *   而没有任何接收端。现在补上了，而且它天然对两种模式都生效
 *   （极简列表与完整列表都用 `MailListItem`）。
 */
const { focusedId } = useMailFocus()
const hasAiKey = computed(() => !!ai.value?.apiKey)

/**
 * 诊断输出：**库里有记录，当前视图却一条都没有**。
 *
 * ⚠ 只在「有数据但渲染为 0」时才打。这才是需要解释的情况：数据确实到了 Popup
 *   （`mail:list` 通了），只是被模式 / 筛选过滤掉了。
 */
watch([mails, activeFilter, minimalMode], () => {
  if (!mails.value.length)
    return

  const rendered = minimalMode.value ? codeMails.value.length : visibleMails.value.length
  if (rendered)
    return

  const where = minimalMode.value
    ? '极简模式（只渲染验证码 / 确认）'
    : `筛选「${activeFilter.value}」`
  console.warn(`[mail-peon] Popup 有 ${mails.value.length} 条记录，但当前视图 0 条：${where}`)
}, { immediate: true })

function openOptions() {
  browser.runtime.openOptionsPage()
}

/**
 * 打开 Popup 即把 badge 归零，并**立即检查一次新邮件**。
 *
 * 设计文档 `ui-flows.md § 3.1`：「打开 Popup → 当前 tab 的 badge 归零」。
 * 极简模式没有 badge，但标已读本身仍然有意义（用户看过列表了）。
 *
 * ⚠ 为什么这里要主动检查：QQ 的 IMAP IDLE 实测不推 `EXISTS`，后台只能按
 *   「自动检查间隔」定时拉。用户点开 Popup 是「我现在就想看」，不应该再等
 *   几分钟后的下一次 alarm —— 这里先标已读，再让后台跑一轮增量。
 *
 * ⚠ 不等结果：`syncNow()` 只负责启动，结果由 `mail:updated` 广播刷新列表。
 *   如果等它跑完，Popup 的 `sendMessage` 会在同步超过 30 秒时被 MV3 回收。
 */
async function onOpened() {
  await reloadSettings()
  await markAllRead()
  await refresh()
}
onMounted(() => {
  void onOpened()
})

function onCopy(mail: Mail) {
  void copyCode(mail)
}

function onRead(mail: Mail, read: boolean) {
  void setRead(mail, read)
}

function onDismiss(mail: Mail) {
  void dismiss(mail)
}

function onTrash(mail: Mail) {
  askTrashConfirm(mail)
}

function onOpen(mail: Mail) {
  // 打开一整封邮件没有「邮件详情页」可去（设计文档明确不替代邮箱 UI）——
  // 展开卡片看摘要就够了，所以这里只标已读
  if (!mail.read)
    void setRead(mail, true)
}
</script>

<template>
  <main class="popup">
    <!-- ============ 极简模式：只有验证码 ============ -->
    <template v-if="minimalMode">
      <header class="head">
        <span class="brand">{{ t('app.name') }}</span>
        <a-tag class="mode-tag" :bordered="false">
          {{ t('app.minimalSuffix') }}
        </a-tag>
        <a-button
          class="refresh-btn"
          type="text"
          size="small"
          :title="refreshing ? t('popup.refreshing') : t('popup.refresh')"
          :aria-label="refreshing ? t('popup.refreshing') : t('popup.refresh')"
          :aria-busy="refreshing"
          @click="refresh"
        >
          <span
            class="i-solar-refresh-line-duotone refresh-icon"
            :class="{ spinning: refreshing }"
            aria-hidden="true"
          />
        </a-button>
      </header>

      <!-- 缺 AI Key 时的行动号召：antd 的 Alert 自带图标与配色，比手写一个黄框稳 -->
      <a-alert
        v-if="!hasAiKey"
        class="cta"
        type="warning"
        show-icon
      >
        <template #message>
          <span class="cta-row">
            <span>{{ t('general.aiKeyMissing') }}</span>
            <a-button size="small" type="primary" @click="openOptions">
              {{ t('general.aiKeyMissingAction') }}
            </a-button>
          </span>
        </template>
      </a-alert>

      <p class="section-label">
        {{ t('popup.codeHistory') }}
      </p>

      <div class="list">
        <a-spin v-if="loading" class="loading" size="small" />
        <!--
          ⚠ 失败态必须排在空态**前面**：`send` 失败返回的是空列表兜底值，
            只判 `!codeMails.length` 的话会告诉用户「还没有收到邮件」——
            而他可能刚收到一封验证码。这是界面在陈述假事实，不是缺个提示。
        -->
        <EmptyState
          v-else-if="loadFailed"
          :text="t('mail.loadFailed')"
          :hint="t('mail.loadFailedHint')"
          :action-text="t('common.retry')"
          @action="reload"
        />
        <EmptyState v-else-if="!codeMails.length" :text="t('popup.codeEmpty')" />
        <!--
          ⚠ `v-if` 放在**外层 `<template>`** 上，而不是与 `v-for` 写在同一元素上。
          两者同元素时 Vue 会警告（`vue/no-use-v-if-with-v-for`），
          而且语义容易读错：`v-if` 与 `v-for` 谁先求值取决于编译顺序。
          包一层后意图毫无歧义 —— 有数据才进入循环。
        -->
        <template v-if="codeMails.length">
          <MailListItem
            v-for="mail in codeMails"
            :key="mail.id"
            :mail="mail"
            :just-copied="justCopied.has(mail.id)"
            :focused="focusedId === mail.id"
            minimal
            @copy="onCopy"
            @confirm="onConfirm"
            @trash="onTrash"
            @open="onOpen"
          />
        </template>
      </div>

      <footer class="foot">
        <a-button block @click="openOptions">
          <span class="i-pixelarticons-settings-2" aria-hidden="true" />
          {{ t('popup.openOptions') }}
        </a-button>
      </footer>
    </template>

    <!-- ============ 自定义模式：动态筛选 ============ -->
    <template v-else>
      <header class="head">
        <span class="brand">{{ t('app.name') }}</span>
        <a-tag class="mode-tag" :bordered="false">
          {{ t('app.customSuffix') }}
        </a-tag>
      </header>

      <!--
        ⚠ 分区的**列表放在 tab 面板里**（而不是像手写 tab 那样把列表挂在外面）：
          antd 的 Tabs 自己管面板的切换与保留。代价是要把「面板高度」一路撑到
          列表上（下面的 `:deep` 那几行），否则 480px 的弹窗里列表不会滚动
          —— 见 `.tabs` 的样式说明。

        Feature 08：tab 由「状态 + 启用的适配器」动态生成，不再硬编码四个。
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
            <!-- 失败态排在空态前面 —— 理由见极简模式那段 -->
            <EmptyState
              v-else-if="loadFailed"
              :text="t('mail.loadFailed')"
              :hint="t('mail.loadFailedHint')"
              :action-text="t('common.retry')"
              @action="reload"
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
                @copy="onCopy"
                @confirm="onConfirm"
                @read="onRead"
                @dismiss="onDismiss"
                @trash="onTrash"
                @open="onOpen"
              />
            </template>
          </div>
        </a-tab-pane>
      </a-tabs>

      <footer class="foot">
        <a-button block @click="openOptions">
          <span class="i-pixelarticons-settings-2" aria-hidden="true" />
          {{ t('popup.openOptions') }}
        </a-button>
      </footer>
    </template>

    <!-- 删除确认（两种模式共用）—— 变量必须来自 `useTrashConfirm` 的**解构**，见脚本里的说明 -->
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
/*
 * 固定 360 × 480（`ui-flows.md § 1.1`）。
 * 高度用 `height` 而不是 `max-height`：弹窗尺寸在打开时定下来，内容多少不影响窗口
 * —— 用 max-height 的话，邮件从 0 条涨到 10 条时弹窗会长高，而浏览器会把它定位到
 * 屏幕外面去。
 */
.popup {
  display: flex;
  flex-direction: column;
  width: 360px;
  height: 480px;
  overflow: hidden;
}

.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
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

/* 刷新按钮贴最右：header 不整体 space-between，否则品牌和标签也会被拉开 */
.refresh-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  padding: 0;
  line-height: 1;
  color: var(--mp-text-faint);
}

.refresh-btn:hover {
  color: var(--mp-text);
}

.refresh-btn > .refresh-icon {
  display: block;
  width: 16px;
  height: 16px;
  /*
   * ⚠ 必须归零。`styles/shared.css` 给所有 `.ant-btn > [class^='i-']` 加了
   *   6px 的 `margin-inline-end`（为了图标 + 文字的按钮），只有图标的按钮要自己
   *   清掉 —— 否则 16px 图标 + 6px 右边距会在 24px 按钮里被推到偏左。
   */
  margin-inline-end: 0;
}

.refresh-icon.spinning {
  animation: mp-refresh-spin 0.9s linear infinite;
}

@keyframes mp-refresh-spin {
  to {
    transform: rotate(-360deg);
  }
}

.cta {
  flex: 0 0 auto;
  margin: 0 12px 8px;
  padding: 6px 8px;
}

/* Alert 的 message 里塞了「文案 + 按钮」一行：antd 的 Alert 没有 action 插槽，
   所以自己排一下 */
.cta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cta :deep(.ant-alert-message) {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
}

.cta :deep(.ant-alert-icon) {
  margin-inline-end: 6px;
}

.section-label {
  flex: 0 0 auto;
  margin: 4px 12px 6px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

/*
 * tab 条与面板：整块占满中间的高度。
 *
 * ⚠ 这几行 `:deep` 是**必需**的，不是修饰 —— antd 的 Tabs 默认高度是内容撑开的，
 *   而列表必须在**固定 480px** 的窗口里滚动。链条是：
 *
 *     .tabs（flex 1，min-height 0）        ← 占满 head / foot 之间
 *       └ .ant-tabs-content-holder（同样 flex 1 + min-height 0）
 *           └ .ant-tabs-content / .ant-tabs-tabpane（100% 高）
 *               └ .list（自己的 overflow-y: auto）
 *
 *   任何一环缺了 `min-height: 0`，flex 子项的默认 `min-height: auto`
 *   都会让它「至少有内容那么高」⇒ 列表**撑开容器**而不是滚动，
 *   表现为「弹窗内容被推到看不见的地方，滚也滚不动」。
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
  padding: 0 8px;
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

/* 计数角标：默认那个 20px 的胶囊比 tab 文字还高，压到 16px 才像「附属信息」 */
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
  /*
   * ⚠ `min-height: 0` —— **不能删**，它与 `overflow-y: auto` 是一对。
   *
   *   flex 子项的 `min-height` 默认是 `auto`，含义是「至少要有内容那么高」。
   *   于是当内容超出容器时，子项**撑开**而不是滚动 —— `overflow-y: auto`
   *   看起来完全没生效（列表被推到弹窗外面、什么都滚不动）。
   *
   *   症状与「卡片被压扁」长得很像（都是「内容显示不全」），但成因相反：
   *     卡片被压扁 = 子项 `flex-shrink` 没关（见 `MailListItem` 的 `.mail-item`）
   *     滚动不生效 = 这一行没写
   *   两处都要对，列表才会「卡片保持原高 + 超出部分滚动」。
   */
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

.foot {
  flex: 0 0 auto;
  padding: 8px;
  border-top: 1px solid var(--mp-border);
}
</style>
