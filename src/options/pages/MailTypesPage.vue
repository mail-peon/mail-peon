<script setup lang="ts">
import type { MailTypeAdapter } from '~/logic/types'
import { computed, reactive, ref, watch } from 'vue'

import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { useMailTypes, useSettings } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { adapterPromptChars, estimatePromptTokens } from '~/logic/mail-types/resolve'
import { t } from '~/logic/strings'
import { BUILTIN_CODE_ID } from '~/logic/types'
import { useAppMessage } from '~/logic/ui-message'
import BuiltinMailTypeCard from '../components/mail-types/BuiltinMailTypeCard.vue'
import CustomMailTypeEditor from '../components/mail-types/CustomMailTypeEditor.vue'

/**
 * 适配器配置页（Feature 08）。
 *
 * 卡片列表 = 内置（验证码 / 确认 / 总结）+ 自定义。
 *
 * - 内置：名称 / 描述 / 基础提示词只读；可开关、可加「用户补充规则」、可恢复默认。
 * - 自定义：可编辑 / 删除 / 上下移 / 勾兜底。
 * - 极简模式：所有开关与编辑操作禁用（模式 overlay 强制 code+confirm）。
 * - 不设个数 / 字数硬上限：只显示提示词预算，提醒「每封邮件都会带上」。
 */

const { adapters, setEnabled, setUserPrompt, setParams, create, update, remove, move, reset } = useMailTypes()
const { app } = useSettings()
const uiMessage = useAppMessage()

const minimalMode = computed(() => app.value?.minimalMode ?? true)
const builtinAdapters = computed(() => adapters.value.filter(adapter => adapter.kind === 'builtin'))
const primaryBuiltins = computed(() => builtinAdapters.value.filter(adapter => adapter.ui !== 'summary'))
const summaryAdapter = computed(() => builtinAdapters.value.find(adapter => adapter.ui === 'summary'))
const customAdapters = computed(() => adapters.value.filter(adapter => adapter.kind === 'custom'))

const promptChars = computed(() => adapterPromptChars(adapters.value))
const promptTokens = computed(() => estimatePromptTokens(promptChars.value))

/**
 * 内置类型的「用户补充规则」草稿。
 *
 * 不直接 v-model 到 adapter.userPrompt：那个对象来自 IPC，改它不会写库，
 * 而且下次 reload 会把未保存的编辑覆盖掉。草稿 + 显式保存按钮更可控。
 */
const userPromptDraft = reactive<Record<string, string>>({})

watch(adapters, (list) => {
  for (const adapter of list) {
    if (adapter.kind === 'builtin')
      userPromptDraft[adapter.id] = adapter.userPrompt ?? ''
  }
}, { immediate: true })

async function onToggle(adapter: MailTypeAdapter, enabled: boolean) {
  if (minimalMode.value)
    return
  await setEnabled(adapter.id, enabled)
}

async function saveUserPrompt(adapter: MailTypeAdapter) {
  await setUserPrompt(adapter.id, userPromptDraft[adapter.id] ?? '')
  uiMessage.success(t('common.save'))
}

/** 验证码适配器的参数：没有显式值时回退到旧的全局设置（升级兼容） */
function autoCopyCode(adapter: MailTypeAdapter): boolean {
  const value = adapter.params?.autoCopyCode
  if (typeof value === 'boolean')
    return value
  return app.value?.autoCopyCode ?? true
}

async function onAutoCopyToggle(adapter: MailTypeAdapter, value: boolean | string | number) {
  await setParams(adapter.id, { autoCopyCode: Boolean(value) })
}

/** 失效验证码自动删除：同样优先适配器参数，缺省回退旧全局设置 */
function autoDeleteExpiredCode(adapter: MailTypeAdapter): boolean {
  const value = adapter.params?.autoDeleteExpiredCode
  if (typeof value === 'boolean')
    return value
  return app.value?.autoDeleteExpiredCode ?? true
}

async function onAutoDeleteToggle(adapter: MailTypeAdapter, value: boolean | string | number) {
  await setParams(adapter.id, { autoDeleteExpiredCode: Boolean(value) })
}

async function resetBuiltin(adapter: MailTypeAdapter) {
  await reset(adapter.id)
  // 恢复默认后自动复制 / 失效自动删除也回到默认开启
  if (adapter.id === BUILTIN_CODE_ID)
    await setParams(adapter.id, { autoCopyCode: true, autoDeleteExpiredCode: true })
  userPromptDraft[adapter.id] = ''
  uiMessage.success(t('adapters.resetDone'))
}

// ---------------------------------------------------------------------------
// 自定义类型编辑
// ---------------------------------------------------------------------------

const editingId = ref<string | null>(null)
const editing = ref(false)
const draft = reactive({ name: '', prompt: '', fallback: false })
const formError = ref('')

const editingExisting = computed(() => editingId.value !== null)

function newCustom() {
  if (minimalMode.value)
    return
  editingId.value = null
  draft.name = ''
  draft.prompt = ''
  draft.fallback = false
  formError.value = ''
  editing.value = true
}

function editCustom(adapter: MailTypeAdapter) {
  if (minimalMode.value)
    return
  editingId.value = adapter.id
  draft.name = adapter.name
  draft.prompt = adapter.prompt
  draft.fallback = adapter.fallback
  formError.value = ''
  editing.value = true
}

function closeEditor() {
  editing.value = false
  editingId.value = null
  formError.value = ''
}

async function saveCustom() {
  formError.value = ''

  if (!draft.name.trim()) {
    formError.value = `${t('adapters.name')}不能为空`
    return
  }
  if (!draft.prompt.trim()) {
    formError.value = `${t('adapters.prompt')}不能为空`
    return
  }

  if (editingId.value) {
    await update(editingId.value, {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      fallback: draft.fallback,
    })
  }
  else {
    const result = await create({
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      fallback: draft.fallback,
    })
    if (!result.ok) {
      formError.value = result.error ?? '保存失败'
      return
    }
  }

  closeEditor()
}

const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

function onDelete(adapter: MailTypeAdapter) {
  askConfirm({
    title: t('common.delete'),
    message: t('adapters.deleteConfirm', { name: adapter.name }),
    confirmText: t('common.delete'),
    run: () => remove(adapter.id),
  })
}
</script>

<template>
  <section class="page">
    <a-alert
      v-if="minimalMode"
      type="info"
      show-icon
      :message="t('adapters.minimalLocked')"
    />

    <div class="header">
      <p class="mp-hint intro">
        {{ t('adapters.intro') }}
      </p>
      <a-button type="primary" :disabled="minimalMode" @click="newCustom">
        <span class="i-pixelarticons-plus" aria-hidden="true" />
        {{ t('adapters.add') }}
      </a-button>
    </div>

    <!--
      提示词预算：不设硬上限，但要让用户知道「这些字会随每封邮件一起发出去」。
      真正的护栏在调用侧（超出模型上下文时明确降级）。
    -->
    <p class="budget">
      {{ t('adapters.promptBudget', { chars: promptChars, tokens: promptTokens }) }}
    </p>

    <!-- ============ 内置（验证码 / 确认） ============ -->
    <BuiltinMailTypeCard
      v-for="adapter in primaryBuiltins"
      :key="adapter.id"
      v-model:user-prompt="userPromptDraft[adapter.id]"
      :adapter="adapter"
      :disabled="minimalMode"
      @toggle="value => onToggle(adapter, value)"
      @save="saveUserPrompt(adapter)"
      @reset="resetBuiltin(adapter)"
    >
      <template #params>
        <!--
        验证码自己的参数。极简模式下适配器开关锁定，但这两个是行为开关，
        不是「类型生不生效」，所以不跟着禁用。
      -->
        <div v-if="adapter.id === BUILTIN_CODE_ID" class="adapter-param">
          <div class="param-row">
            <a-checkbox
              :checked="autoCopyCode(adapter)"
              @update:checked="(value: boolean | string | number) => onAutoCopyToggle(adapter, value)"
            >
              {{ t('adapters.code.autoCopyCode') }}
            </a-checkbox>
            <p class="mp-hint">
              {{ t('adapters.code.autoCopyCodeHint') }}
            </p>
          </div>

          <div class="param-row">
            <a-checkbox
              :checked="autoDeleteExpiredCode(adapter)"
              @update:checked="(value: boolean | string | number) => onAutoDeleteToggle(adapter, value)"
            >
              {{ t('adapters.code.autoDeleteExpiredCode') }}
            </a-checkbox>
            <p class="mp-hint">
              {{ t('adapters.code.autoDeleteExpiredCodeHint') }}
            </p>
          </div>
        </div>
      </template>
    </BuiltinMailTypeCard>

    <!-- ============ 自定义 ============ -->
    <a-card v-for="(adapter, index) in customAdapters" :key="adapter.id" size="small">
      <template #title>
        <div class="card-title">
          <span class="name">{{ adapter.name }}</span>
          <a-tag :bordered="false" class="tag">
            {{ t('adapters.customTag') }}
          </a-tag>
          <a-tag v-if="adapter.fallback" :bordered="false" class="tag">
            {{ t('adapters.fallbackTag') }}
          </a-tag>
        </div>
      </template>

      <template #extra>
        <a-switch
          :checked="adapter.enabled"
          :disabled="minimalMode"
          :aria-label="t('adapters.enabled')"
          @update:checked="(value: boolean | string | number) => onToggle(adapter, Boolean(value))"
        />
      </template>

      <p class="desc" :class="{ empty: !adapter.prompt }">
        {{ adapter.prompt || t('adapters.noPrompt') }}
      </p>
      <p class="meta">
        #{{ adapter.priority }} · {{ adapter.fallback ? t('adapters.fallback') : t('adapters.stackable') }}
      </p>

      <a-space class="actions" :size="8" wrap>
        <a-button size="small" :disabled="minimalMode" @click="editCustom(adapter)">
          {{ t('common.edit') }}
        </a-button>
        <a-button size="small" :disabled="minimalMode || index === 0" @click="move(adapter.id, 'up')">
          {{ t('adapters.moveUp') }}
        </a-button>
        <a-button size="small" :disabled="minimalMode || index === customAdapters.length - 1" @click="move(adapter.id, 'down')">
          {{ t('adapters.moveDown') }}
        </a-button>
        <a-button size="small" danger :disabled="minimalMode" @click="onDelete(adapter)">
          {{ t('common.delete') }}
        </a-button>
      </a-space>
    </a-card>

    <a-card v-if="!customAdapters.length" size="small">
      <a-empty :description="t('adapters.empty')" />
    </a-card>

    <!-- ============ 兜底：总结永远最后 ============ -->
    <BuiltinMailTypeCard
      v-if="summaryAdapter"
      v-model:user-prompt="userPromptDraft[summaryAdapter.id]"
      :adapter="summaryAdapter"
      :disabled="minimalMode"
      @toggle="value => onToggle(summaryAdapter!, value)"
      @save="saveUserPrompt(summaryAdapter!)"
      @reset="resetBuiltin(summaryAdapter!)"
    />

    <!-- ============ 新增 / 编辑自定义类型 ============ -->
    <CustomMailTypeEditor
      v-if="editing"
      v-model:name="draft.name"
      v-model:prompt="draft.prompt"
      v-model:fallback="draft.fallback"
      :existing="editingExisting"
      :error="formError"
      @save="saveCustom"
      @cancel="closeEditor"
    />

    <ConfirmDialog
      :open="pending !== null"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :confirm-text="pending?.confirmText ?? t('common.confirm')"
      danger
      @confirm="runPending"
      @cancel="cancelConfirm"
    />
  </section>
</template>

<style scoped src="../components/mail-types/card.css" />

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.intro {
  margin: 0;
  max-width: 480px;
}

.budget {
  margin: 0;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.adapter-param {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--mp-border);
}

.adapter-param .mp-hint {
  margin: 4px 0 0 24px;
}

.param-row + .param-row {
  margin-top: 8px;
}

.actions {
  margin-top: 8px;
}
</style>
