<script setup lang="ts">
import type { PromptRule } from '~/logic/types'
import { onMounted, ref } from 'vue'
import { useRules } from '~/logic/bridge'
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

onMounted(reload)

function newRule() {
  const now = Date.now()
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

const matcherText = ref('')

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
  editing.value = null
  matcherText.value = ''
}

async function onDelete(rule: PromptRule) {
  // Options 页里的不可撤销操作走原生 confirm（理由见 GeneralPage.vue 的 confirmOrAbort）
  // eslint-disable-next-line no-alert
  if (!window.confirm(`确定删除规则「${rule.name}」吗？`))
    return
  await remove(rule.id)
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
      <button class="mp-btn mp-btn-primary" type="button" @click="newRule">
        {{ t('rules.add') }}
      </button>
    </div>

    <p v-if="pageError" class="mp-error">
      {{ pageError }}
    </p>

    <!-- 内置默认规则：只展示，不可编辑（它由 createDefaultRule() 现造，不落库） -->
    <div class="mp-card builtin">
      <div class="rule-head">
        <span class="rule-name">{{ t('rules.defaultRule') }}</span>
        <span class="mp-badge">兜底</span>
      </div>
      <p class="mp-hint">
        {{ t('rules.defaultRuleHint') }}
      </p>
    </div>

    <div v-if="!rules.length && !editing" class="mp-card empty">
      {{ t('rules.empty') }}
    </div>

    <div v-for="(rule, index) in rules" :key="rule.id" class="mp-card rule">
      <div class="rule-head">
        <label class="mp-checkbox">
          <input
            type="checkbox"
            :checked="rule.enabled"
            @change="onToggle(rule, ($event.target as HTMLInputElement).checked)"
          >
          <span class="rule-name">{{ rule.name }}</span>
        </label>
        <span class="priority">#{{ index + 1 }}</span>
      </div>

      <p class="matchers">
        {{ rule.matchers.map(item => (item.kind === 'domain' ? `@${item.value}` : item.kind === 'regex' ? `/${item.value}/` : item.value)).join('  ') }}
      </p>

      <p v-if="rule.prompt" class="prompt-preview">
        {{ rule.prompt.split('\n').slice(0, 2).join(' / ') }}
      </p>

      <div class="actions">
        <button class="mp-btn" type="button" :disabled="index === 0" @click="move(rule.id, 'up')">
          {{ t('rules.moveUp') }}
        </button>
        <button class="mp-btn" type="button" :disabled="index === rules.length - 1" @click="move(rule.id, 'down')">
          {{ t('rules.moveDown') }}
        </button>
        <button class="mp-btn" type="button" @click="onEdit(rule)">
          {{ t('common.edit') }}
        </button>
        <button class="mp-btn mp-btn-danger" type="button" @click="onDelete(rule)">
          {{ t('common.delete') }}
        </button>
      </div>
    </div>

    <!-- 编辑表单 -->
    <div v-if="editing" class="mp-card">
      <p class="mp-section-title">
        {{ rules.some(item => item.id === editing!.id) ? t('common.edit') : t('rules.add') }}
      </p>

      <div class="form">
        <label class="mp-field">
          <span class="mp-field-label">规则名<span class="req">*</span></span>
          <input v-model="editing.name" class="mp-input" :placeholder="t('rules.namePlaceholder')">
        </label>

        <label class="mp-field">
          <span class="mp-field-label">匹配<span class="req">*</span></span>
          <textarea
            v-model="matcherText"
            class="mp-textarea"
            rows="3"
            placeholder="admin@xxx.com&#10;@github.com&#10;/^ci-.*@example\.com$/"
            spellcheck="false"
          />
          <span class="mp-hint">{{ t('rules.matchersHint') }}</span>
        </label>

        <div class="mp-field">
          <span class="mp-field-label">{{ t('rules.prompt') }}</span>
          <textarea
            v-model="editing.prompt"
            class="mp-textarea"
            rows="8"
            :placeholder="t('rules.promptPlaceholder')"
            spellcheck="false"
          />
          <span class="mp-hint">{{ t('rules.promptHint') }}</span>
          <div class="templates">
            <button
              v-for="template in TEMPLATES"
              :key="template.label"
              class="mp-btn"
              type="button"
              @click="insertTemplate(template.text)"
            >
              + {{ template.label }}
            </button>
          </div>
        </div>

        <label class="mp-checkbox">
          <input v-model="editing.alwaysCopyCode" type="checkbox">
          <span>{{ t('rules.alwaysCopyCode') }}</span>
        </label>

        <label class="mp-checkbox">
          <input v-model="editing.alwaysSkipAd" type="checkbox">
          <span>{{ t('rules.alwaysSkipAd') }}</span>
        </label>
      </div>

      <div class="actions">
        <button class="mp-btn mp-btn-primary" type="button" @click="onSave">
          {{ t('common.save') }}
        </button>
        <button class="mp-btn" type="button" @click="editing = null; matcherText = ''">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
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

.empty {
  color: var(--mp-text-faint);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}

.builtin {
  background: var(--mp-surface-2);
  border-style: dashed;
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
  font-size: 11px;
  color: var(--mp-text-faint);
}

.matchers {
  margin: 6px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--mp-text-dim);
  word-break: break-all;
}

.prompt-preview {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--mp-text-faint);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.templates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.req {
  color: var(--mp-danger);
  margin-left: 2px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
</style>
