<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import { toastCaption } from '~/logic/notification/copy'
import { t } from '~/logic/strings'
import { isDegraded, mailSummaryLine } from '~/popup/list-filter'
import CodeCountdown from './CodeCountdown.vue'

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
  /** 移入回收站（用户看到的是「删除」） */
  trash: [mail: Mail]
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
      <!--
        时间与垃圾桶按钮**叠在同一个位置**：平时显示时间，鼠标移到这一小块上
        时时间淡出、垃圾桶淡入（见样式里的 `.time-slot`）。

        ⚠ 用「叠放 + 透明度」而不是 `v-if` 切换，是因为后者会让这个元素的宽度
          在悬停瞬间跳变 —— 头部是 flex 布局，宽度一变，左边的发件人名字就会
          被挤得抖一下。叠放则两者都始终参与布局，宽度恒定。

        ⚠ 垃圾桶按钮要 `@click.stop`：整张卡片绑了「打开邮件」，
          不拦住冒泡的话点删除会顺手把邮件打开（那是用户最不想要的结果）。
      -->
      <span class="time-slot">
        <time class="time">{{ relativeTime }}</time>
        <button
          class="trash"
          type="button"
          :title="t('mail.trash')"
          :aria-label="t('mail.trash')"
          @click.stop="emit('trash', mail)"
        >
          <span class="i-pixelarticons-trash" aria-hidden="true" />
        </button>
      </span>
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

    <!--
      倒计时：**只在邮件里明确写了有效期**时出现，且必须在 card 的**最后一个**
      子元素上 —— 它靠负外边距贴到卡片底部（见 `CodeCountdown` 的样式说明），
      放在中间会把它上面的内容一起「拉」到底部。

      `mail.codeExpiresAt` 没值就不渲染（不要给默认时长）。
      ⚠ 两个字段必须**同时**存在：`codeValidForSeconds` 是进度条的分母，
        缺了它进度条只能瞎猜（就是「每次打开都从 100% 开始」那个 bug）。
        数据层保证它们同生同灭（见 `deriveCodeExpiry`），这里再兜一道。
    -->
    <CodeCountdown
      v-if="code && mail.codeExpiresAt && mail.codeValidForSeconds"
      :expires-at="mail.codeExpiresAt"
      :valid-for-seconds="mail.codeValidForSeconds"
    />
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
   *
   *   卡片被放在一个 `display: flex; flex-direction: column; overflow-y: auto`
   *   的列表里（`Popup.vue` / `Sidepanel.vue` 的 `.list`）。
   *   而 flex 子项的默认值是 `flex-shrink: 1` —— 于是**邮件一多，所有卡片会被
   *   按比例压扁**：容器高度固定（弹窗 `height: 480px`），子项总高超出时
   *   浏览器优先压缩子项，而不是让容器滚动。
   *
   *   症状很有迷惑性：邮件少的时候完全正常，一多就「内容显示不全」，
   *   看起来像文本被截断（其实是被压缩后 `overflow: hidden` 裁掉了）。
   *
   *   `0 0 auto` = 不放大、**不缩小**、高度用内容自己算 —— 这样超出部分
   *   才会交给容器的 `overflow-y: auto` 去滚动。
   */
  flex: 0 0 auto;
  /*
   * ⚠ `overflow: hidden` 是**必需**的，不是修饰。
   *
   *   倒计时进度条是矩形（`CodeCountdown` 用负外边距贴到卡片底部），
   *   而卡片有 `border-radius: 10px` —— 不加这行的话，进度条的直角会**盖住**
   *   卡片底部的圆角，看起来像「圆角被啃掉了」。
   *
   *   `overflow: hidden` 让所有子元素都被卡片的圆角裁剪，这也是给圆角容器
   *   放全宽子元素的**标准做法**（比给每个子元素单独加圆角更省、更不容易漏）。
   *
   *   这条本身不产生滚动问题：配合上面的 `flex: 0 0 auto`，卡片高度由内容决定、
   *   不会溢出，所以 `hidden` 不会裁掉任何东西。
   */
  overflow: hidden;
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

/*
 * 紧急度用 **border-top** 的一条 2px 色条表达，不再用 border-left。
 *
 * ⚠ 改掉左侧色条的直接原因：它与倒计时进度条**抢同一条视觉轴线** ——
 *   左边竖着一条绿线、下面横着一条进度条，两个装饰条同时出现显得很乱，
 *   而且左侧色条在极简模式（只有验证码）里几乎没有信息量：
 *   那一屏**全是**验证码邮件，每一张卡都绿，等于没标。
 *
 *   这里只保留 `flag-high`（真正的紧急度信号），并且换到顶部。
 *
 * 注意 `urgencyClass` 的逻辑是「有验证码 → `flag-code`，否则才看 urgency」，
 * 所以验证码邮件**不会**拿到这道红条 —— 两类标记不会同时出现。
 */
.mail-item.flag-high {
  border-top: 2px solid color-mix(in srgb, var(--mp-danger) 70%, transparent);
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

/*
 * 时间 / 垃圾桶的叠放容器。
 *
 * ⚠ `position: relative` + 固定尺寸是必需的：两个子元素都参与布局并占据
 *   同一个位置，容器宽度取二者较大者，所以**悬停时头部不会抖动**。
 */
.time-slot {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 14px;
  height: 16px;
}

.time {
  font-size: 11px;
  color: var(--mp-text-faint);
  transition: opacity 0.12s;
}

/*
 * 垃圾桶：绝对定位盖在时间上面，默认透明且不接收鼠标事件。
 *
 * ⚠ `pointer-events: none` 是关键 —— 否则它会在**看不见**的状态下
 *   吃掉落在这一小块上的点击，用户点「时间」附近会莫名其妙触发删除。
 *   悬停时才打开事件，那时它已经可见了。
 */
.trash {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--mp-text-faint);
  font-size: 13px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s, color 0.12s;
}

/* 悬停这一小块：时间淡出、垃圾桶淡入 */
.time-slot:hover .time {
  opacity: 0;
}

.time-slot:hover .trash {
  opacity: 1;
  pointer-events: auto;
}

/* 垃圾桶本身悬停：变红，明确「这是删除」 */
.trash:hover {
  color: var(--mp-danger);
}

/* 键盘可达性：Tab 到按钮时必须能看见它（`opacity: 0` 会让焦点框也看不见） */
.trash:focus-visible {
  opacity: 1;
  pointer-events: auto;
  outline: 1px solid var(--mp-accent, var(--mp-border-strong));
  outline-offset: 1px;
  border-radius: 3px;
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
