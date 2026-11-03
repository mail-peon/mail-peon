<script setup lang="ts">
import { ref } from 'vue'
import { t } from '~/logic/strings'

defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ export: [], import: [event: Event], clear: [] }>()
const input = ref<HTMLInputElement | null>(null)
</script>

<template>
  <a-card size="small" :title="t('general.data')">
    <div class="actions actions-tight">
      <a-button :disabled="disabled" @click="emit('export')">
        {{ t('general.exportSettings') }}
      </a-button>
      <a-button :disabled="disabled" @click="input?.click()">
        {{ t('general.importSettings') }}
      </a-button>
      <a-button :disabled="disabled" @click="emit('clear')">
        {{ t('general.clearMails') }}
      </a-button>
    </div>
    <input ref="input" type="file" accept="application/json,.json" class="hidden-input" @change="emit('import', $event)">
    <p class="mp-hint">
      导出不含密码 / OAuth token / AI Key，也不含邮件正文。
    </p>
  </a-card>
</template>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hidden-input {
  display: none;
}
</style>
