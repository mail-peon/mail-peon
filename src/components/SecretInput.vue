<script setup lang="ts">
import { ref } from 'vue'

/**
 * 密码 / token 输入框（带「显示」切换）。
 *
 * ⚠ 为什么值得单独一个组件，而不是每处写 `<input type="password">`：
 *
 *   1. **默认不显示明文**，但用户需要能核对刚粘贴的 Key —— 没有切换按钮时，
 *      用户的应对方式是「粘贴到记事本看一眼再粘回来」，而这个过程中 Key 会留在
 *      系统剪贴板历史里。一个眼睛图标能消掉这个坏习惯。
 *   2. 切换按钮必须是 `type="button"`：写在 `<form>` 里的话 `type` 默认是
 *      `submit`，点眼睛会顺手提交表单（在 AI 配置页的表现是「点一下眼睛就保存了」，
 *      而用户还没填完）。
 *   3. `autocomplete="off"` + `spellcheck="false"`：浏览器自动填充会把 API Key
 *      填成保存过的用户名，而拼写检查会在 Key 下面画一排红波浪线。
 */
withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  /** 单行显示（默认）还是多行（refresh token 比较长） */
  rows?: number
}>(), {
  placeholder: '',
  rows: 1,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const revealed = ref(false)
</script>

<template>
  <div class="secret">
    <textarea
      v-if="rows > 1"
      class="input"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      class="input"
      :type="revealed ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholder"
      :spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >
    <button
      class="toggle"
      type="button"
      :title="revealed ? '隐藏' : '显示'"
      @click="revealed = !revealed"
    >
      {{ revealed ? '🙈' : '👁' }}
    </button>
  </div>
</template>

<style scoped>
.secret {
  position: relative;
  display: flex;
  align-items: flex-start;
}

.input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 34px 6px 8px;
  border: 1px solid var(--mp-border-strong);
  border-radius: 6px;
  background: var(--mp-input-bg);
  color: var(--mp-text);
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
}

.input:focus {
  outline: 2px solid var(--mp-accent);
  outline-offset: -1px;
}

.toggle {
  position: absolute;
  top: 2px;
  right: 2px;
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 6px;
  border-radius: 6px;
}

.toggle:hover {
  background: var(--mp-hover);
}
</style>
