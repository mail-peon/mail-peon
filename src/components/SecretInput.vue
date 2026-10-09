<script setup lang="ts">
import { ref } from 'vue'

/**
 * 密码 / token 输入框（带「显示」切换）。
 *
 * ⚠ 为什么值得单独一个组件，而不是每处写 `<a-input type="password">`：
 *
 *   1. **默认不显示明文**，但用户需要能核对刚粘贴的 Key —— 没有切换按钮时，
 *      用户的应对方式是「粘贴到记事本看一眼再粘回来」，而这个过程中 Key 会留在
 *      系统剪贴板历史里。一个眼睛图标能消掉这个坏习惯。
 *   2. 多行（refresh token 很长，一行看不全）要能换行看。
 *   3. `autocomplete="off"` + `spellcheck="false"`：浏览器自动填充会把 API Key
 *      填成保存过的用户名，而拼写检查会在 Key 下面画一排红波浪线。
 *
 * 单行走 antd 的 `Input.Password`：它的眼睛按钮是**内置**的
 * （`/es/input/Password.js` 用 `@ant-design/icons-vue` 的 Eye 图标），
 * 不用自己写一个绝对定位的按钮，也就没有「点眼睛顺手提交表单」那个老问题
 * （那曾是 `type="button"` 必须写的原因）。
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
  <a-input-password
    v-if="rows <= 1"
    class="secret"
    :value="modelValue"
    :placeholder="placeholder"
    :spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    @update:value="emit('update:modelValue', $event)"
  />

  <!--
    多行：`a-textarea` 没有内置的「显示 / 隐藏」开关，所以这里自己放一个。
    ⚠ 按钮是 `type="button"` 的纯按钮（antd 的 `a-button`），
      不会像原生 `<button>` 那样在 `<form>` 里默认变成 submit。
  -->
  <div v-else class="secret-textarea">
    <a-textarea
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @update:value="emit('update:modelValue', $event)"
    />
    <a-button class="toggle" size="small" type="text" :title="revealed ? '隐藏' : '显示'" @click="revealed = !revealed">
      <span :class="revealed ? 'i-pixelarticons-eye-off' : 'i-pixelarticons-eye'" aria-hidden="true" />
    </a-button>
  </div>
</template>

<style scoped>
.secret {
  width: 100%;
}

.secret-textarea {
  position: relative;
  display: flex;
  width: 100%;
}

/* 按钮贴在文本框右上角 */
.toggle {
  position: absolute;
  top: 2px;
  right: 2px;
}

/*
 * ⚠ 这是个**只有图标**的按钮，所以要把 `shared.css` 给「图标 + 文字」留的
 *   右边距归零 —— 否则图标会被推得偏左（看起来像没对齐）。
 */
.toggle [class^='i-'] {
  margin-inline-end: 0;
}
</style>
