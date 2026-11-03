<script setup lang="ts">
import type { useAccountFields } from '../../composables/useAccountFields'
import SecretInput from '~/components/SecretInput.vue'

const props = defineProps<{ fields: ReturnType<typeof useAccountFields>, provider: string, authorizing: boolean }>()
const emit = defineEmits<{ authorize: [] }>()
const { currentProvider, fieldBool, fieldValue, fieldNumber, setField, onToggleUpdate, onNumberUpdate, hostSelectValue, hostSelectOptions, onFieldSelectUpdate, presetNote, isCustomHost } = props.fields
</script>

<template>
  <!-- 协议可用性提示：走不通的路要提前说，而不是等「测试连接」报一个看不懂的错 -->
  <a-alert
    v-if="currentProvider && currentProvider.availability !== 'ready'"
    class="notice"
    type="warning"
    show-icon
    :message="currentProvider.availabilityNote"
  >
    <!--
            「去哪儿拿中继」放在这条黄条的 description 里 —— 用户读到
            「需要本机中继」的**下一句**就该是「点这里下载」，中间不该隔别的内容。

            文字链而不是主按钮：这是个**可选安装**动作（Gmail / 已有中继的用户不需要），
            不该跟表单底部的【保存】抢视觉重量。
          -->
    <template v-if="currentProvider.downloadHint" #description>
      <a
        :href="currentProvider.downloadHint.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ currentProvider.downloadHint.text }}
      </a>
    </template>
  </a-alert>

  <!-- 字段由 provider 声明生成 -->
  <template v-for="field in currentProvider?.fields ?? []" :key="field.key">
    <a-form-item v-if="field.type === 'toggle'" :data-field-key="String(field.key)" :label="field.label">
      <a-switch
        :checked="fieldBool(field.key)"
        @update:checked="(value) => onToggleUpdate(field.key, value)"
      />
    </a-form-item>

    <a-form-item
      v-else-if="field.type === 'password'"
      :data-field-key="String(field.key)"
      :label="field.label"
      :required="field.required"
    >
      <SecretInput
        :model-value="fieldValue(field.key)"
        :placeholder="field.placeholder"
        @update:model-value="setField(field.key, $event)"
      />
    </a-form-item>

    <a-form-item
      v-else-if="field.type === 'number'"
      :data-field-key="String(field.key)"
      :label="field.label"
      :required="field.required"
    >
      <a-input-number
        class="control"
        :value="fieldNumber(field.key) ?? undefined"
        :min="1"
        :placeholder="field.placeholder"
        @update:value="(value) => onNumberUpdate(field.key, value)"
      />
    </a-form-item>

    <a-form-item v-else-if="field.presets" :data-field-key="String(field.key)" :label="field.label" :required="field.required">
      <!--
              下拉挑常用服务器，最后一条「自定义…」切出输入框自己填。

              ⚠ 为什么不用 `a-auto-complete`（下拉 + 自由输入是一个控件）：
                它对用户是「看起来就是个普通输入框」，不点不知道有列表；
                而且「已选的是预设还是自己填的」在数据上分不出来
                （都只是 host 字符串），回显已有账号时会显示成空白。
                拆成 select + 条件输入框，两种状态各自明确。

              ⚠ 选预设时 `onHostSelect` 会把 host / port / tls **一起**回填 ——
                用户看到 host 变了，端口与加密一并对齐，不会「改了 host 忘了改 port」。
            -->
      <div class="host-field">
        <a-select
          :value="hostSelectValue(field.key)"
          :placeholder="field.placeholder ?? '请选择'"
          :options="hostSelectOptions(field)"
          @change="(value) => onFieldSelectUpdate(field.key, value)"
        >
          <!-- 副标题（「需用授权码」这类避坑提示）按 value 反查，见 presetNote -->
          <template #option="item">
            <div class="preset-option">
              <span class="preset-option__label">{{ item.label }}</span>
              <span v-if="presetNote(field, item.value)" class="preset-option__note">
                {{ presetNote(field, item.value) }}
              </span>
            </div>
          </template>
        </a-select>

        <a-input
          v-if="isCustomHost(field.key)"
          :value="fieldValue(field.key)"
          placeholder="mail.example.com"
          spellcheck="false"
          @update:value="(value: string) => setField(field.key, value)"
        />
      </div>
    </a-form-item>

    <a-form-item v-else :data-field-key="String(field.key)" :label="field.label" :required="field.required">
      <a-input
        :value="fieldValue(field.key)"
        :placeholder="field.placeholder"
        spellcheck="false"
        @update:value="(value: string) => setField(field.key, value)"
      />
    </a-form-item>

    <!-- Gmail 专属：一键授权 -->
    <div v-if="field.key === 'refreshToken' && provider === 'gmail'" class="oauth">
      <a-button :loading="authorizing" @click="emit('authorize')">
        {{ authorizing ? '授权中…' : '使用 Google 授权' }}
      </a-button>
      <span class="mp-hint">
        需要先在 Google Cloud 建一个「Chrome 扩展」类型的 OAuth 客户端，
        并把此扩展的授权回调地址加进重定向白名单。
      </span>
    </div>
  </template>
</template>

<style scoped>
/* 下拉 / 数字输入不要撑满整行（撑满看起来像「随便填点什么」的文本框） */
.control {
  max-width: 260px;
}

.notice {
  margin-bottom: 14px;
}

.oauth {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 14px;
}

/*
 * 预设下拉的选项：邮箱名 + 一行避坑提示。
 * 提示用更小更暗的字 —— 它重要但**不必**抢过邮箱名本身。
 */
.preset-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.35;
}

.preset-option__label {
  font-size: 13px;
}

.preset-option__note {
  color: var(--mp-text-faint);
  font-size: 11px;
}

/*
 * 预设下拉 + 自定义输入框竖排。
 * 选了「自定义…」时输入框出现在下拉**下面** —— 而不是替换掉下拉，
 * 这样用户还能直接改主意换回某家预设，不用先清空。
 */
.host-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
