import type { AiSettings, AppSettings } from '~/logic/types'
import { ref } from 'vue'
import { send } from './transport'
// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * 设置状态**放在模块作用域**，所有 `useSettings()` 调用共用同一份。
 *
 * ⚠⚠ 这不是省内存，是修一个真机问题：「切了模式要刷新页面才生效」。
 *
 *   原来这两个 ref 是在 `useSettings()` **里面**创建的 —— 也就是
 *   **每个组件各拿一份**。于是「通用」页里拨一下模式开关：
 *
 *     - `GeneralPage` 自己那份 `app` 被乐观更新了（它看起来立刻生效了）；
 *     - 但 `Options.vue` 那份没变 ⇒ 左侧导航里该隐藏的「提示词 / 屏蔽列表」
 *       还在、该出现的也不出现；`RulesPage` / `BlockedPage` 同理；
 *     - 停在隐藏页面上的路由校正（`Options.vue` 的 `watch(minimalMode)`）也不会触发。
 *
 *   刷新页面才生效，是因为刷新会重新 `reload()` 一遍 —— 也就是「每份副本各拉一次」。
 *
 *   同一份状态之后，同一个页面里的所有组件天然是同步的（Vue 的响应式负责重渲染），
 *   跨页面（Popup / Sidepanel / 另一个设置页）由 background 的
 *   `settings:changed` 广播补齐 —— 见 `installBridgeListener()`。
 */
export const settingsApp = ref<AppSettings | null>(null)

export const settingsAi = ref<AiSettings | null>(null)

/**
 * 上一次 `reload()` 是不是**失败**了（没拿到设置）。
 *
 * ⚠ 为什么必须有这个信号：`send` 失败时**不抛错**，只返回调用方给的兜底值 ——
 *   而这里的兜底是 `app: null`。于是「还在加载」和「加载失败」在
 *   `app.value === null` 上长得一模一样，界面只能选择一直转圈。
 *
 *   真机上的表现就是：后台异常 / 消息超时的时候，设置页是一个**永远转不完的圈**，
 *   没有错误、没有重试、也没有任何可查的线索（只有 console 里一行 warn）。
 *   有了这个 ref，界面才能把「失败」和「加载中」分开画。
 */
export const settingsLoadFailed = ref(false)

export function useSettings() {
  const app = settingsApp
  const ai = settingsAi

  /** @returns 是否真的拿到了设置（失败时 `false`，调用方可以据此提示 / 重试） */
  async function reload(): Promise<boolean> {
    const result = await send<{ app: AppSettings, ai: AiSettings }>('settings:get', undefined, {
      app: null as unknown as AppSettings,
      ai: null as unknown as AiSettings,
    })
    if (result?.app)
      app.value = result.app
    if (result?.ai)
      ai.value = result.ai

    const ok = Boolean(result?.app)
    settingsLoadFailed.value = !ok
    return ok
  }

  async function setApp(patch: Partial<AppSettings>) {
    // 乐观更新：开关点下去要立刻有反应，等 background 往返会有一帧的迟滞
    if (app.value)
      app.value = { ...app.value, ...patch }
    const result = await send<{ app: AppSettings } | null>('settings:set-app', { patch }, null)
    if (result?.app)
      app.value = result.app
  }

  async function setAi(patch: Partial<AiSettings>) {
    if (ai.value)
      ai.value = { ...ai.value, ...patch }
    const result = await send<{ ai: AiSettings } | null>('settings:set-ai', { patch }, null)
    if (result?.ai)
      ai.value = result.ai
  }

  return { app, ai, loadFailed: settingsLoadFailed, reload, setApp, setAi }
}
