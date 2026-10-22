<script setup lang="ts">
import type { ConfirmMatch, Mail, MailTypeMatch } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import { toastCaption } from '~/logic/notification/copy'
import { t } from '~/logic/strings'
import { codeMatchOf, hasMailState, MailStateFlag, matchesOfKind, summaryMatchOf } from '~/logic/types'
import { isDegraded, mailSummaryLine } from '~/popup/list-filter'
import CountdownStrip from './countdown/CountdownStrip.vue'
import MailTypeSections from './mail-types/MailTypeSections.vue'

/**
 * 一封邮件的卡片（Popup / Sidepanel 共用）。
 *
 * Feature 08 起，卡片主体由「类型面板」组成：
 *   - 验证码 / 确认 / 自定义各是一个面板，命中几个显示几个；
 *   - 总结不是面板：它是列表第二行 + 展开区；
 *   - 倒计时统一放卡片底部（`CountdownStrip`），多类同时失效时叠行。
 *
 * 广告弱化 / 紧急色条继续由 `Mail.stateFlags` 驱动（不再是 `ai.isAd` / `ai.urgency`）。
 */
const props = defineProps<{
  mail: Mail
  /** 极简模式：只显示类型面板，不显示总结 */
  minimal?: boolean
  /**
   * 这封邮件刚刚被复制过（**纯前端瞬时状态**，不落库）。
   *
   * ⚠ 刻意**不**读 `mail.copyStatus`：那个字段是持久语义（自动复制流水线处理过），
   *   而「刚点了一下复制」是转瞬即逝的界面反馈 —— 共用同一个字段会被 `reload()`
   *   覆盖回来，永远清不掉。
   */
  justCopied?: boolean
  /** 从 toast 定位过来时短暂描边 */
  focused?: boolean
}>()

const emit = defineEmits<{
  copy: [mail: Mail]
  read: [mail: Mail, read: boolean]
  dismiss: [mail: Mail]
  open: [mail: Mail]
  /** 移入回收站（用户看到的是「删除」） */
  trash: [mail: Mail]
  /** 打开确认链接（由 Popup / Sidepanel 负责真正 tabs.create + 标已读） */
  confirm: [mail: Mail, match: ConfirmMatch]
}>()

const expanded = ref(false)

/**
 * 鼠标是否在卡片里。
 *
 * ⚠ 用 `mouseenter` / `mouseleave` 而不是 CSS `:hover`：CSS `:hover` 在元素内部
 *   DOM 变动后不会重新求值，会让垃圾桶的显隐跟着复制按钮的行为乱走。
 */
const cardHovered = ref(false)
const trashZoneHovered = ref(false)
const trashZoneVisible = computed(() => cardHovered.value || trashZoneHovered.value)

function onCardEnter() {
  cardHovered.value = true
}

function onCardLeave() {
  cardHovered.value = false
  // 指针离开卡片时热区的 mouseleave 可能因 DOM 变动没派发，这里兜一下
  trashZoneHovered.value = false
}

const sender = computed(() => formatSender(props.mail.from))
const senderTitle = computed(() => toastCaption(props.mail.from))
const subject = computed(() => props.mail.subject.trim() || t('common.noSubject'))

const codeMatch = computed(() => codeMatchOf(props.mail))
const confirmMatches = computed(() => matchesOfKind(props.mail, 'confirm'))
const summary = computed(() => summaryMatchOf(props.mail))
const hasSummary = computed(() => !!summary.value?.text)

/**
 * 要渲染成「面板」的类型。
 *
 * ⚠ 兼容老数据：`mail.ai.types` 不存在时，`codeMatchOf` 会从 `mail.code` 合成一个。
 *   不这么做的话，升级后所有历史验证码邮件会突然失去复制按钮。
 */
const panelTypes = computed<MailTypeMatch[]>(() => {
  const list = [...(props.mail.ai?.types ?? [])]
  const code = codeMatch.value
  if (code && !list.some(match => match.kind === 'code'))
    list.unshift(code)
  return list.filter(match => match.kind !== 'summary')
})

/** 底部倒计时：验证码 + 每个确认链接各自一条 */
const countdownItems = computed(() => {
  const items: Array<{ key: string, label: string, expiresAt: number, validForSeconds: number }> = []

  const code = codeMatch.value
  if (code?.expiry) {
    items.push({
      key: code.adapterId,
      label: code.adapterName || t('mail.code'),
      expiresAt: code.expiry.at,
      validForSeconds: code.expiry.totalSeconds,
    })
  }

  for (const match of confirmMatches.value) {
    if (!match.expiry)
      continue
    items.push({
      key: match.adapterId,
      label: match.adapterName || t('mail.confirm'),
      expiresAt: match.expiry.at,
      validForSeconds: match.expiry.totalSeconds,
    })
  }

  return items
})

const degraded = computed(() => isDegraded(props.mail))
const pending = computed(() => props.mail.processing === 'pending' && !props.mail.ai)
const isAd = computed(() => hasMailState(props.mail.stateFlags, MailStateFlag.Ad))

/** 相对时间（「5 分钟前」）。不引 dayjs：只有一个函数需要，多一个依赖不划算 */
const relativeTime = computed(() => formatRelative(props.mail.receivedAt))

/** `<time datetime>` 要的是 ISO 8601；取不到时间就不加这个属性 */
const timeDateTime = computed(() =>
  Number.isFinite(props.mail.receivedAt) ? new Date(props.mail.receivedAt).toISOString() : undefined,
)

/**
 * 卡片的可访问名称。
 *
 * ⚠ 卡片里可能有发件人、主题、验证码、摘要、按钮…… 不给明确的 `aria-label`，
 *   读屏会把整棵子树的文本拼成一段几十个字的按钮名。
 */
const openLabel = computed(() =>
  `${props.mail.from?.[0]?.name || t('common.unknownSender')}：${props.mail.subject || t('common.noSubject')}`,
)

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000)
    return t('common.justNow')
  if (diff < 3_600_000)
    return t('common.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000)
    return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000)
    return t('common.daysAgo', { n: Math.floor(diff / 86_400_000) })
  // 超过一周就直接给日期：`12 天前` 不如 `3月14日` 有用
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const urgencyClass = computed(() => {
  // 验证码邮件不拿紧急色条：那一屏全是验证码，每条都标等于没标
  if (codeMatch.value)
    return ''
  if (hasMailState(props.mail.stateFlags, MailStateFlag.Urgent))
    return 'flag-high'
  return ''
})
</script>

<template>
  <article
    class="mail-item"
    :class="[{ 'is-ad': isAd, 'is-read': mail.read, 'is-focused': focused }, urgencyClass]"
    :data-mail-id="mail.id"
    role="button"
    tabindex="0"
    :aria-label="openLabel"
    @click="emit('open', mail)"
    @keydown.enter.prevent="emit('open', mail)"
    @keydown.space.prevent="emit('open', mail)"
    @mouseenter="onCardEnter"
    @mouseleave="onCardLeave"
  >
    <header class="head">
      <span class="sender" :title="senderTitle">{{ sender }}</span>
      <!-- 时间与垃圾桶互斥：垃圾桶出现时时间让位（两者在视觉上占同一个位置） -->
      <span class="time-slot" :class="{ 'is-hidden': trashZoneVisible }">
        <time class="time" :datetime="timeDateTime">{{ relativeTime }}</time>
      </span>

      <!-- 删除热区：显示由 cardHovered || trashZoneHovered 驱动，不依赖 CSS :hover -->
      <span
        class="trash-zone"
        :class="{ 'is-visible': trashZoneVisible }"
        @mouseenter="trashZoneHovered = true"
        @mouseleave="trashZoneHovered = false"
      >
        <a-button
          class="trash"
          type="text"
          size="small"
          :title="t('mail.trash')"
          :aria-label="t('mail.trash')"
          @click.stop="emit('trash', mail)"
        >
          <span class="i-pixelarticons-trash" aria-hidden="true" />
        </a-button>
      </span>
    </header>

    <p class="subject">
      {{ subject }}
    </p>

    <!-- 类型面板：验证码 / 确认 / 自定义，命中几个显示几个 -->
    <MailTypeSections
      v-if="panelTypes.length"
      :types="panelTypes"
      :just-copied="justCopied"
      @copy="emit('copy', mail)"
      @confirm="(match: ConfirmMatch) => emit('confirm', mail, match)"
    />

    <!-- 没有「现在要做什么」的面板时，才显示总结行 -->
    <template v-else-if="!minimal">
      <p v-if="pending" class="summary pending">
        {{ t('mail.pending') }}
      </p>
      <p v-else class="summary">
        {{ mailSummaryLine(mail) }}
      </p>
    </template>

    <p v-if="degraded" class="degraded" :title="mail.ai?.error ?? t('mail.degradedTip')">
      <a-tag color="warning">
        {{ t('mail.degraded') }}
      </a-tag>
    </p>

    <!-- 展开态：总结全文 + 操作 -->
    <div v-if="expanded && !minimal" class="detail" @click.stop>
      <p class="detail-label">
        {{ t('mail.summary') }}
      </p>
      <pre class="detail-body">{{ summary?.text || t('mail.minimalCaptured') }}</pre>
      <div class="actions">
        <a-button size="small" @click="emit('read', mail, !mail.read)">
          {{ mail.read ? t('mail.markUnread') : t('mail.markRead') }}
        </a-button>
        <a-button size="small" @click="emit('dismiss', mail)">
          {{ t('mail.dismiss') }}
        </a-button>
      </div>
    </div>

    <a-button
      v-if="!minimal && hasSummary"
      class="expand"
      type="link"
      size="small"
      :aria-expanded="expanded"
      @click.stop="expanded = !expanded"
    >
      {{ expanded ? t('common.collapse') : t('common.expand') }}
    </a-button>

    <!--
      倒计时必须在 card 的**最后一个**子元素上：它靠负外边距贴到卡片底部。
      `CountdownStrip` 内部会处理多行（验证码 + 确认同时有有效期时）。
    -->
    <CountdownStrip :items="countdownItems" />
  </article>
</template>

<style scoped>
.mail-item {
  position: relative;
  padding: 10px 12px;
  border: 1px solid var(--mp-border);
  border-radius: 10px;
  background: var(--mp-surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  /*
   * ⚠ `flex: 0 0 auto` —— **不能删**。
   *   flex 子项默认 `flex-shrink: 1`，邮件一多所有卡片会被按比例压扁，
   *   看起来像文本被截断（其实是被压缩后 overflow: hidden 裁掉了）。
   */
  flex: 0 0 auto;
  /* `overflow: hidden` 让底部倒计时条被卡片的圆角裁剪 */
  overflow: hidden;
}

.mail-item:hover {
  border-color: var(--mp-border-strong);
  background: var(--mp-surface-2);
}

/* 广告：视觉弱化（features/04 § 5：透明度 0.6 / 灰边） */
.mail-item.is-ad {
  opacity: 0.6;
}

.mail-item.is-read .subject {
  font-weight: 500;
  color: var(--mp-text-dim);
}

/* 键盘可达性：article 不会自动画焦点圈 */
.mail-item:focus-visible {
  outline: 2px solid var(--mp-accent);
  outline-offset: 2px;
}

/* 「从 toast 定位过来」的那一条：短暂描边（outline 不占布局） */
.mail-item.is-focused {
  outline: 2px solid var(--mp-accent);
  outline-offset: 2px;
}

/*
 * 紧急度用 border-top 的 2px 色条（不再用 border-left：它会与倒计时抢视觉轴线）。
 * 有验证码的邮件不拿这道条（见 urgencyClass）。
 */
.mail-item.flag-high {
  border-top: 2px solid color-mix(in srgb, var(--mp-danger) 70%, transparent);
}

.head {
  display: flex;
  /* 发件人与时间都是文字，按基线对齐才齐 */
  align-items: baseline;
  gap: 8px;
}

.sender {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--mp-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time-slot {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  /* 覆盖父级的 baseline：固定高度的盒子按基线对齐会把整行基线往下推 */
  align-self: center;
  height: 14px;
}

.time {
  font-size: 11px;
  color: var(--mp-text-faint);
  transition: opacity 0.12s;
}

/*
 * 垃圾桶热区（卡片右上角那一小块）。
 *
 * ⚠ `top` / `right` 是按卡片的 `padding: 10px 12px` 反算出来的：
 *   目标是让垃圾桶与时间**右边缘重合**，切换时右边不跳。
 *   三个数（卡片 padding、热区尺寸、两个偏移）必须一起改。
 */
.trash-zone {
  position: absolute;
  top: 8px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  /*
   * ⚠ 始终 pointer-events: auto：隐藏的元素收不到 mouseenter，
   *   永远没法把自己点亮。可见时用户看得见自己在点删除。
   */
  opacity: 0;
  transition: opacity 0.12s;
}

/* 显示由状态类决定；`focus-within` 保证键盘用户能看到 */
.trash-zone.is-visible,
.mail-item:focus-within .trash-zone {
  opacity: 1;
}

.time-slot.is-hidden .time {
  opacity: 0;
}

/* 垃圾桶本体：填满热区 */
.trash {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mp-text-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s;
}

.trash [class^='i-'] {
  margin-inline-end: 0;
}

.trash:hover {
  color: var(--mp-danger);
  background: transparent;
}

.trash:focus,
.trash:focus-visible {
  outline: none;
}

.trash:focus-visible {
  color: var(--mp-danger);
}

.subject {
  margin: 3px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.summary {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--mp-text-dim);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.summary.pending {
  font-style: italic;
  color: var(--mp-text-faint);
}

.degraded {
  margin: 6px 0 0;
}

.degraded :deep(.ant-tag) {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
}

.detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--mp-border);
}

.detail-label {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.detail-body {
  margin: 0;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--mp-text);
  max-height: 220px;
  overflow: auto;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

/* 「展开 / 收起」是文字按钮：它是这段文字的延续 */
.expand {
  height: auto;
  margin-top: 4px;
  padding: 0;
  color: var(--mp-text-faint);
  font-size: 11px;
  line-height: inherit;
}

.expand:hover {
  color: var(--mp-text-dim);
  background: transparent;
}
</style>
