<script setup lang="ts">
import type { MailTypeAdapter } from '~/logic/types'
import { computed, reactive, ref, watch } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { useMailTypes, useSettings } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { adapterPromptChars, estimatePromptTokens } from '~/logic/mail-types/resolve'
import { t } from '~/logic/strings'
import { useAppMessage } from '~/logic/ui-message'

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

const { adapters, setEnabled, setUserPrompt, create, update, remove, move, reset } = useMailTypes()
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

async function resetBuiltin(adapter: MailTypeAdapter) {
  await reset(adapter.id)
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
    <a-card v-for="adapter in primaryBuiltins" :key="adapter.id" size="small" class="builtin">
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
          :disabled="minimalMode"
          :aria-label="t('adapters.enabled')"
          @update:checked="(value: boolean | string | number) => onToggle(adapter, Boolean(value))"
        />
      </template>

      <p class="desc">
        {{ adapter.description }}
      </p>
      <p class="meta">
        #{{ adapter.priority }} · {{ adapter.fallback ? t('adapters.fallback') : t('adapters.stackable') }}
      </p>

      <a-collapse ghost class="prompt-collapse">
        <a-collapse-panel key="prompt" :header="t('adapters.userPrompt')">
          <a-textarea
            v-model:value="userPromptDraft[adapter.id]"
            :rows="4"
            :placeholder="t('adapters.userPromptPlaceholder')"
            :disabled="minimalMode"
            spellcheck="false"
          />
          <a-space class="prompt-actions" :size="8">
            <a-button size="small" type="primary" :disabled="minimalMode" @click="saveUserPrompt(adapter)">
              {{ t('common.save') }}
            </a-button>
            <a-button size="small" :disabled="minimalMode" @click="resetBuiltin(adapter)">
              {{ t('adapters.reset') }}
            </a-button>
          </a-space>
        </a-collapse-panel>
      </a-collapse>
    </a-card>

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
    <a-card v-if="summaryAdapter" size="small" class="builtin">
      <template #title>
        <div class="card-title">
          <span class="name">{{ summaryAdapter.name }}</span>
          <a-tag :bordered="false" class="tag">
            {{ t('adapters.builtinTag') }}
          </a-tag>
          <a-tag :bordered="false" class="tag">
            {{ t('adapters.fallbackTag') }}
          </a-tag>
        </div>
      </template>

      <template #extra>
        <a-switch
          :checked="summaryAdapter.enabled"
          :disabled="minimalMode"
          :aria-label="t('adapters.enabled')"
          @update:checked="(value: boolean | string | number) => onToggle(summaryAdapter!, Boolean(value))"
        />
      </template>

      <p class="desc">
        {{ summaryAdapter.description }}
      </p>
      <p class="meta">
        #{{ summaryAdapter.priority }} · {{ t('adapters.fallback') }}
      </p>

      <a-collapse ghost class="prompt-collapse">
        <a-collapse-panel key="prompt" :header="t('adapters.userPrompt')">
          <a-textarea
            v-model:value="userPromptDraft[summaryAdapter.id]"
            :rows="4"
            :placeholder="t('adapters.userPromptPlaceholder')"
            :disabled="minimalMode"
            spellcheck="false"
          />
          <a-space class="prompt-actions" :size="8">
            <a-button size="small" type="primary" :disabled="minimalMode" @click="saveUserPrompt(summaryAdapter!)">
              {{ t('common.save') }}
            </a-button>
            <a-button size="small" :disabled="minimalMode" @click="resetBuiltin(summaryAdapter!)">
              {{ t('adapters.reset') }}
            </a-button>
          </a-space>
        </a-collapse-panel>
      </a-collapse>
    </a-card>

    <!-- ============ 新增 / 编辑自定义类型 ============ -->
    <a-modal
      v-if="editing"
      class="editor"
      :open="true"
      :width="640"
      :get-container="false"
      :mask-closable="false"
      :body-style="{ maxHeight: '62vh', overflowY: 'auto' }"
      centered
      @cancel="closeEditor"
    >
      <template #title>
        {{ editingExisting ? t('common.edit') : t('adapters.add') }}
      </template>

      <a-alert v-if="formError" class="editor-error" type="error" show-icon :message="formError" />

      <a-form layout="vertical" class="form">
        <a-form-item :label="t('adapters.name')" required>
          <a-input v-model:value="draft.name" :placeholder="t('adapters.namePlaceholder')" />
        </a-form-item>

        <a-form-item :label="t('adapters.prompt')" required :help="t('adapters.promptHint')">
          <a-textarea
            v-model:value="draft.prompt"
            :rows="10"
            :placeholder="t('adapters.promptPlaceholder')"
            spellcheck="false"
          />
        </a-form-item>

        <a-form-item>
          <a-checkbox v-model:checked="draft.fallback">
            {{ t('adapters.fallback') }}
          </a-checkbox>
        </a-form-item>
      </a-form>

      <template #footer>
        <a-space :size="8">
          <a-button @click="closeEditor">
            {{ t('common.cancel') }}
          </a-button>
          <a-button type="primary" @click="saveCustom">
            {{ t('common.save') }}
          </a-button>
        </a-space>
      </template>
    </a-modal>

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

.card-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-size: 13px;
  font-weight: 600;
}

.tag {
  margin: 0;
  font-weight: 400;
}

/* 内置卡片用虚线边 + 灰底：它是「参考项」，不是可以随便编辑的对象 */
.builtin {
  background: var(--mp-surface-2);
  border-style: dashed;
}

.desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--mp-text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  /* 长提示词只露 4 行；完整内容在编辑弹窗里 */
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}

.desc.empty {
  color: var(--mp-text-faint);
  font-style: italic;
}

.meta {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.prompt-collapse {
  margin-top: 8px;
}

.prompt-collapse :deep(.ant-collapse-header) {
  padding: 4px 0;
  font-size: 12px;
  color: var(--mp-text-dim);
}

.prompt-collapse :deep(.ant-collapse-content-box) {
  padding: 0;
}

.prompt-actions {
  margin-top: 8px;
}

.actions {
  margin-top: 8px;
}

.form {
  width: 100%;
}

.editor-error {
  margin-bottom: 12px;
}
</style>
