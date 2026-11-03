import { onMessage } from 'webext-bridge/background'
import { recordManualCopy } from '~/logic/ai/pipeline'
import { broadcastToExtension } from '~/logic/messaging'
import { clearBadge, refreshBadge } from '~/logic/notification/badge'
import { dismissMail, markAllRead, readRecentMails, setMailRead } from '~/logic/store/mails'
import { ensureStoreReady } from '~/logic/store/ready'
import { copyViaContentScript } from '../clipboard'

export function registerMailHandlers() {
  /**
   * ⚠ **不**开 `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`。
   *
   * 它与「点击图标打开 Popup」互斥，而设计文档要求的是后者
   * （`features/02-ai-summary.md § 6.3`：「Chrome 默认行为就是打开 popup」）。
   * 开了的话 Popup 永远不会出现，而 Popup 是极简模式的主要界面。
   * 侧边栏仍然可用：权限与 `side_panel.default_path` 已在 manifest 里，
   * 用户可以从浏览器的侧边栏菜单打开。
   */

  // ---------------------------------------------------------------------------
  // 消息：邮件
  // ---------------------------------------------------------------------------

  onMessage('mail:list', async ({ data }) => {
    await ensureStoreReady()
    /*
     * ⚠ 计时。`mail:list` 是 Popup 打开时的**第一条**消息，也是它渲染列表的前提 ——
     *   如果它慢，界面就一直停在「加载中…」。
     *
     *   真机上出现过「background 已经入库，Popup 十几秒后才显示」，
     *   而链路上有三个可疑点（读库 / 标记已读 / 消息往返），
     *   没有计时就只能猜。这一行把它们分开。
     */
    const started = Date.now()
    const mails = await readRecentMails(data?.limit ?? 200)
    const elapsed = Date.now() - started
    if (elapsed > 200)
      console.warn(`[mail-peon] mail:list 读库慢：${mails.length} 条用了 ${elapsed}ms`)
    return { mails }
  })

  /*
   * ⚠ 这里**曾经**有一个 `mail:get` handler（按 id 取单封邮件）。
   *   删掉的理由：**全项目没有任何发送方** —— 界面要列表就整表拿（`mail:list`），
   *   要单封就在拿到的那份数据里找，从来没有按 id 单独取过。
   *
   *   留着它的代价不是几行代码，而是它看起来像一条可用的通道：
   *   下一个人会以为「已经有人按 id 取邮件了」，于是照着它写调用方，
   *   而那条路从来没被跑过、也没被测过。
   */

  onMessage('mail:dismiss', async ({ data }) => {
    await ensureStoreReady()

    if (data.dismissed)
      await dismissMail(data.mailId)
    else if (data.read !== undefined)
      await setMailRead(data.mailId, data.read)

    // badge 依赖 read / dismissed，改完必须重算
    await refreshBadge()
    broadcastToExtension('mail:updated', { mailId: data.mailId })
    return { ok: true as const }
  })

  onMessage('mail:mark-all-read', async () => {
    await ensureStoreReady()
    /*
     * ⚠ 计时。这个 handler 在 **Popup 每次打开时**都会跑，而它做的是
     *   「读最多 1000 条 + 在一个事务里把所有未读改写成已读」。
     *
     *   它是整条打开链路里唯一的重活，所以最可能是「Popup 十几秒才显示」的原因 ——
     *   因为它与 `mail:list` **并发**跑，两者抢同一个 IndexedDB 连接。
     */
    const started = Date.now()
    const count = await markAllRead()
    // 打开 Popup = 用户看了，badge 归零（设计文档 `ui-flows.md § 3.1`）
    await clearBadge()
    const elapsed = Date.now() - started
    if (elapsed > 200)
      console.warn(`[mail-peon] 标记全部已读慢：${count} 条用了 ${elapsed}ms`)
    return { ok: true as const, count }
  })

  /**
   * 「复制验证码」的**回退通道**。
   *
   * ⚠ 正常情况下**不会走到这里** —— 弹窗 / 侧边栏自己就是 focused 文档，
   *   它们直接调 `navigator.clipboard.writeText`（几乎必然成功）。
   *   只有在那边写失败时（失焦、权限被策略禁用、某些 Linux 桌面）
   *   UI 才把活派过来，让内容脚本再试一次。
   *
   * ⚠ 这里**不写 `copyStatus`**。
   *   用户手动点一下复制**不是持久状态** —— 界面上的「√ 复制成功」是纯前端的
   *   瞬时反馈（几秒后自己消失），不该被记进库。
   *   写库会带来一个具体的坏后果：`copyStatus` 变成 `'copied'` 之后
   *   广播 + `reload()` 会把它读回来，而前端那个「几秒后复原」的定时器
   *   改的是已经被换掉的对象 —— 界面上的成功提示就**永远清不掉**（真机现象）。
   *
   *   `copyStatus` 只由**自动复制**那条流水线写（`pipeline.ts` 的
   *   `shouldAutoCopyCode` 分支），语义是「收到验证码时后台帮用户复制过了」。
   *
   * ⚠ 只广播 `mail:updated` 是为了让**别开着的界面**也刷新 ——
   *   例如弹窗开着复制了，侧边栏也该看到同一封的正文变化。但因为它不再改库，
   *   这次广播其实只会触发一次无变化的重读；留着是为了行为一致。
   */
  onMessage('mail:copy-code', async ({ data }) => {
    const ok = await copyViaContentScript(data.code)
    if (ok && data.mailId)
      broadcastToExtension('mail:updated', { mailId: data.mailId })
    return { ok }
  })

  /**
   * 「点击复制」的回执。
   *
   * content script 自己先把验证码写进剪贴板（它在页面里，几乎必然成功），再把结果
   * 报回来 —— 由 background 落库。content script 不该有 IDB 访问路径，
   * 否则 schema 归一化要维护两遍。
   */
  onMessage('mail:manual-copy-result', async ({ data }) => {
    await ensureStoreReady()
    if (data.mailId) {
      await recordManualCopy(data.mailId, data.ok)
      broadcastToExtension('mail:updated', { mailId: data.mailId })
    }
    return { ok: true as const }
  })
}
