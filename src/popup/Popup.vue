<script setup lang="ts">
import type { Mail, PopupTab } from '~/logic/types'
import { computed, ref, watch } from 'vue'
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
} from './list-filter'

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
const { mails, loading, justCopied, copyCode, setRead, dismiss, trash, markAllRead } = useMails(200)
const { app, ai, reload: reloadSettings } = useSettings()

const activeTab = ref<PopupTab>('important')

/**
 * 默认 tab 由设置决定（`popupDefaultTab`）。
 *
 * ⚠ 只在**首次**加载时套用：用户手动切到「全部」之后，background 广播一封新邮件
 *   会触发重载，如果每次都重置成默认 tab，用户会看到「刚切过去又被弹回来」。
 */
const appliedDefault = ref(false)
watch(app, (value) => {
  if (value && !appliedDefault.value) {
    activeTab.value = value.popupDefaultTab
    appliedDefault.value = true
  }
}, { immediate: true })

const minimalMode = computed(() => app.value?.minimalMode ?? true)
const excludeAds = computed(() => app.value?.excludeAds ?? true)
const hasAiKey = computed(() => !!ai.value?.apiKey)

const counts = computed(() => countByTab(mails.value, { excludeAds: excludeAds.value }))

const visibleMails = computed(() =>
  sortMails(filterMails(mails.value, activeTab.value, { excludeAds: excludeAds.value })),
)

/** 极简模式：只挑含验证码的（`design/minimal-mode.md § 4.3`） */
const codeMails = computed(() => minimalModeMails(mails.value))

/**
 * 诊断输出：**Popup 实际收到了什么**。
 *
 * ⚠ 这几行是为了分清一类很具体的情况：background 那边一切正常
 *   （日志显示抓取 + 入库都成功），而 Popup 里是空的。两者之间的唯一环节是
 *   `useMails()` 的 `mail:list` 消息 —— 它可能因为 SW 休眠、消息超时、
 *   或过滤条件而返回空。
 *
 *   没有这几行的话，「background 有数据、Popup 没有」只能靠猜。
 *   带 `activeTab` 是因为极简模式只渲染 `codeMails`、完整模式只渲染
 *   当前 tab 的 `visibleMails` —— 分清「没数据」与「数据被过滤掉了」很重要。
 */
watch([mails, activeTab, minimalMode], () => {
  const detail = minimalMode.value
    ? `极简模式：含验证码 ${codeMails.value.length} 条`
    : `完整模式：tab「${activeTab.value}」${visibleMails.value.length} 条`
  console.warn(`[mail-peon] Popup 收到 ${mails.value.length} 条记录 → ${detail}`)
  if (mails.value.length && !minimalMode.value)
    console.warn(`[mail-peon] 各分区计数：${JSON.stringify(counts.value)}`)
}, { immediate: true })

function openOptions() {
  browser.runtime.openOptionsPage()
}

/**
 * 打开 Popup 即把 badge 归零。
 *
 * 设计文档 `ui-flows.md § 3.1`：「打开 Popup → 当前 tab 的 badge 归零」。
 * 极简模式没有 badge，但标已读本身仍然有意义（用户看过列表了）。
 */
async function onOpened() {
  await reloadSettings()
  await markAllRead()
}

void onOpened()

function onCopy(mail: Mail) {
  void copyCode(mail)
}

function onRead(mail: Mail, read: boolean) {
  void setRead(mail, read)
}

function onDismiss(mail: Mail) {
  void dismiss(mail)
}

/**
 * 删除确认（卡片右上角的垃圾桶）。
 *
 * ⚠ 要**确认一次**。虽然这个操作可撤销，但用户未必知道去哪儿恢复 ——
 *   确认弹窗正是把「可在『设置 · 回收站』里恢复」这句话说出来的地方。
 *   （只弹「确定吗」不说后果，等于白添一次点击。）
 *
 *   「标记已读」那种可逆且无后果的动作就不确认 —— 弹窗只会让人烦。
 *
 * ⚠⚠ 这里**必须解构**，不能写成 `const tc = useTrashConfirm(trash)` 然后用
 *     `tc.pending` / `tc.dialog` —— Vue 的模板自动解包**只对 setup 直接暴露的
 *     ref 生效**，不会递归进一个普通对象。那样写的话：
 *
 *       - `tc.pending` 拿到的是 **ref 对象本身**，而对象恒为真值
 *         ⇒ `:open` 永远为真 ⇒ **弹窗一打开就铺满整个界面**；
 *       - `tc.dialog` 同样是 ref 对象 ⇒ `.title` 是 `undefined`
 *         ⇒ 于是它看起来是个**没有内容的空弹窗**。
 *
 *     真机上就是这样被发现的（「popup 一打开就自带一个弹窗，没有内容」）。
 *     解构出来之后它们是 setup 的顶层绑定，Vue 才会自动解包。
 */
const {
  pending: trashPending,
  dialog: trashDialog,
  ask: askTrashConfirm,
  cancel: cancelTrashConfirm,
  confirm: confirmTrashConfirm,
} = useTrashConfirm(trash)

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
            minimal
            @copy="onCopy"
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

    <!-- ============ 完整模式：四个分区 ============ -->
    <template v-else>
      <header class="head">
        <span class="brand">{{ t('app.name') }}</span>
      </header>

      <!--
        ⚠ 分区的**列表放在 tab 面板里**（而不是像手写 tab 那样把列表挂在外面）：
          antd 的 Tabs 自己管面板的切换与保留。代价是要把「面板高度」一路撑到
          列表上（下面的 `:deep` 那几行），否则 480px 的弹窗里列表不会滚动
          —— 见 `.tabs` 的样式说明。
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
                @copy="onCopy"
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
      @confirm="confirmTrashConfirm"
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
