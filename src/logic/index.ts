/**
 * `logic/` 的公共导出。
 *
 * ⚠ 刻意**很薄**：各模块的导出已经足够清晰（`logic/types` / `logic/store/...` /
 * `logic/ai/...`），把几十个符号都从这一个文件里转出去，只会让
 * 「这个函数住在哪」变成一个需要跳两层的谜题，也会让 tree-shaking 更难判断。
 *
 * 模板自带的 `composables/useWebExtensionStorage` 已不再用于业务
 * （见 `ai-docs/01-architecture.md § 2`：MVP 改用 IndexedDB），
 * 所以这里没有它的转发 —— 保留它只是为了让模板的 composable 还能被参考。
 */

export { t } from './strings'
export * from './types'
