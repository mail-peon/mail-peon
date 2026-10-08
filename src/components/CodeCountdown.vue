<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { formatTimestamp } from '~/logic/notification/format-time'
import { t } from '~/logic/strings'

/**
 * 验证码有效期倒计时。
 *
 * 布局（`ui-flows.md` 的卡片规格）：
 *
 * ```
 *   5:00                        有效        ← 左：剩余时间；右：状态（绿）
 *   ████████████░░░░░░░░░░░░                 ← 进度条
 * ```
 * 失效后：
 * ```
 *                               失效        ← 左边留空；状态转灰
 *   ░░░░░░░░░░░░░░░░░░░░░░░░
 * ```
 *
 * ## 只在「明确知道有效期」时渲染
 *
 * 调用方用 `v-if="mail.codeExpiresAt"` 把关 —— 邮件没写有效期就没有这个字段，
 * 也就不展示。**不要在这里再给一个默认时长**：那会让用户以为还有时间。
 *
 * ## 每秒 tick 的实现取舍
 *
 * 用 `setInterval` 而不是 `requestAnimationFrame`：
 *   - 这里只要秒级精度，rAF 每帧（60fps）触发一次是 60 倍的浪费；
 *   - Popup 关掉时组件卸载，`onUnmounted` 清掉定时器 —— 而 rAF 在后台标签页里
 *     会被浏览器暂停，反而要额外处理「恢复时补算」。
 *
 * ⚠ 组件卸载必须清定时器：Popup 会被频繁开关，漏掉就是每个实例都留一个
 *   永久 tick（用户看不见，但电池看得见）。
 */

const props = defineProps<{
  /** 失效时刻（`Date.now()` 同一时间轴） */
  expiresAt: number
  /**
   * 有效期的**总秒数**（进度条的分母）。
   *
   * ⚠ 必需，不能从 `expiresAt` 反推：反推需要知道起点（入库时刻），
   *   而那个值没有单独存。用「挂载时的剩余量」当分母的话，
   *   **每次打开 Popup 进度条都会从 100% 重新往下走** ——
   *   它就不再是「剩余比例」，而只是「这次打开后过了多久」。
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
 *   而那时进度条还有一点点 —— 文字与图形不一致。`ceil` 让它显示 `0:01`，
 *   最后一秒走完两者同时归零。
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
 *
 *   用后者的话，进度条表达的是「这次打开 Popup 之后过了多久」——
 *   每次打开都从 100% 重新往下走，完全不是用户想看的「还剩多少」。
 *   （真机上就是这样被发现的。）
 *
 *   现在的值只由「现在」决定：同一个时刻打开多少次，进度条都在同一个位置。
 *
 * ⚠ 失效时**保留进度条本身**（宽度 0）而不是 `v-if` 掉它 —— 用户看到
 *   「条子走完了」比「条子消失了」更能理解发生了什么。
 */
const progress = computed(() => {
  const totalMs = props.validForSeconds * 1000
  if (totalMs <= 0)
    return 0
  return Math.min(1, Math.max(0, remainingMs.value / totalMs))
})

/**
 * 失效时左侧显示的**时间点**。
 *
 * 规则：当天的只给时分秒，非当天的给完整年月日时分秒 —— 详见 `formatTimestamp`
 * 的说明（含为什么不能用「相差 24 小时」来判断当天）。
 *
 * ⚠ 格式化函数放在独立模块里，**不能**写在这个 `<script setup>` 里：
 *   Vue 不允许 `<script setup>` 含 `export`（会编译失败），
 *   而那段日期逻辑需要单测覆盖。
 */
const expiredAtText = computed(() => formatTimestamp(props.expiresAt, now.value))

/**
 * 进度条状态：决定颜色。
 *
 * 剩余不足 20% 时转黄提醒 —— 用户这时该去用验证码了。
 */
const barState = computed(() => {
  if (expired.value)
    return 'expired'
  return progress.value <= 0.2 ? 'warning' : 'valid'
})
</script>

<template>
  <!--
    结构与样式（产品要求）：
      - 整条**贴在 card 最底部**（负外边距抵消 card 的内边距，见样式里的说明）
      - 文字在**条内部**，不是上方
      - 颜色**淡一些**（描边 + 半透明填充，不抢验证码本身的注意力）
  -->
  <div
    class="countdown"
    :class="barState"
    role="progressbar"
    :aria-valuenow="Math.round(progress * 100)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div class="fill" :style="{ width: `${progress * 100}%` }" />
    <div class="text">
      <!-- 失效时左侧换成**失效时间点**（灰色）；有效时是剩余时间 -->
      <span class="remaining">{{ expired ? expiredAtText : remainingText }}</span>
      <span class="status">{{ expired ? t('mail.codeExpired') : t('mail.codeValid') }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * ⚠ 这个组件被放在 card 的**最后一个子元素**，要「贴着卡片底部」。
 *   card（`.mail-item`）有 `padding: 10px 12px`，所以这里用负外边距抵消它 ——
 *   `margin: 0 -12px -10px`（左右下各抵消对应的 padding）。
 *
 *   不用 `position: absolute` 是因为 card 的高度由内容决定（不在卡片上写死高度）：
 *   绝对定位会让它脱离文档流，卡片底部就空出一块，反而对不齐。
 */
.countdown {
  position: relative;
  margin: 8px -12px -10px;
  height: 18px;
  overflow: hidden;
  border-top: 1px solid var(--mp-border);
  background: var(--mp-surface-2);
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

/* 文字层：浮在填充之上，两端对齐 */
.text {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 10px;
  font-size: 11px;
  line-height: 1;
}

.remaining {
  font-variant-numeric: tabular-nums;
}

.status {
  font-weight: 600;
}

/* 有效：淡绿 */
.countdown.valid .fill {
  background: color-mix(in srgb, var(--mp-success) 22%, transparent);
}
.countdown.valid .remaining,
.countdown.valid .status {
  color: var(--mp-success);
}

/* 快失效（剩余 ≤20%）：淡黄 */
.countdown.warning .fill {
  background: color-mix(in srgb, var(--mp-warn) 26%, transparent);
}
.countdown.warning .remaining,
.countdown.warning .status {
  color: var(--mp-warn);
}

/* 失效：灰色，填充归零（只剩左侧时间点与右侧状态） */
.countdown.expired .fill {
  background: transparent;
}
.countdown.expired .remaining,
.countdown.expired .status {
  color: var(--mp-text-faint);
}
</style>
