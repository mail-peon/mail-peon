<script setup lang="ts">
import { t } from '~/logic/strings'

/**
 * 关于页 —— 纯说明，没有任何可操作的东西。
 *
 * 用 antd 的卡片 + 排版组件：`a-typography-paragraph` 自带次要文字的配色与行高，
 * 不用再手写 `.body` 那套。
 */
const MODES: Array<{ name: string, desc: string }> = [
  { name: '极简模式', desc: 'modeMinimalDesc' },
  { name: '完整模式', desc: 'modeFullDesc' },
]
</script>

<template>
  <section class="page">
    <a-card size="small" :title="t('about.title')">
      <a-typography-paragraph class="body">
        {{ t('about.intro') }}
      </a-typography-paragraph>
    </a-card>

    <a-card size="small" :title="t('about.modeTitle')">
      <a-typography-paragraph
        v-for="mode in MODES"
        :key="mode.name"
        class="body"
      >
        <a-typography-text strong>
          {{ mode.name }}
        </a-typography-text>
        ：{{ t(`about.${mode.desc}`) }}
      </a-typography-paragraph>
    </a-card>

    <a-card size="small" :title="t('about.storageTitle')">
      <a-typography-paragraph class="body">
        {{ t('about.storageDesc') }}
      </a-typography-paragraph>
    </a-card>

    <a-card size="small" :title="t('about.aiTitle')">
      <a-typography-paragraph class="body">
        {{ t('about.aiDesc') }}
      </a-typography-paragraph>
    </a-card>

    <a-card size="small" :title="t('about.shortcutsTitle')">
      <a-typography-paragraph class="body">
        {{ t('about.shortcutsDesc') }}
      </a-typography-paragraph>
    </a-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

/* 段落的默认下边距在卡片里显得多余（卡片自己已经把它们分开了） */
.body {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--mp-text-dim);
}

.body + .body {
  margin-top: 8px;
}
</style>
