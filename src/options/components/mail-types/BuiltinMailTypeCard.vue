<script setup lang="ts">
import type { MailTypeAdapter } from '~/logic/types'
import { t } from '~/logic/strings'

defineProps<{ adapter: MailTypeAdapter, disabled: boolean }>()
const emit = defineEmits<{ toggle: [enabled: boolean], save: [], reset: [] }>()
const userPrompt = defineModel<string>('userPrompt', { default: '' })
</script>

<template>
  <a-card size="small" class="builtin">
    <template #title>
      <div class="card-title">
        <span class="name">{{ adapter.name }}</span>
        <a-tag :bordered="false" class="tag">
          {{ t('adapters.builtinTag') }}
        </a-tag>
        <a-tag v-if="adapter.fallback" :bordered="false" class="tag">
          {{ t('adapters.fallbackTag') }}
        </a-tag>
      </div>
    </template>

    <template #extra>
      <a-switch
        :checked="adapter.enabled"
        :disabled="disabled"
        :aria-label="t('adapters.enabled')"
        @update:checked="(value: boolean | string | number) => emit('toggle', Boolean(value))"
      />
    </template>

    <p class="desc">
      {{ adapter.description }}
    </p>
    <p class="meta">
      #{{ adapter.priority }} · {{ adapter.fallback ? t('adapters.fallback') : t('adapters.stackable') }}
    </p>

    <slot name="params" />

    <a-collapse ghost class="prompt-collapse">
      <a-collapse-panel key="prompt" :header="t('adapters.userPrompt')">
        <a-textarea
          v-model:value="userPrompt"
          :rows="4"
          :placeholder="t('adapters.userPromptPlaceholder')"
          :disabled="disabled"
          spellcheck="false"
        />
        <a-space class="prompt-actions" :size="8">
          <a-button size="small" type="primary" :disabled="disabled" @click="emit('save')">
            {{ t('common.save') }}
          </a-button>
          <a-button size="small" :disabled="disabled" @click="emit('reset')">
            {{ t('adapters.reset') }}
          </a-button>
        </a-space>
      </a-collapse-panel>
    </a-collapse>
  </a-card>
</template>

<style scoped src="./card.css" />
