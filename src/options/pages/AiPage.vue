<script setup lang="ts">
import type { AiSettings } from '~/logic/types'
import type { UiStatusText } from '~/logic/ui-status'
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
 *
 * ## 「测试连通」的结果是一枚**状态徽标**（卡片右上角），不是一条横幅
 *
 * 与「账号」页同一套（`components/StatusBadge.vue` + `logic/ui-status.ts`）：
 * 圆点给颜色、状态词给结论、悬停给详情 ——
 * 例如 `DeepSeek · deepseek-flash 连接成功（1735 ms）`。
 *
 * ⚠ 改配置会让上一次结果**失效**（见 `watch(draft)`）：测通之后又改了 Key，
 *   那枚绿点说的是**旧值**，留着就是误导。
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
const testResult = ref<{ ok: boolean, text: string, latencyMs?: number } | null>(null)
const saved = ref('')

const current = computed(() => platforms.value.find(item => item.value === draft.value?.platform) ?? null)

/** 平台下拉的选项 */
const platformOptions = computed(() =>
  platforms.value.map(item => ({ value: item.value, label: item.label })),
)

/**
 * 「这次测的是哪一份配置」——平台 · 模型。
 *
 * ⚠ 用它拼 tooltip 的详情，格式就是用户要的那种：
 *   `DeepSeek · deepseek-flash 连接成功（1735 ms）`。
 *   模型留空时用平台的默认模型（那才是实际会用的值）。
 */
const testedLabel = computed(() => {
  const platform = current.value?.label ?? draft.value?.platform ?? ''
  const model = draft.value?.model || current.value?.defaultModel || ''
  return [platform, model].filter(Boolean).join(' · ')
})

/** 卡片右上角那枚状态徽标 */
const aiStatus = computed<UiStatusText>(() => {
  if (testing.value)
    return { status: 'warning', label: t('ai.testing'), detail: `${testedLabel.value} ${t('ai.testing')}` }

  const result = testResult.value
  if (!result)
    return { status: 'default', label: t('ai.statusUntested'), detail: `${testedLabel.value} ${t('ai.untestedHint')}` }

  if (result.ok) {
    return {
      status: 'success',
      label: t('ai.testOk'),
      detail: `${testedLabel.value} ${t('ai.testOk')}（${result.latencyMs ?? 0} ms）`,
    }
  }

  return { status: 'error', label: t('ai.statusFail'), detail: `${testedLabel.value}：${result.text}` }
})

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

/**
 * 改任何一项配置 → 上一次的测试结果作废。
 *
 * ⚠ 只在**已有结果**时清（`if (!testResult.value) return`），
 *   否则这个 watcher 会在每次输入时都写一次 ref（多一次无谓的重渲染）。
 */
watch(draft, () => {
  if (testResult.value)
    testResult.value = null
}, { deep: true })

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
      ? { ok: true, text: result.detail ?? t('ai.testOk'), latencyMs: result.latencyMs }
      : { ok: false, text: result.error ?? '测试失败' }
  }
  finally {
    testing.value = false
  }
}

/** 切平台时把 baseUrl / model 清空 —— 它们此刻指的是上一家的地址 */
function onPlatformChange(value: unknown) {
  if (!draft.value)
    return
  draft.value.platform = String(value)
  draft.value.baseUrl = ''
  draft.value.model = ''
  testResult.value = null
}

/**
 * 输出语言（只有两个取值）。
 *
 * ⚠ 参数是 `unknown`：`a-radio-group` 的 `update:value` 载荷在 antd 的类型里是
 *   `any`（同一组还能装字符串 / 数字），这里自己收窄到那两个合法值 ——
 *   顺手把「将来多一个选项」变成一个需要显式处理的分支。
 */
function onOutputLanguageChange(value: unknown) {
  if (!draft.value)
    return
  draft.value.outputLanguage = value === 'auto-email' ? 'auto-email' : 'auto-browser'
}
</script>

<template>
  <section class="page">
    <a-card v-if="!draft" size="small">
      <a-spin size="small" />
    </a-card>

    <template v-else>
      <a-card size="small" :title="t('ai.cardTitle')">
        <!-- 状态徽标放卡片右上角，与「账号」页一致（颜色 + 状态词 + 悬停详情） -->
        <template #extra>
          <StatusBadge v-bind="aiStatus" />
        </template>

        <a-form layout="vertical" class="form">
          <a-form-item
            :label="t('ai.platform')"
            :help="current?.hint"
          >
            <a-select
              class="control"
              :value="draft.platform"
              :options="platformOptions"
              @update:value="onPlatformChange"
            />
            <p v-if="current && !current.nativeJson" class="mp-hint">
              该平台不支持原生 JSON 输出，会在提示词里明确要求返回 JSON，并由 zod 校验。
            </p>
          </a-form-item>

          <a-form-item :label="t('ai.baseUrl')">
            <a-input
              v-model:value="draft.baseUrl"
              :placeholder="current?.defaultBaseUrl ? t('ai.baseUrlPlaceholder', { url: current.defaultBaseUrl }) : 'https://…'"
              spellcheck="false"
            />
          </a-form-item>

          <a-form-item :label="t('ai.apiKey')" help="Key 只存在本机 IndexedDB，不会上传到任何服务器（除了你配置的 AI 平台本身）。">
            <SecretInput v-model="draft.apiKey" placeholder="sk-…" />
          </a-form-item>

          <a-form-item :label="t('ai.model')">
            <a-input
              v-model:value="draft.model"
              :placeholder="current?.defaultModel ? t('ai.modelPlaceholder', { model: current.defaultModel }) : 'gpt-4o-mini'"
              spellcheck="false"
            />
          </a-form-item>

          <a-form-item>
            <a-checkbox v-model:checked="draft.thinking">
              {{ t('ai.thinking') }}
            </a-checkbox>
            <p class="mp-hint indent">
              {{ t('ai.thinkingHint') }}
            </p>
          </a-form-item>

          <a-divider class="divider" />

          <a-form-item :label="t('ai.outputLanguage')" help="只影响摘要与判定文字，不会翻译邮件原文。">
            <a-radio-group
              class="vertical"
              :value="draft.outputLanguage"
              @update:value="onOutputLanguageChange"
            >
              <a-radio value="auto-browser">
                {{ t('ai.outputLanguageBrowser') }}
              </a-radio>
              <a-radio value="auto-email">
                {{ t('ai.outputLanguageEmail') }}
              </a-radio>
            </a-radio-group>
          </a-form-item>
        </a-form>
      </a-card>

      <!--
        「测试连通」的结果不在这里铺一条横幅，而是**这张卡片右上角的一枚状态徽标**
        （颜色 + 状态词 + 悬停详情）—— 与「账号」页同一套呈现方式。
      -->
      <a-card size="small">
        <a-space :size="8" wrap>
          <a-button type="primary" :disabled="!isDirty" @click="onSave">
            {{ t('common.save') }}
          </a-button>
          <a-button :loading="testing" @click="onTest">
            {{ testing ? t('ai.testing') : t('ai.test') }}
          </a-button>
          <span v-if="saved" class="mp-ok">{{ saved }}</span>
          <span v-if="isDirty" class="mp-hint">有未保存的改动（测试用的是当前填写的值）</span>
        </a-space>
      </a-card>
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
  max-width: 560px;
}

/* 平台下拉不要撑满整行（撑满看起来像文本框） */
.control {
  max-width: 260px;
}

.indent {
  margin: 4px 0 0;
}

.divider {
  margin: 14px 0;
}

.vertical :deep(.ant-radio-wrapper) {
  display: flex;
  margin-bottom: 6px;
}

/* 状态徽标不要被卡片头部压缩（「未测试」这类长一点的状态词会换成两行） */
.page :deep(.ant-card-extra) {
  flex: 0 0 auto;
  margin-inline-start: 8px;
}
</style>
