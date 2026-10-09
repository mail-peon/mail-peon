<script setup lang="ts">
import type { PromptRule } from '~/logic/types'
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { useRules } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { t } from '~/logic/strings'

/**
 * 提示词页（`design/ui-flows.md § 4.3`）。
 *
 * 匹配优先级 = `priority` 升序（数字越小越优先），用户用「上移 / 下移」控制。
 * 内置默认规则**不落库**（见 `logic/store/rules.ts`），所以它永远显示在列表顶部、
 * 且不能编辑或删除 —— 用户清空所有规则之后仍然有一个可用的兜底。
 */

const { rules, reload, save, remove, move } = useRules()
const editing = ref<PromptRule | null>(null)
const pageError = ref('')

/**
 * 匹配条件编辑框里的文本（每行一条）。
 *
 * ⚠ 声明在 `newRule()` **之前**：那个函数要清空它，而 `ts/no-use-before-define`
 *   在这里是对的 —— 「回调体的执行时机」不该由读者去推。
 */
const matcherText = ref('')

onMounted(reload)

/** 编辑中的规则是不是已存在的（决定表单标题与「保存 / 新增」的口径） */
const editingExisting = computed(() =>
  !!editing.value && rules.value.some(item => item.id === editing.value!.id),
)

function newRule() {
  const now = Date.now()
  pageError.value = ''
  editing.value = {
    id: `rule-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    enabled: true,
    // 新规则排到最后（priority 取当前最大 + 1）；`listRules` 会用 createdAt 兜底排序
    priority: rules.value.length,
    matchers: [],
    prompt: '',
    createdAt: now,
    updatedAt: now,
  }
  matcherText.value = ''
}

function edit(rule: PromptRule) {
  // 深拷一份：直接编辑列表项会让「取消」失效（改动已经落到列表上了）
  editing.value = { ...rule, matchers: rule.matchers.map(item => ({ ...item })) }
}

/** 匹配器 ↔ 文本行（每行一条，UI 上比结构化编辑器好用得多） */
function matchersToText(rule: PromptRule): string {
  return rule.matchers
    .map(item => (item.kind === 'domain' ? `@${item.value}` : item.kind === 'regex' ? `/${item.value}/` : item.value))
    .join('\n')
}

/** 列表里那一行匹配条件的展示（同一套记法，但不换行） */
function matchersPreview(rule: PromptRule): string {
  return rule.matchers
    .map(item => (item.kind === 'domain' ? `@${item.value}` : item.kind === 'regex' ? `/${item.value}/` : item.value))
    .join('  ')
}

function textToMatchers(text: string): PromptRule['matchers'] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      // `/re/` 显式正则；`@domain` 或 `domain` 视作域名；含 `@`（非开头）视作邮箱
      if (line.startsWith('/') && line.endsWith('/') && line.length > 2)
        return { kind: 'regex' as const, value: line.slice(1, -1) }
      if (line.startsWith('@'))
        return { kind: 'domain' as const, value: line.slice(1).toLowerCase() }
      if (line.includes('@'))
        return { kind: 'email' as const, value: line.toLowerCase() }
      return { kind: 'domain' as const, value: line.toLowerCase() }
    })
}

function onEdit(rule: PromptRule) {
  edit(rule)
  matcherText.value = matchersToText(rule)
}

async function onSave() {
  if (!editing.value)
    return
  pageError.value = ''

  if (!editing.value.name.trim()) {
    pageError.value = '请填写规则名'
    return
  }

  const matchers = textToMatchers(matcherText.value)
  if (!matchers.length) {
    pageError.value = '至少填一条匹配（否则这条规则永远不会命中）'
    return
  }

  // 校验正则：写错了不会保存（保存后它在匹配阶段是静默不命中的，用户无从发现）
  for (const matcher of matchers) {
    if (matcher.kind !== 'regex')
      continue
    try {
      void new RegExp(matcher.value, 'i')
    }
    catch (error) {
      pageError.value = `正则不合法「${matcher.value}」：${error instanceof Error ? error.message : ''}`
      return
    }
  }

  await save({ ...editing.value, matchers, updatedAt: Date.now() })
  cancelEdit()
}

/** 关闭编辑弹窗（取消 / 点遮罩 / Esc 都走这里）——顺手清掉上一次的校验报错 */
function cancelEdit() {
  editing.value = null
  matcherText.value = ''
  pageError.value = ''
}

/**
 * 删除规则（不可撤销）。
 *
 * ⚠ 从原生 `window.confirm` 换成弹窗组件 —— 理由见 `confirm-action.ts`。
 *   这里必须**解构**返回值（同上）。
 */
const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

function onDelete(rule: PromptRule) {
  askConfirm({
    title: t('common.delete'),
    message: t('rules.deleteConfirm', { name: rule.name }),
    confirmText: t('common.delete'),
    run: () => remove(rule.id),
  })
}

function onToggle(rule: PromptRule, enabled: boolean) {
  void save({ ...rule, enabled, updatedAt: Date.now() })
}

/** 提示词模板片段（`features/03-prompt-rules.md § 5` 的「插入模板片段」） */
const TEMPLATES: Array<{ label: string, text: string }> = [
  {
    label: '验证码',
    text: '如果邮件中包含验证码，请把验证码放进 code 字段，minimal 只写「验证码：XXXXXX」。',
  },
  {
    label: '广告判定',
    text: '来自这个发件人的邮件：\n- 平台促销 / 活动推送 → isAd=true，minimal 留空\n- 订单 / 物流状态 → isAd=true\n- 账号安全告警 → isAd=false 且 urgency=high',
  },
  {
    label: '总结要点',
    text: 'summary 用 2-4 段：\n1. 一句话主旨\n2. 关键信息（数字、时间、链接）\n3. 需要我做什么',
  },
]

function insertTemplate(text: string) {
  if (!editing.value)
    return
  editing.value.prompt = editing.value.prompt ? `${editing.value.prompt}\n${text}` : text
}
</script>

<template>
  <section class="page">
    <div class="header">
      <a-button type="primary" @click="newRule">
        <span class="i-pixelarticons-plus" aria-hidden="true" />
        {{ t('rules.add') }}
      </a-button>
    </div>

    <a-alert v-if="pageError" type="error" show-icon :message="pageError" />

    <!-- 内置默认规则：只展示，不可编辑（它由 createDefaultRule() 现造，不落库） -->
    <a-card size="small" class="builtin">
      <template #title>
        <span class="rule-name">{{ t('rules.defaultRule') }}</span>
        <a-tag class="builtin-tag" :bordered="false">
          {{ t('rules.builtinTag') }}
        </a-tag>
      </template>
      <p class="mp-hint no-margin">
        {{ t('rules.defaultRuleHint') }}
      </p>
    </a-card>

    <a-card v-if="!rules.length && !editing" size="small">
      <a-empty :description="t('rules.empty')" />
    </a-card>

    <a-card v-for="(rule, index) in rules" :key="rule.id" size="small">
      <template #title>
        <div class="rule-head">
          <a-checkbox
            :checked="rule.enabled"
            @update:checked="(value: boolean) => onToggle(rule, value)"
          >
            <span class="rule-name">{{ rule.name }}</span>
          </a-checkbox>
          <a-tag class="priority" :bordered="false">
            #{{ index + 1 }}
          </a-tag>
        </div>
      </template>

      <p class="matchers">
        {{ matchersPreview(rule) }}
      </p>

      <p v-if="rule.prompt" class="prompt-preview">
        {{ rule.prompt.split('\n').slice(0, 2).join(' / ') }}
      </p>

      <a-space class="actions" :size="8" wrap>
        <a-button size="small" :disabled="index === 0" @click="move(rule.id, 'up')">
          {{ t('rules.moveUp') }}
        </a-button>
        <a-button size="small" :disabled="index === rules.length - 1" @click="move(rule.id, 'down')">
          {{ t('rules.moveDown') }}
        </a-button>
        <a-button size="small" @click="onEdit(rule)">
          {{ t('common.edit') }}
        </a-button>
        <a-button size="small" danger @click="onDelete(rule)">
          {{ t('common.delete') }}
        </a-button>
      </a-space>
    </a-card>

    <!--
      ============ 新增 / 编辑（弹窗） ============

      ⚠ 与「账号」页同一套：表单不再出现在列表**下方**（那种布局下用户点完
        「编辑」要往下滚才知道发生了什么，而且它会一直留在页面上）。
    -->
    <a-modal
      v-if="editing"
      class="editor"
      :open="true"
      :width="640"
      :get-container="false"
      :mask-closable="false"
      :body-style="{ maxHeight: '62vh', overflowY: 'auto' }"
      centered
      @cancel="cancelEdit"
    >
      <template #title>
        {{ editingExisting ? t('common.edit') : t('rules.add') }}
      </template>

      <a-alert v-if="pageError" class="editor-error" type="error" show-icon :message="pageError" />

      <a-form layout="vertical" class="form">
        <a-form-item :label="t('rules.name')" required>
          <a-input v-model:value="editing.name" :placeholder="t('rules.namePlaceholder')" />
        </a-form-item>

        <a-form-item :label="t('rules.matchers')" required :help="t('rules.matchersHint')">
          <a-textarea
            v-model:value="matcherText"
            :rows="3"
            placeholder="admin@xxx.com&#10;@github.com&#10;/^ci-.*@example\.com$/"
            spellcheck="false"
          />
        </a-form-item>

        <a-form-item :label="t('rules.prompt')" :help="t('rules.promptHint')">
          <a-textarea
            v-model:value="editing.prompt"
            :rows="8"
            :placeholder="t('rules.promptPlaceholder')"
            spellcheck="false"
          />
          <div class="templates">
            <a-button
              v-for="template in TEMPLATES"
              :key="template.label"
              size="small"
              @click="insertTemplate(template.text)"
            >
              <span class="i-pixelarticons-plus" aria-hidden="true" />
              {{ template.label }}
            </a-button>
          </div>
        </a-form-item>

        <a-form-item>
          <a-checkbox v-model:checked="editing.alwaysCopyCode">
            {{ t('rules.alwaysCopyCode') }}
          </a-checkbox>
          <br>
          <a-checkbox v-model:checked="editing.alwaysSkipAd">
            {{ t('rules.alwaysSkipAd') }}
          </a-checkbox>
        </a-form-item>
      </a-form>

      <template #footer>
        <a-space :size="8">
          <a-button @click="cancelEdit">
            {{ t('common.cancel') }}
          </a-button>
          <a-button type="primary" @click="onSave">
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
  max-width: 720px;
}

.header {
  display: flex;
  gap: 8px;
}

/* 按钮里「图标 + 文字」的间距由 `shared.css` 的 `.ant-btn > [class^='i-']` 统一负责 */

/* 内置规则用虚线边 + 灰底：它是「参考项」，不是可以操作的对象 */
.builtin {
  background: var(--mp-surface-2);
  border-style: dashed;
}

.builtin-tag {
  margin-left: 6px;
  font-weight: 400;
}

.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rule-name {
  font-size: 13px;
  font-weight: 600;
}

.priority {
  font-weight: 400;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.matchers {
  margin: 0;
  font-family: var(--mp-font-mono);
  font-size: 11px;
  color: var(--mp-text-dim);
  word-break: break-all;
}

.prompt-preview {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--mp-text-faint);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.form {
  /* 弹窗宽 640，表单不再需要自己的 max-width（那是卡片布局时代留下的） */
  width: 100%;
}

/* 弹窗里顶部那条校验 / 保存失败的提示 */
.editor-error {
  margin-bottom: 12px;
}

.templates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.actions {
  margin-top: 4px;
}

.no-margin {
  margin: 0;
}
</style>
