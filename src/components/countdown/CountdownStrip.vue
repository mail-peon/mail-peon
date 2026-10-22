<script setup lang="ts">
import CountdownBar from './CountdownBar.vue'

/**
 * 卡片底部的倒计时条容器。
 *
 * - 一个 item = 与旧版完全一样的一条；
 * - 多个 item（验证码 + 确认同时命中）→ 每类一行，样式一致，不抢主体注意力。
 *
 * ⚠ 整个容器用负外边距贴到 card 底部（card 的 `padding: 10px 12px`），
 *   所以这里 `margin: 8px -12px -10px`；单行时与旧的 `CodeCountdown` 视觉一致。
 */

export interface CountdownItem {
  key: string
  label: string
  expiresAt: number
  validForSeconds: number
}

defineProps<{
  items: CountdownItem[]
}>()
</script>

<template>
  <div v-if="items.length" class="strip">
    <div v-for="item in items" :key="item.key" class="row">
      <CountdownBar
        :label="item.label"
        :expires-at="item.expiresAt"
        :valid-for-seconds="item.validForSeconds"
      />
    </div>
  </div>
</template>

<style scoped>
.strip {
  position: relative;
  margin: 8px -12px -10px;
  overflow: hidden;
  border-top: 1px solid var(--mp-border);
  background: var(--mp-surface-2);
}

/* 多行之间用同一条分隔线，避免两条进度条糊在一起 */
.row + .row {
  border-top: 1px solid var(--mp-border);
}
</style>
