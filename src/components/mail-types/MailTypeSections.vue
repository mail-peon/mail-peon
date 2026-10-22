<script setup lang="ts">
import type { ConfirmMatch, CustomMatch, MailTypeMatch } from '~/logic/types'
import { computed } from 'vue'
import { t } from '~/logic/strings'
import CodeTypePanel from './CodeTypePanel.vue'
import ConfirmTypePanel from './ConfirmTypePanel.vue'
import CustomTypePanel from './CustomTypePanel.vue'

/**
 * 卡片里的「类型面板」列表。
 *
 * 三个面板共用同一套外框 / 标题 / 间距 —— 这是需求 4 里「两者同时有也毫无违和感」
 * 的落点：验证码 + 确认 + 自定义可以叠在同一张卡片里，但看起来仍是同一套设计语言。
 *
 * `summary` 不在这里渲染：它是列表第二行 + 展开区，不是「现在要做什么」的面板。
 */
const props = defineProps<{
  types: MailTypeMatch[]
  justCopied?: boolean
}>()

const emit = defineEmits<{
  copy: []
  confirm: [match: ConfirmMatch]
}>()

const panels = computed(() =>
  props.types.filter(match => match.kind !== 'summary'),
)

function titleOf(match: MailTypeMatch): string {
  if (match.kind === 'code')
    return match.adapterName || t('mail.code')
  if (match.kind === 'confirm')
    return match.adapterName || t('mail.confirm')
  return match.adapterName || t('mail.customType')
}
</script>

<template>
  <div v-if="panels.length" class="types">
    <section
      v-for="match in panels"
      :key="match.adapterId"
      class="panel"
      :class="`is-${match.kind}`"
    >
      <p class="title">
        {{ titleOf(match) }}
      </p>

      <CodeTypePanel
        v-if="match.kind === 'code'"
        :match="match"
        :just-copied="justCopied"
        @copy="emit('copy')"
      />
      <ConfirmTypePanel
        v-else-if="match.kind === 'confirm'"
        :match="match as ConfirmMatch"
        @confirm="emit('confirm', match as ConfirmMatch)"
      />
      <CustomTypePanel
        v-else
        :match="match as CustomMatch"
      />
    </section>
  </div>
</template>

<style scoped>
.types {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

/*
 * 统一样式：淡底 + 细边 + 8px 圆角。
 *
 * ⚠ 刻意不做卡片套卡片（大阴影 / 强边框）：卡片本身已经有边框和圆角，
 *   再套一层会显得很重，而且验证码 / 确认 / 自定义三种内容长度差很多。
 */
.panel {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--mp-border);
  border-radius: 8px;
  background: var(--mp-surface-2);
}

/*
 * 标题是「这是哪一类」而不是主体：10px、灰、不抢验证码 / 按钮的注意力。
 * 用 `uppercase` 不适合中文，所以只靠字号 / 颜色区分。
 */
.title {
  margin: 0 0 5px;
  font-size: 10px;
  line-height: 1.3;
  color: var(--mp-text-faint);
}

/* 验证码面板给一点左侧强调：它是三类里最需要一眼看到的 */
.panel.is-code {
  border-left: 2px solid color-mix(in srgb, var(--mp-accent) 55%, transparent);
}
</style>
