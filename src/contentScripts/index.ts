import { onMessage } from 'webext-bridge/content-script'
import { showToast, updateToast } from './toast'

/**
 * Content Script 入口（每个页面一个实例）。
 *
 * 职责**只有两件**（`ai-docs/01-architecture.md § 1` 的规则）：
 *
 *   1. 渲染页面顶部 toast（shadow DOM 隔离）
 *   2. 在页面 focus 上下文里执行 `clipboard.writeText`
 *
 * ⚠ 刻意**不**在这里做任何业务判断（该不该弹、验证码是什么、要不要入库）：
 *   那些都在 background。内容脚本跑在**不可信页面**里 —— 页面的 JS 与我们的脚本
 *   共享同一个 JS 堆，任何放在这里的凭据或业务规则都可能被页面读到。
 *
 * 模板自带的 Vue 挂载已经移除：它会在每个页面渲染一个可见的 `<div id="vitesse-webext">`，
 * 而我们现在只需要 toast（懒创建，空闲时零 DOM）。
 */

/** 页面级去重：同一封邮件在同一页面里重复到达时只更新，不叠加 */
const recentlyToasted = new Set<string>()

onMessage('mail:toast', ({ data }) => {
  if (!data?.mailId || !data.code)
    return

  if (recentlyToasted.has(data.mailId)) {
    updateToast(data)
    return
  }
  recentlyToasted.add(data.mailId)
  // 集合会无限增长（一个页面开一整天的话）；超过 200 条时清掉最老的几个。
  // 不做这件事的代价不是内存，而是**同一封邮件被重发时不再弹 toast** ——
  // 用户会遇到「有时候弹有时候不弹」
  if (recentlyToasted.size > 200) {
    const drop = [...recentlyToasted].slice(0, 100)
    for (const id of drop)
      recentlyToasted.delete(id)
  }

  showToast(data)
})

/**
 * 复制验证码。
 *
 * 两处都会调到这里：background 的自动复制降级（SW 里 `writeText` 失败时），
 * 以及 toast 上的「点击复制」按钮。**共用同一个 handler** 是为了让行为一致 ——
 * 分开实现的话，一条路成功、另一条失败，而用户看不出区别。
 *
 * 返回值决定调用方怎么处理：`{ ok: false }` 时 background 会把 `copyStatus`
 * 记成 `'failed'`，UI 上显示「点击复制」。
 */
onMessage('mail:copy-code', async ({ data }) => {
  try {
    await navigator.clipboard.writeText(data.code)
    return { ok: true }
  }
  catch (error) {
    console.warn('[mail-peon] 页面内写入剪贴板失败', error)
    return { ok: false }
  }
})

/**
 * PDF / XML / 图片等文档没有 `document.body`，toast 挂不上。
 *
 * 这里只在收到消息时才会被调到（`ensureContainer` 会返回 null 并静默跳过），
 * 所以不需要在入口做页面类型判断 —— 那种判断（`document.contentType`）
 * 在页面导航过程中并不可靠。
 */
