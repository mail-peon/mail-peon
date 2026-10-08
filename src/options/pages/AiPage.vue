<script setup lang="ts">
import type { AiSettings } from '~/logic/types'
import { computed, ref, watch } from 'vue'
import SecretInput from '~/components/SecretInput.vue'
import { send, useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'

/**
 * AI 配置页（`design/ui-flows.md § 4.7`）。
 *
 * 四个平台（OpenAI / DeepSeek / Anthropic / 自定义）的清单**从注册表读**
 * （`ai:platforms`），不是写死的 —— 加一家平台只需要加一个目录。
 *
 * ⚠ 表单是「受控副本 + 保存」而不是「输入即保存」：
 *   API Key 输入到一半就被写进库的话，一轮心跳正好跑起来时它会拿着半个 key 去
 *   调 AI，然后失败并把邮件标成降级。这些副作用用户完全看不到原因。
 */

const props = defineProps<{ settings: AiSettings | null }>()

const { setAi } = useSettings()

interface PlatformOption {
  value: string
  label: string
  hint: string
  defaultBaseUrl: string
  defaultModel: string
  nativeJson: boolean
}

const platforms = ref<PlatformOption[]>([])
const draft = ref<AiSettings | null>(null)
const testing = ref(false)
const testResult = ref<{ ok: boolean, text: string } | null>(null)
const saved = ref('')

const current = computed(() => platforms.value.find(item => item.value === draft.value?.platform) ?? null)

// 平台清单只拉一次
void send<{ platforms: PlatformOption[] }>('ai:platforms', undefined, { platforms: [] }).then((result) => {
  platforms.value = result.platforms ?? []
})

/**
 * 草稿与已保存设置是否不同。
 *
 * 放在最前面声明，因为下面的 `watch` 回调里读它 —— 声明在 `watch` 之后的话
 * 会被 `ts/no-use-before-define` 拦下（而这个规则在这里是对的：
 * 「回调体的执行时机」是一层需要读者自己推的间接，不值得为它开例外）。
 */
const isDirty = computed(() => {
  if (!draft.value || !props.settings)
    return false
  return JSON.stringify(draft.value) !== JSON.stringify(props.settings)
})

/**
 * 外部设置变化时重建草稿。
 *
 * 只在**没有未保存改动**时同步：否则用户在填 Key 的途中，background 广播一次
 * 设置更新（比如另一处改了 `excludeAds`）就会把输入框清空。
 */
watch(
  () => props.settings,
  (value) => {
    if (!value)
      return
    if (draft.value && isDirty.value)
      return
    draft.value = { ...value }
  },
  { immediate: true, deep: true },
)

let savedTimer: ReturnType<typeof setTimeout> | null = null

async function onSave() {
  if (!draft.value)
    return
  await setAi(draft.value)
  saved.value = '已保存'
  if (savedTimer)
    clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = ''
  }, 2500)
}

async function onTest() {
  if (!draft.value)
    return
  testing.value = true
  testResult.value = null
  try {
    // 测的是**草稿**而不是已保存的设置：用户改完 Key 想立刻验证，
    // 如果测的是库里的旧值，他会得到「测试失败」而去改一个本来正确的 key
    const result = await send<{ ok: boolean, detail?: string, error?: string, latencyMs?: number }>(
      'ai:test',
      { ai: draft.value },
      { ok: false, error: '请求失败' },
    )
    testResult.value = result.ok
      ? { ok: true, text: `${result.detail ?? t('ai.testOk')}（${result.latencyMs ?? 0} ms）` }
      : { ok: false, text: result.error ?? '测试失败' }
  }
  finally {
    testing.value = false
  }
}

/** 切平台时把 baseUrl / model 清空 —— 它们此刻指的是上一家的地址 */
function onPlatformChange(value: string) {
  if (!draft.value)
    return
  draft.value.platform = value
  draft.value.baseUrl = ''
  draft.value.model = ''
  testResult.value = null
}
</script>

<template>
  <section class="page">
    <div v-if="!draft" class="mp-card">
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <div class="mp-card">
        <div class="form">
          <label class="mp-field">
            <span class="mp-field-label">{{ t('ai.platform') }}</span>
            <select
              class="mp-select"
              :value="draft.platform"
              @change="onPlatformChange(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in platforms" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
            <span v-if="current?.hint" class="mp-hint">{{ current.hint }}</span>
            <span v-if="current && !current.nativeJson" class="mp-hint">
              该平台不支持原生 JSON 输出，会在提示词里明确要求返回 JSON，并由 zod 校验。
            </span>
          </label>

          <label class="mp-field">
            <span class="mp-field-label">{{ t('ai.baseUrl') }}</span>
            <input
              v-model="draft.baseUrl"
              class="mp-input"
              :placeholder="current?.defaultBaseUrl ? t('ai.baseUrlPlaceholder', { url: current.defaultBaseUrl }) : 'https://…'"
              spellcheck="false"
            >
          </label>

          <label class="mp-field">
            <span class="mp-field-label">{{ t('ai.apiKey') }}</span>
            <SecretInput v-model="draft.apiKey" placeholder="sk-…" />
            <span class="mp-hint">Key 只存在本机 IndexedDB，不会上传到任何服务器（除了你配置的 AI 平台本身）。</span>
          </label>

          <label class="mp-field">
            <span class="mp-field-label">{{ t('ai.model') }}</span>
            <input
              v-model="draft.model"
              class="mp-input"
              :placeholder="current?.defaultModel ? t('ai.modelPlaceholder', { model: current.defaultModel }) : 'gpt-4o-mini'"
              spellcheck="false"
            >
          </label>

          <label class="mp-checkbox">
            <input v-model="draft.thinking" type="checkbox">
            <span>{{ t('ai.thinking') }}</span>
          </label>
          <p class="mp-hint indent">
            {{ t('ai.thinkingHint') }}
          </p>

          <hr class="mp-divider">

          <div class="mp-field">
            <span class="mp-field-label">{{ t('ai.outputLanguage') }}</span>
            <div class="mp-radio-group">
              <label class="mp-radio">
                <input
                  type="radio"
                  :checked="draft.outputLanguage !== 'auto-email'"
                  @change="draft.outputLanguage = 'auto-browser'"
                >
                <span>{{ t('ai.outputLanguageBrowser') }}</span>
              </label>
              <label class="mp-radio">
                <input
                  type="radio"
                  :checked="draft.outputLanguage === 'auto-email'"
                  @change="draft.outputLanguage = 'auto-email'"
                >
                <span>{{ t('ai.outputLanguageEmail') }}</span>
              </label>
            </div>
            <span class="mp-hint">
              只影响摘要与判定文字，不会翻译邮件原文。
            </span>
          </div>
        </div>

        <div class="actions">
          <button class="mp-btn mp-btn-primary" type="button" :disabled="!isDirty" @click="onSave">
            {{ t('common.save') }}
          </button>
          <button class="mp-btn" type="button" :disabled="testing" @click="onTest">
            {{ testing ? t('ai.testing') : t('ai.test') }}
          </button>
          <span v-if="saved" class="mp-ok">{{ saved }}</span>
          <span v-if="isDirty" class="mp-hint">有未保存的改动（测试用的是当前填写的值）</span>
        </div>

        <p v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
          {{ testResult.ok ? '✓' : '✗' }} {{ testResult.text }}
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.indent {
  margin: -4px 0 0;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.test-result {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
}

.test-result.ok { color: var(--mp-success); }
.test-result.fail { color: var(--mp-danger); }
</style>
