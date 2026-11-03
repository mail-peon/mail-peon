<script setup lang="ts">
import type { useAccountFields } from '../../composables/useAccountFields'
import type { AccountBusyKind, AccountStatus } from '../../pages/accounts-status'
import type { MailAccount } from '~/logic/types'
import { nextTick, ref } from 'vue'
import { t } from '~/logic/strings'
import AccountProviderFields from './AccountProviderFields.vue'

const props = defineProps<{ fields: ReturnType<typeof useAccountFields>, title: string, status?: AccountStatus, error: string, clipboardCandidate: string | null, authorizing: boolean, busy?: AccountBusyKind }>()
const emit = defineEmits<{ close: [], save: [], test: [], authorize: [], applyClipboard: [], dismissClipboard: [] }>()
const editing = defineModel<MailAccount>('account', { required: true })
const { currentProvider, providerOptions, onProviderChange, fieldValue } = props.fields
const formRef = ref<{ $el?: HTMLElement } | null>(null)
/**
 * 校验失败 → 把那个字段**滚到眼前**并聚焦。
 *
 * ⚠ 为什么需要它：弹窗的字段区是 `max-height: 60vh; overflow-y: auto`，
 *   而错误文案只出现在顶部一行 —— 「请填写『WebSocket 中继地址』」
 *   很可能指向一个**当前不在视口里**的字段，用户只能自己一栏栏找。
 *
 * ⚠ 为什么不用 antd 的 `form.scrollToField()`：那个 API 要求每个 `a-form-item`
 *   都带 `name`，而**只加 `name` 不加 `:model`** 会让 antd 启用它自己的校验 ——
 *   实测控制台会刷出一片 `async-validator: '${name}' is required`
 *   （表单没有 model，所有字段对它都是 undefined），界面上可能跟着冒红字。
 *   我们本来就是**手写校验**，没必要为此把整张表单切到 antd 的受控模型上。
 *
 *   所以用 `data-field-key` 自己定位：代价一次 `querySelector`，
 *   好处是完全不动 antd 的表单语义。
 */
function revealField(key: string): void {
  void nextTick(() => {
    const host = formRef.value?.$el
    if (!host)
      return

    const item = host.querySelector<HTMLElement>(`[data-field-key="${key}"]`)
    if (!item)
      return

    item.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 顺带把焦点送进去：键盘用户可以直接开始改，不用再 Tab 一圈
    item.querySelector<HTMLElement>('input, textarea, .ant-select-selector')?.focus()
  })
}
defineExpose({ revealField })
</script>

<template>
  <a-modal
    class="editor"
    :open="true"
    :width="560"
    :get-container="false"
    :mask-closable="false"
    :body-style="{ maxHeight: '60vh', overflowY: 'auto' }"
    centered
    @cancel="emit('close')"
  >
    <!--
        标题行：左边「新增 / 编辑账号」，右边这个账号的连接状态。
        ⚠ 与列表卡片保持一致 —— 编辑一个正在报错的账号时，那一目了然的状态不该消失。
        ⚠ `padding-right` 是给右上角的关闭按钮让位（它是绝对定位的）。
      -->
    <template #title>
      <div class="editor-title">
        <span>{{ title }}</span>
        <StatusBadge v-bind="status" />
      </div>
    </template>

    <!--
        ⚠ 校验/授权失败留在弹窗里（而不是弹一个全局 message）：
          它要跟出错的那个输入框待在一起，而且用户改的时候必须还看得见 ——
          toast 会在两三秒后消失，那时他可能还在改。
      -->
    <a-alert v-if="error" class="editor-error" type="error" show-icon :message="error" />

    <!--
        剪贴板里有中继地址候选 —— 用户刚才在 peon-hall 点过「复制扩展地址」。
        见 `clipboard-relay.ts` 的说明：「提示 + 按钮」而不是「自动填入」。

        只在 IMAP 协议下显示 —— Gmail 不走中继，填了反而误导。
        只在 relayUrl 字段为空时显示 —— 已经有值的话别覆盖。
      -->
    <a-alert
      v-if="clipboardCandidate && editing.provider === 'imap' && !fieldValue('relayUrl')"
      class="clipboard-prompt"
      type="info"
      show-icon
      :message="`剪贴板里有中继地址：${clipboardCandidate}`"
    >
      <template #description>
        <a-space :size="8">
          <a-button size="small" type="primary" @click="emit('applyClipboard')">
            填入
          </a-button>
          <a-button size="small" @click="emit('dismissClipboard')">
            不用
          </a-button>
        </a-space>
      </template>
    </a-alert>

    <a-form ref="formRef" layout="vertical" class="form">
      <a-form-item data-field-key="label" :label="t('accounts.label')">
        <a-input v-model:value="editing.label" :placeholder="t('accounts.labelPlaceholder')" />
      </a-form-item>

      <a-form-item data-field-key="email" :label="t('accounts.email')">
        <a-input v-model:value="editing.email" :placeholder="t('accounts.emailPlaceholder')" type="email" />
      </a-form-item>

      <a-form-item data-field-key="provider" :label="t('accounts.provider')" :help="currentProvider?.hint">
        <a-select
          class="control"
          :value="editing.provider"
          :options="providerOptions"
          @update:value="onProviderChange"
        />
      </a-form-item>

      <AccountProviderFields :fields="fields" :provider="editing.provider" :authorizing="authorizing" @authorize="emit('authorize')" />

      <a-form-item>
        <a-checkbox v-model:checked="editing.enabled">
          {{ t('accounts.enableLabel') }}
        </a-checkbox>
      </a-form-item>
    </a-form>

    <!--
        底部按钮。顺序：诊断动作（测试连接）靠左，取消 / 保存靠右 ——
        「保存」在最右是 antd 的约定（主操作在最外侧）。
      -->
    <template #footer>
      <div class="editor-footer">
        <a-button :loading="busy === 'test'" @click="emit('test')">
          {{ t('accounts.test') }}
        </a-button>
        <span class="editor-footer-spacer" />
        <a-button @click="emit('close')">
          {{ t('common.cancel') }}
        </a-button>
        <a-button type="primary" @click="emit('save')">
          {{ t('common.save') }}
        </a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.form {
  max-width: 520px;
}

/*
 * 弹窗标题行：左边标题、右边连接状态。
 * ⚠ `padding-right: 28px` 给右上角的关闭按钮让位（它是绝对定位的，会盖住内容）。
 */
.editor-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 28px;
}

.editor-error {
  margin-bottom: 12px;
}

.clipboard-prompt {
  margin-bottom: 12px;
}

/* 底部：诊断动作用左，取消 / 保存靠右 */
.editor-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-footer-spacer {
  flex: 1 1 auto;
}

/* 弹窗里的状态词与列表卡片保持同样的字号 */
.editor :deep(.ant-badge-status-text) {
  font-size: 12px;
  color: var(--mp-text-dim);
}

.control { max-width: 260px; }
</style>
