<script setup lang="ts">
/**
 * 空白状态。
 *
 * 单独一个组件是因为「空列表」在五个地方出现（四个 tab + 极简模式的验证码列表），
 * 而每处的实现如果各写一遍，用户会看到五种不同的空白样式 —— 这在感受上
 * 像是五个不同的功能。
 */
withDefaults(defineProps<{
  text: string
  /** 可选的行动按钮 */
  actionText?: string
}>(), {
  actionText: '',
})

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="empty">
    <p class="text">
      {{ text }}
    </p>
    <button
      v-if="actionText"
      class="action"
      type="button"
      @click="emit('action')"
    >
      {{ actionText }}
    </button>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px 16px;
  text-align: center;
}

.text {
  margin: 0;
  font-size: 12px;
  color: var(--mp-text-faint);
}

.action {
  appearance: none;
  border: 1px solid var(--mp-border-strong);
  background: transparent;
  color: var(--mp-text);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.action:hover {
  background: var(--mp-hover);
}
</style>
