declare const __DEV__: boolean
/** Extension name, defined in packageJson.name */
declare const __NAME__: string

/*
 * ⚠ 这里**故意没有** `declare module '*.vue'`。
 *
 *   那个 shim（模板项目通常自带）把每个 `.vue` 的默认导出声明成 `any`，于是
 *   「父组件传错 props」「.vue 里用了不存在的字段」这类问题在编译期全部消失 ——
 *   而 `tsc` 本身也不解析 SFC，结果是**整个 UI 层没有任何类型门禁**。
 *
 *   代价是真金白银的：TrashPage 曾把一个 `useTrash()` 并不返回的 `trash`
 *   当成函数调用（点了必崩），AccountsPage 的本地 `ProviderOption` 少声明了
 *   `presets`（预设下拉整个失效）—— 两处都只会在运行时暴露。
 *
 *   现在 `pnpm typecheck` 走 `vue-tsc`（见 package.json），它能真正读 SFC，
 *   shim 自然也就该删掉。
 */
