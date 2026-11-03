import { onMessage } from 'webext-bridge/background'
import { AI_PLATFORM_OPTIONS } from '~/adapters/ai/platforms'
import { mailProviderOptionPayloads } from '~/adapters/mail/registry'
import { testAiConnection } from '~/logic/ai/summarize'

export function registerMetadataHandlers() {
// ---------------------------------------------------------------------------
// 消息：AI 与协议元数据
// ---------------------------------------------------------------------------

  onMessage('ai:test', async ({ data }) => {
    return testAiConnection(data.ai)
  })

  onMessage('ai:platforms', async () => {
    return { platforms: AI_PLATFORM_OPTIONS }
  })

  /**
   * 让 Options 动态渲染「新增账号」表单。
   *
   * 返回的是完整的 `fields` 声明 —— 于是「加了一家 provider 但设置页没有它的字段」
   * 在结构上不可能发生：表单是**读声明渲染**的，不是写死的。
   *
   * ⚠ 实际拼装放在 `mailProviderOptionPayloads()`（`adapters/mail/registry.ts`）。
   *   以前这里是一段**逐个字段手抄的白名单**，漏了 `presets`，导致 IMAP 的
   *   13 个服务器预设到了界面就没了 —— 详见那个函数上的注释。
   *   挪出去同时也是为了能被单测覆盖（本文件一 import 就注册监听器，没法单独测）。
   */
  onMessage('mail:providers', async () => {
    return { providers: mailProviderOptionPayloads() }
  })
}
