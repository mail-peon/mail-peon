/**
 * 「按目录约定收集适配器」的共用实现。
 *
 * 插件里有**两处**同构的可扩展点：邮箱协议（`adapters/mail/providers`）与 AI 平台
 * （`adapters/ai/platforms`）。它们的注册表都是同一件事：
 *
 *   1. `import.meta.glob` 扫出目录里的入口模块
 *   2. 按路径排序（顺序稳定，不依赖文件系统的返回顺序）
 *   3. 取出导出，拼成数组
 *
 * 抄第二遍的时候没人会记得「顺序必须稳定」这条约定，而它一旦丢失，症状是
 * 设置页下拉框的**顺序在两次启动之间会变** —— 很难联想到是 glob 的锅。
 *
 * ⚠ 从这里拆成两个函数（`default` / 具名），是因为两处扩展点的模块写法不同：
 *   - AI 平台：`export default defineAiPlatform({ … })`
 *   - 邮箱 provider：模块要同时导出 `definition` **和** `create` 两个具名导出
 *     （挂在默认导出的对象上也能写，但那样 `import.meta.glob` 的类型推断会
 *     退化成一堆 `unknown`）。两种写法各配一个收集器，类型都是准的。
 *
 * ⚠ 这两个函数**不依赖 Vite 也不依赖运行时**：`import.meta.glob` 的调用留在各自的
 *   注册表里（那是编译期特性，必须写在会被 Vite 处理的文件中），这里只做纯数据加工。
 */

/** 一个 glob 结果：路径 → 模块 */
export type AdapterModules<T> = Record<string, T>

/** 按路径排序（顺序稳定） */
function sortByPath<T>(modules: AdapterModules<T>): T[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mod]) => mod)
}

/** 收集「默认导出即适配器」的模块 */
export function collectDefaultAdapters<T>(modules: AdapterModules<{ default: T }>): T[] {
  return sortByPath(modules).map(mod => mod.default)
}

/** 收集「具名导出即适配器」的模块 */
export function collectNamedAdapters<T>(modules: AdapterModules<T>): T[] {
  return sortByPath(modules)
}

/**
 * 兼容别名：等同 `collectDefaultAdapters`（AI 平台注册表用）。
 *
 * 保留旧名字是因为「collect」这个调用点读起来更顺；两个名字指向同一份实现，
 * 不存在「两份排序逻辑迟早分叉」的问题。
 */
export const collectAdapters = collectDefaultAdapters
