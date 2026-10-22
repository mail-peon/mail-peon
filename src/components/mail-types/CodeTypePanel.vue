<script setup lang="ts">
import type { CodeMatch } from '~/logic/types'
import { t } from '~/logic/strings'

/**
 * 验证码面板（内置 `builtin:code` 的专属 UI）。
 *
 * 只负责「验证码 + 复制」；外层的边框 / 标题由 `MailTypeSections` 统一负责，
 * 这样验证码 / 确认 / 自定义三个面板的视觉语言不会分叉。
 */
defineProps<{
  match: CodeMatch
  /** 刚点过复制（瞬时状态，不落库，见 `bridge.ts` 的 `justCopied`） */
  justCopied?: boolean
}>()

const emit = defineEmits<{
  copy: []
}>()
</script>

<template>
  <div class="code-row">
    <code class="code" :title="match.code">{{ match.code }}</code>

    <!--
      ⚠ 判据是 `justCopied`（前端瞬时状态），不是 `mail.copyStatus`。
        后者是持久字段，读完就写库、`reload()` 又会把它读回来，
        于是「√ 复制成功」永远变不回「复制」。
    -->
    <a-button
      v-if="!justCopied"
      class="copy"
      type="link"
      size="small"
      @click.stop="emit('copy')"
    >
      {{ t('mail.copy') }}
    </a-button>
    <span v-else class="copy-done">{{ t('mail.copyDone') }}</span>
  </div>
</template>

<style scoped>
.code-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.code {
  min-width: 0;
  font-family: var(--mp-font-mono);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--mp-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 「复制」是文字按钮：读起来是验证码那一行的延续，而不是一个需要去找的控件。
 * `height: auto` + `padding: 0` 把 antd 30px 的盒子压回纯文字高度。
 */
.copy {
  appearance: none;
  border: 0;
  background: transparent;
  height: auto;
  padding: 0;
  color: var(--mp-accent);
  font-family: inherit;
  font-size: 11px;
  line-height: inherit;
  cursor: pointer;
}

.copy:hover {
  text-decoration: underline;
  color: var(--mp-accent);
  background: transparent;
}

/* 与 `.copy` 同一套字号 / 行高，切换时这一行不跳 */
.copy-done {
  font-size: 11px;
  font-weight: 600;
  color: var(--mp-success);
}
</style>
