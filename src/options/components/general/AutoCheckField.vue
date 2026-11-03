<script setup lang="ts">
import { t } from '~/logic/strings'
import { CHECK_INTERVAL_MAX_MINUTES, CHECK_INTERVAL_MIN_MINUTES, DEFAULT_CHECK_INTERVAL_MINUTES } from '~/logic/types'

defineProps<{ minutes?: number }>()
const emit = defineEmits<{ change: [value: string | number | null] }>()
</script>

<template>
  <div class="field">
    <span class="field-label">{{ t('general.autoCheck') }}</span>
    <div class="field-control interval-control">
      <a-input-number
        :value="minutes ?? DEFAULT_CHECK_INTERVAL_MINUTES"
        :min="CHECK_INTERVAL_MIN_MINUTES"
        :max="CHECK_INTERVAL_MAX_MINUTES"
        :precision="0"
        @update:value="value => emit('change', value)"
      />
      <span class="interval-unit">{{ t('general.autoCheckUnit') }}</span>
    </div>
  </div>
  <p class="mp-hint auto-check-hint">
    {{ t('general.autoCheckHint') }}
  </p>
</template>

<style scoped src="./fields.css" />

<style scoped>
.auto-check-hint {
  margin: 2px 0 0;
}

.interval-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.interval-control :deep(.ant-input-number) {
  width: 110px;
}

.interval-unit {
  font-size: 12px;
  color: var(--mp-text-dim);
}
</style>
