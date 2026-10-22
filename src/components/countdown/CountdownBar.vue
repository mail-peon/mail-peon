<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { formatTimestamp } from '~/logic/notification/format-time'
import { t } from '~/logic/strings'

/**
 * 单行倒计时进度条（从原 `CodeCountdown` 抽出来，供验证码 / 确认链接共用）。
 *
 * 布局：
 *
 * ```
 *   验证码  5:00                        有效
 *   ████████████░░░░░░░░░░░░
 * ```
 *
 * ## 只在「明确知道有效期」时渲染
 *
 * 调用方用 `v-if` 把关 —— 邮件没写有效期就没有 `expiry`，也就不展示。
 * **不要在这里再给一个默认时长**：那会让用户以为还有时间。
 *
 * ## 每秒 tick 的实现取舍
 *
 * 用 `setInterval` 而不是 `requestAnimationFrame`：
 *   - 这里只要秒级精度，rAF 每帧触发是 60 倍的浪费；
 *   - Popup 关掉时组件卸载，`onUnmounted` 清掉定时器。
 */

const props = defineProps<{
  /** 左侧标签（验证码 / 确认链接）；不传就是旧版的样子 */
  label?: string
  /** 失效时刻（`Date.now()` 同一时间轴） */
  expiresAt: number
  /**
   * 有效期的**总秒数**（进度条的分母）。
   *
   * ⚠ 必需，不能从 `expiresAt` 反推：反推需要知道起点，而那个值没有单独存。
   *   用「挂载时的剩余量」当分母的话，**每次打开 Popup 进度条都会从 100% 重新走**。
   */
  validForSeconds: number
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})

/** 剩余毫秒（下限 0；不用负数，免得下游还要处理） */
const remainingMs = computed(() => Math.max(0, props.expiresAt - now.value))

const expired = computed(() => remainingMs.value <= 0)

/**
 * 剩余时间文本：`M:SS`，超过一小时给 `H:MM:SS`。
 *
 * ⚠ 用 `ceil` 而不是 `floor`：剩 0.4 秒时 `floor` 会显示 `0:00`，
 *   而那时进度条还有一点点 —— 文字与图形不一致。
 */
const remainingText = computed(() => {
  if (expired.value)
    return ''

  const totalSeconds = Math.ceil(remainingMs.value / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
})

/**
 * 进度：**剩余占总有效期的比例**（0–1）。
 *
 * ⚠ 分母是 `validForSeconds`（真实总时长），不是「挂载时的剩余量」。
 *   失效时**保留进度条本身**（宽度 0）而不是 `v-if` 掉它 ——
 *   用户看到「条子走完了」比「条子消失了」更能理解发生了什么。
 */
const progress = computed(() => {
  const totalMs = props.validForSeconds * 1000
  if (totalMs <= 0)
    return 0
  return Math.min(1, Math.max(0, remainingMs.value / totalMs))
})

/** 失效时左侧显示的时间点 */
const expiredAtText = computed(() => formatTimestamp(props.expiresAt, now.value))

/** 剩余不足 20% 转黄提醒 */
const barState = computed(() => {
  if (expired.value)
    return 'expired'
  return progress.value <= 0.2 ? 'warning' : 'valid'
})
</script>

<template>
  <div
    class="bar"
    :class="barState"
    role="progressbar"
    :aria-valuenow="Math.round(progress * 100)"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="label || t('mail.codeValid')"
    :aria-valuetext="expired ? expiredAtText : remainingText"
  >
    <div class="fill" :style="{ width: `${progress * 100}%` }" />
    <div class="text">
      <span v-if="label" class="label">{{ label }}</span>
      <span class="remaining">{{ expired ? expiredAtText : remainingText }}</span>
      <span class="status">{{ expired ? t('mail.codeExpired') : t('mail.codeValid') }}</span>
    </div>
  </div>
</template>

<style scoped>
.bar {
  position: relative;
  height: 18px;
  overflow: hidden;
}

/* 进度填充：半透明，压在文字下层 */
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  /*
   * `linear` 而不是加过渡动画：进度每秒才更新一次，过渡时长超过 1 秒
   * 会让它永远在追赶目标值（表现为条子一直缓慢移动、看不出真实比例）。
   */
  transition: width 0.3s linear;
}

/* 文字层：浮在填充之上 */
.text {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding: 0 10px;
  font-size: 11px;
  line-height: 1;
}

/* 标签占固定的一小段；验证码 / 确认同时出现时两行左边对齐 */
.label {
  flex: 0 0 auto;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}

.remaining {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.status {
  flex: 0 0 auto;
  font-weight: 600;
}

/* 有效：淡绿 */
.bar.valid .fill {
  background: color-mix(in srgb, var(--mp-success) 22%, transparent);
}
.bar.valid .remaining,
.bar.valid .status {
  color: var(--mp-success);
}

/* 快失效（剩余 ≤20%）：淡黄 */
.bar.warning .fill {
  background: color-mix(in srgb, var(--mp-warn) 26%, transparent);
}
.bar.warning .remaining,
.bar.warning .status {
  color: var(--mp-warn);
}

/* 失效：灰色，填充归零（只剩左侧时间点与右侧状态） */
.bar.expired .fill {
  background: transparent;
}
.bar.expired .remaining,
.bar.expired .status {
  color: var(--mp-text-faint);
}
</style>
