<script setup lang="ts">
import type { CustomMatch } from '~/logic/types'

/**
 * 自定义类型面板：没有专属 UI，只有 AI 基于用户提示词产出的一段文本。
 *
 * 文本可能很长，这里最多显示 4 行；完整内容在 `title` 里，用户悬停可看。
 */
defineProps<{
  match: CustomMatch
}>()
</script>

<template>
  <p class="text" :title="match.text">
    {{ match.text }}
  </p>
</template>

<style scoped>
.text {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--mp-text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}
</style>
