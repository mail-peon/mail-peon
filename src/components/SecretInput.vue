<script setup lang="ts">
/**
 * 密码 / token 输入框（带「显示」切换）。
 *
 * ⚠ 为什么值得单独一个组件，而不是每处写 `<a-input type="password">`：
 *
 *   1. **默认不显示明文**，但用户需要能核对刚粘贴的 Key —— 没有切换按钮时，
 *      用户的应对方式是「粘贴到记事本看一眼再粘回来」，而这个过程中 Key 会留在
 *      系统剪贴板历史里。一个眼睛图标能消掉这个坏习惯。
 *   2. `autocomplete="off"` + `spellcheck="false"`：浏览器自动填充会把 API Key
 *      填成保存过的用户名，而拼写检查会在 Key 下面画一排红波浪线。
 *
 * 走 antd 的 `Input.Password`：它的眼睛按钮是**内置**的
 * （`/es/input/Password.js` 用 `@ant-design/icons-vue` 的 Eye 图标），
 * 不用自己写一个绝对定位的按钮，也就没有「点眼睛顺手提交表单」那个老问题。
 *
 * ⚠ 这里**曾经**有一个 `rows > 1` 的多行分支（配一个自己写的眼睛按钮）。
 *   删掉它有两个理由，都成立：
 *
 *   1. **没有任何调用点**传过 `rows` —— 两处用法（账号页的密码字段、AI 页的 Key）
 *      都是单行；
 *   2. 更要紧的是它**在说谎**：那个按钮只切换 `revealed`（换个图标），
 *      而 `a-textarea` 始终是明文的 —— 一个「点一下以为藏起来了、其实没有」的
 *      密码框，比没有这个按钮危险得多。
 *
 *   真需要多行时应当重新写一个**真的会掩码**的实现（`a-textarea` 不支持，
 *   得自己做），而不是留着这个。
 */
withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), {
  placeholder: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <a-input-password
    class="secret"
    :value="modelValue"
    :placeholder="placeholder"
    :spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    @update:value="emit('update:modelValue', $event)"
  />
</template>

<style scoped>
.secret {
  width: 100%;
}
</style>
