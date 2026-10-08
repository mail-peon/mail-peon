<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import { toastCaption } from '~/logic/notification/copy'
import { t } from '~/logic/strings'
import { isDegraded, mailSummaryLine } from '~/popup/list-filter'

const props = defineProps<{
  mail: Mail
  /** 极简模式：只显示验证码行，不显示摘要 */
  minimal?: boolean
}>()

const emit = defineEmits<{
  copy: [mail: Mail]
  read: [mail: Mail, read: boolean]
  dismiss: [mail: Mail]
  open: [mail: Mail]
}>()

const expanded = ref(false)

const sender = computed(() => formatSender(props.mail.from))
const senderTitle = computed(() => toastCaption(props.mail.from))
const subject = computed(() => props.mail.subject.trim() || t('common.noSubject'))
const code = computed(() => props.mail.code ?? props.mail.ai?.code ?? null)
const degraded = computed(() => isDegraded(props.mail.ai))
const pending = computed(() => props.mail.processing === 'pending' && !props.mail.ai)
const isAd = computed(() => props.mail.ai?.isAd === true)

/** 相对时间（「5 分钟前」）。不引 dayjs：只有一个函数需要，多一个依赖不划算 */
const relativeTime = computed(() => formatRelative(props.mail.receivedAt))

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
  if (code.value)
    return 'flag-code'
  if (props.mail.ai?.urgency === 'high')
    return 'flag-high'
  return ''
})
</script>

<template>
  <article
    class="mail-item"
    :class="[{ 'is-ad': isAd, 'is-read': mail.read }, urgencyClass]"
    @click="emit('open', mail)"
  >
    <header class="head">
      <span class="sender" :title="senderTitle">{{ sender }}</span>
      <time class="time">{{ relativeTime }}</time>
    </header>

    <p class="subject">
      {{ subject }}
    </p>

    <!-- 极简模式只需要验证码那一行 -->
    <div v-if="code" class="code-row">
      <span class="code-label">{{ t('mail.code') }}</span>
      <code class="code">{{ code }}</code>
      <button
        v-if="mail.copyStatus !== 'copied'"
        class="btn-mini"
        type="button"
        @click.stop="emit('copy', mail)"
      >
        {{ t('common.copy') }}
      </button>
      <span v-else class="copied">{{ t('common.copied') }}</span>
    </div>

    <template v-else-if="!minimal">
      <p v-if="pending" class="summary pending">
        {{ t('mail.pending') }}
      </p>
      <p v-else class="summary">
        {{ mailSummaryLine(mail) }}
      </p>
    </template>

    <p v-if="degraded" class="degraded" :title="mail.ai?.error ?? ''">
      ⚠️ {{ t('mail.degraded') }}
    </p>

    <!-- 展开态：摘要全文 + 操作 -->
    <div v-if="expanded && !minimal" class="detail" @click.stop>
      <p class="detail-label">
        {{ t('mail.summary') }}
      </p>
      <pre class="detail-body">{{ mail.ai?.summary || t('mail.minimalCaptured') }}</pre>
      <div class="actions">
        <button class="btn-mini" type="button" @click="emit('read', mail, !mail.read)">
          {{ mail.read ? t('mail.markUnread') : t('mail.markRead') }}
        </button>
        <button class="btn-mini" type="button" @click="emit('dismiss', mail)">
          {{ t('mail.dismiss') }}
        </button>
      </div>
    </div>

    <button
      v-if="!minimal && !code"
      class="expand"
      type="button"
      :aria-expanded="expanded"
      @click.stop="expanded = !expanded"
    >
      {{ expanded ? '收起' : '展开' }}
    </button>
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
}

.mail-item:hover {
  border-color: var(--mp-border-strong);
}

/* 广告：视觉弱化（features/04 § 5：透明度 0.6 / 灰边） */
.mail-item.is-ad {
  opacity: 0.6;
}

.mail-item.is-read .subject {
  font-weight: 500;
  color: var(--mp-text-dim);
}

/* 左侧 3px 色条表达紧急度 / 验证码 */
.mail-item.flag-code {
  border-left: 3px solid #10b981;
}

.mail-item.flag-high {
  border-left: 3px solid #ef4444;
}

.head {
  display: flex;
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

.time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--mp-text-faint);
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

.code-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.code-label {
  font-size: 12px;
  color: var(--mp-text-dim);
}

.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--mp-text);
}

.copied {
  font-size: 11px;
  color: #10b981;
}

.degraded {
  margin: 4px 0 0;
  font-size: 11px;
  color: #f59e0b;
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

.btn-mini {
  appearance: none;
  border: 1px solid var(--mp-border-strong);
  background: transparent;
  color: var(--mp-text);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.btn-mini:hover {
  background: var(--mp-hover);
}

.expand {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--mp-text-faint);
  font-size: 11px;
  padding: 4px 0 0;
  cursor: pointer;
  font-family: inherit;
}

.expand:hover {
  color: var(--mp-text-dim);
}
</style>
