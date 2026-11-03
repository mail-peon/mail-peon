<script setup lang="ts">
import { t } from '~/logic/strings'

defineProps<{ existing: boolean, error: string }>()
const emit = defineEmits<{ cancel: [], save: [] }>()
const name = defineModel<string>('name', { required: true })
const prompt = defineModel<string>('prompt', { required: true })
const fallback = defineModel<boolean>('fallback', { required: true })
</script>

<template>
  <a-modal
    class="editor"
    :open="true"
    :width="640"
    :get-container="false"
    :mask-closable="false"
    :body-style="{ maxHeight: '62vh', overflowY: 'auto' }"
    centered
    @cancel="emit('cancel')"
  >
    <template #title>
      {{ existing ? t('common.edit') : t('adapters.add') }}
    </template>

    <a-alert v-if="error" class="editor-error" type="error" show-icon :message="error" />

    <a-form layout="vertical" class="form">
      <a-form-item :label="t('adapters.name')" required>
        <a-input v-model:value="name" :placeholder="t('adapters.namePlaceholder')" />
      </a-form-item>

      <a-form-item :label="t('adapters.prompt')" required :help="t('adapters.promptHint')">
        <a-textarea
          v-model:value="prompt"
          :rows="10"
          :placeholder="t('adapters.promptPlaceholder')"
          spellcheck="false"
        />
      </a-form-item>

      <a-form-item>
        <a-checkbox v-model:checked="fallback">
          {{ t('adapters.fallback') }}
        </a-checkbox>
      </a-form-item>
    </a-form>

    <template #footer>
      <a-space :size="8">
        <a-button @click="emit('cancel')">
          {{ t('common.cancel') }}
        </a-button>
        <a-button type="primary" @click="emit('save')">
          {{ t('common.save') }}
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.form {
  width: 100%;
}

.editor-error {
  margin-bottom: 12px;
}
</style>
