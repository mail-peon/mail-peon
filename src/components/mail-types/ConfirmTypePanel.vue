<script setup lang="ts">
import type { ConfirmMatch } from '~/logic/types'
import { t } from '~/logic/strings'

/**
 * 确认邮件面板（内置 `builtin:confirm` 的专属 UI）。
 *
 * 产品要求：**只保留一个按钮**。显示目标域名，点击由调用方打开新标签；
 * 不在这里直接 `window.open` —— 打开动作要经过 Popup 的统一校验并标已读。
 */
defineProps<{
  match: ConfirmMatch
}>()

const emit = defineEmits<{
  confirm: []
}>()
</script>

<template>
  <div class="confirm">
    <p class="hint">
      {{ match.label || t('mail.confirmHint') }}
    </p>

    <div class="action">
      <a-button
        type="primary"
        size="small"
        class="open"
        :aria-label="`${t('mail.openConfirm')}：${match.host}`"
        @click.stop="emit('confirm')"
      >
        {{ t('mail.openConfirm') }}
      </a-button>
      <span class="host" :title="match.host">{{ match.host }}</span>
    </div>
  </div>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--mp-text-dim);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.action {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.open {
  flex: 0 0 auto;
}

/* 域名是「我要去哪」的关键信息；灰一点但不隐藏 */
.host {
  min-width: 0;
  font-family: var(--mp-font-mono);
  font-size: 10px;
  color: var(--mp-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
