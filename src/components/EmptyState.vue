<script setup lang="ts">
/**
 * 空白状态（antd 的 `Empty` 加一个可选的行动按钮）。
 *
 * 单独一个组件是因为「空列表」在五个地方出现（四个 tab + 极简模式的验证码列表），
 * 而每处的实现如果各写一遍，用户会看到五种不同的空白样式 —— 这在感受上
 * 像是五个不同的功能。
 *
 * ⚠ 图标用 antd 自带的那张（`Empty` 的默认插画），不引 `@ant-design/icons-vue`：
 *   我们已经有 UnoCSS 的图标集（`i-pixelarticons-*`），为了一个空态再装一套图标包
 *   不划算。`Empty` 的默认图是内联 SVG，跟着主色走、深浅色都对。
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
    <a-empty :description="text" />
    <a-button v-if="actionText" size="small" @click="emit('action')">
      {{ actionText }}
    </a-button>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* 弹窗里这块要占满剩余高度，空态才不会缩在顶部一小条里 */
  padding: 8px 12px;
}

/*
 * ⚠ `Empty` 的插画在 360px 宽的弹窗里会显得很大（默认 60px 高）。
 *   `shared.css` 里已把 `.ant-empty-image` 收到 32px，这里再压一下说明文字的字号
 *   —— 空态是「一句解释」，不该比列表里的标题还显眼。
 */
.empty :deep(.ant-empty-description) {
  font-size: 12px;
  color: var(--mp-text-faint);
}
</style>
