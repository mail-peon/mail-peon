<script setup lang="ts">
import type { Mail, PopupTab } from '~/logic/types'
import { computed, ref, watch } from 'vue'
import EmptyState from '~/components/EmptyState.vue'
import MailListItem from '~/components/MailListItem.vue'
import { useMails, useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'
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
 */
const { mails, loading, copyCode, setRead, dismiss, trash, markAllRead } = useMails(200)
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
 * 把邮件移入回收站（卡片右上角的垃圾桶）。
 *
 * ⚠ 这里**不加二次确认**。理由：
 *   - 这个操作**可撤销** —— 邮件在「设置 · 回收站」里能一键恢复；
 *   - 加确认会让「清理验证码」这个高频动作变成两次点击。用户删验证码
 *     通常是「用完了，清掉」，而不是「我要销毁证据」。
 *
 *   真正需要确认的是**彻底删除**（在回收站页里），那一个确实不可撤销。
 */
function onTrash(mail: Mail) {
  void trash(mail)
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
        <span class="mode">{{ t('app.minimalSuffix') }}</span>
      </header>

      <div v-if="!hasAiKey" class="cta">
        <span>⚠️ {{ t('general.aiKeyMissing') }}</span>
        <button class="mp-btn" type="button" @click="openOptions">
          {{ t('general.aiKeyMissingAction') }}
        </button>
      </div>

      <p class="section-label">
        {{ t('popup.codeHistory') }}
      </p>

      <div class="list">
        <p v-if="loading" class="loading">
          {{ t('common.loading') }}
        </p>
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
            minimal
            @copy="onCopy"
            @trash="onTrash"
            @open="onOpen"
          />
        </template>
      </div>

      <footer class="foot">
        <button class="mp-btn" type="button" @click="openOptions">
          {{ t('popup.openOptions') }}
        </button>
      </footer>
    </template>

    <!-- ============ 完整模式：四个分区 ============ -->
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
        <!-- `v-if` 放在外层 `<template>` 上 —— 理由见上面极简模式那段 -->
        <template v-if="visibleMails.length">
          <MailListItem
            v-for="mail in visibleMails"
            :key="mail.id"
            :mail="mail"
            @copy="onCopy"
            @read="onRead"
            @dismiss="onDismiss"
            @trash="onTrash"
            @open="onOpen"
          />
        </template>
      </div>

      <footer class="foot">
        <button class="mp-btn" type="button" @click="openOptions">
          {{ t('popup.openOptions') }}
        </button>
      </footer>
    </template>
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
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 12px 6px;
}

.brand {
  font-size: 13px;
  font-weight: 600;
}

.mode {
  font-size: 11px;
  color: var(--mp-text-faint);
}

.cta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--mp-warn) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--mp-warn) 10%, transparent);
  font-size: 11px;
  line-height: 1.5;
}

.section-label {
  margin: 4px 12px 6px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 8px 8px 0;
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
  margin: 0;
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--mp-text-faint);
}

.foot {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  padding: 8px;
  border-top: 1px solid var(--mp-border);
}
</style>
