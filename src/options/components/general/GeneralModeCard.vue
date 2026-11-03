<script setup lang="ts">
import { t } from '~/logic/strings'

defineProps<{ minimalMode: boolean }>()
const emit = defineEmits<{ toggle: [checked: boolean | string | number] }>()
</script>

<template>
  <a-card size="small" :title="t('general.mode')">
    <!--
        一行靠左：`极简模式 (开关) 自定义`。
        两个标签是**短标签**（括号里的解释在下面两行）——
        长标签挤在开关两边会把它推歪。
      -->
    <div class="mode-row">
      <span class="mode-label" :class="{ active: minimalMode }">
        {{ t('general.modeMinimal') }}
      </span>
      <a-switch
        class="mode-switch"
        :checked="!minimalMode"
        @update:checked="value => emit('toggle', value)"
      />
      <span class="mode-label" :class="{ active: !minimalMode }">
        {{ t('general.modeFull') }}
      </span>
    </div>

    <!-- 两个模式各一行说明（共两行），每行前面是自己的名字 -->
    <div class="mode-desc">
      <p>
        <span class="mode-desc-title">{{ t('general.modeMinimal') }}</span>：{{ t('general.modeMinimalDesc') }}
      </p>
      <p>
        <span class="mode-desc-title">{{ t('general.modeFull') }}</span>：{{ t('general.modeFullDesc') }}
      </p>
    </div>
  </a-card>
</template>

<style scoped>
/*
 * 模式切换：`极简模式 (开关) 自定义`，**靠左**一行。
 *
 * ⚠ 不用 `justify-content: center` 居中：这一行下面的两段说明是左对齐的，
 *   开关居中的话整张卡片会看起来「一半居中一半靠左」。
 */
.mode-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mode-label {
  font-size: 12px;
  color: var(--mp-text-faint);
  transition: color 0.15s;
}

/* 当前生效的那一侧亮起来（另一侧保持灰，一眼能看出现在在哪边） */
.mode-label.active {
  color: var(--mp-text);
  font-weight: 600;
}

/*
 * 两个模式的说明（两行），每行以模式名开头。
 *
 * ⚠ `margin: 0` 不能省：它们挂在 `<p>` 上，而 antd 的 reset 给 `p` 留了
 *   `margin-bottom: 1em`（见 `styles/index.ts` 的说明）—— 两行之间会多出 16px。
 */
.mode-desc {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-desc p {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--mp-text-faint);
}

.mode-desc-title {
  color: var(--mp-text-dim);
  font-weight: 600;
}
</style>
