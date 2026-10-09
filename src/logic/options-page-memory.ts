/**
 * 「设置页最后停在哪一页」的**前端记忆**。
 *
 * ## 为什么是 localStorage，而不是设置 / IndexedDB
 *
 * 这是一个**纯界面偏好**：它不影响任何处理逻辑（background 根本不需要知道用户
 * 上次看的是哪一页），所以它不该走 `settings:set-app` 那条链路 ——
 * 那会把它写进 IDB、进导出文件、还要为它加一个广播。放在 `localStorage`
 * 里既没有往返延迟，也不会在库里留下一堆「只跟这台机器的这个界面有关」的字段。
 *
 * ⚠ 与 `chrome.storage` 的区别要清楚：`chrome.storage.local` 同样能持久化，
 *   但它是**扩展级**的异步 API（要在 manifest 里声明权限、返回 promise），
 *   而这里要的只是「刷新后还在」——`localStorage` 同步、无需权限、作用域就是
 *   这个 `chrome-extension://` 源。
 *
 * ## 为什么只记「用户点过的页」，不记程序改的页
 *
 * 极简模式会把停留在隐藏页面（提示词 / 屏蔽列表）的路由拉回「通用」
 * （见 `Options.vue` 的 `ensureVisiblePage`）。如果连这种**程序性**的跳转也写进记忆，
 * 用户切一次极简模式就会把「我上次在看提示词」这件事永久抹掉 ——
 * 而他切回完整模式时本该回到提示词页。
 * 所以写入时机是**侧边导航的点击**（`select()`），不是 `watch(activePage)`。
 */

const STORAGE_KEY = 'mail-peon:options-page'

/**
 * 读出记忆里的页面。
 *
 * ⚠ `allowed` 是**必须**的：存进去的是字符串，而页面清单会变（加一页、删一页、
 *   改名）。不校验的话，一条旧值会让界面停在一个**没有任何内容的页面**上 ——
 *   而那种现象（主区空白、导航里没有选中项）看起来像渲染坏了，不像「存了个旧值」。
 *
 * ⚠ 全程 try/catch：隐私模式 / 存储被策略禁用时 `localStorage` 的读取会**抛错**，
 *   而「记不住上次在哪一页」绝不该让整个设置页打不开。
 *
 * @param allowed 当前存在的页面 id
 * @param fallback 没有记忆（或记忆无效）时用哪一页
 */
export function readRememberedPage<T extends string>(allowed: readonly T[], fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw && (allowed as readonly string[]).includes(raw))
      return raw as T
  }
  catch {
    // 读不到就当没有记忆
  }
  return fallback
}

/** 记下用户选的页面（由侧边导航的点击调用） */
export function rememberPage(page: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, page)
  }
  catch {
    // 写不进去也不影响本次会话内的切换
  }
}

/** 仅供测试：清掉记忆 */
export function forgetRememberedPage(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  }
  catch {
    // 同上
  }
}
