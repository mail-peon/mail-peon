<script setup lang="ts">
import { t } from '~/logic/strings'
</script>

<template>
  <section class="page">
    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('about.title') }}
      </p>
      <p class="body">
        {{ t('about.intro') }}
      </p>
    </div>

    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('about.modeTitle') }}
      </p>
      <ul class="list">
        <li><strong>极简模式</strong>：{{ t('about.modeMinimalDesc') }}</li>
        <li><strong>完整模式</strong>：{{ t('about.modeFullDesc') }}</li>
      </ul>
    </div>

    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('about.storageTitle') }}
      </p>
      <p class="body">
        {{ t('about.storageDesc') }}
      </p>
    </div>

    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('about.aiTitle') }}
      </p>
      <p class="body">
        {{ t('about.aiDesc') }}
      </p>
    </div>

    <div class="mp-card">
      <p class="mp-section-title">
        {{ t('about.shortcutsTitle') }}
      </p>
      <p class="body">
        {{ t('about.shortcutsDesc') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.body {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--mp-text-dim);
}

.list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--mp-text-dim);
}
</style>
