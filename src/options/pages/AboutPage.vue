<script setup lang="ts">
import { t } from '~/logic/strings'

/**
 * 关于页 —— 纯说明，没有任何可操作的东西。
 *
 * 用 antd 的卡片 + 排版组件：`a-typography-paragraph` 自带次要文字的配色与行高，
 * 不用再手写 `.body` 那套。
 *
 * 「配套桌面端（peon-hall）」卡片只放**一行字 + 一个文字链接**：
 *   「需要装 peon-hall：扩展不能直接连 IMAP」 + 「下载 peon-hall」
 *   — 别的不安全过、不堆按钮、不画 alert。安全细节在 IMAP 配账号时再看。
 */
const MODES: Array<{ name: string, desc: string }> = [
  { name: t('about.modeMinimal'), desc: 'modeMinimalDesc' },
  { name: t('about.modeFull'), desc: 'modeFullDesc' },
]

/**
 * peon-hall 的「下载页」用 GitHub Releases latest：每次都进当次最新版（不会停在老版本）。
 *
 * ⚠ 这里**不**做「先查最新版版本号再拼 URL」——latest 已经会 302 到具体 tag，
 *    一次跳转够；多查一次少维护多一条 URL。
 */
const PEON_HALL_DOWNLOAD_URL = 'https://github.com/mail-peon/peon-hall/releases/latest'
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

    <!--
      peon-hall 下载入口：极简到只剩一句话 + 一个文字链接。
      不要 alert / 不要 button —— 这张卡片的目的是「告诉用户去哪拿中继」，
      而不是「抢用户的注意力」。安全细节在 IMAP 配账号的 availabilityNote 里。
    -->
    <a-card size="small" :title="t('about.peonHallTitle')">
      <p class="peon-hall-line">
        {{ t('about.peonHallWhyNeeded') }}
        <a
          class="peon-hall-link"
          :href="PEON_HALL_DOWNLOAD_URL"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('about.peonHallDownload') }}
        </a>
      </p>
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

/* peon-hall 那行：一句话 + 文字链，链接默认带下划线（HTML 标准 <a> 行为） */
.peon-hall-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--mp-text-dim);
}

.peon-hall-link {
  margin-left: 4px;
  /* a-tag 默认有下划线，这里显式写一遍以防 antd 全局样式压掉 */
  text-decoration: underline;
}
</style>
