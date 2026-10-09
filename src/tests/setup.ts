import { beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'

/**
 * 单测的全局准备。
 *
 * 四件事，每件都是「不做就跑不起来」的：
 *
 * 1. **`fake-indexeddb/auto`**：Node 里没有 IndexedDB。它在 `globalThis` 上装一个
 *    纯 JS 实现，于是 `platform/idb/*` 与 `logic/store/*` 可以在毫秒级跑完单测，
 *    不需要起浏览器。import 顺序很重要 —— 必须在任何 store 模块之前。
 *
 * 2. **`chrome.storage.local` 桩**：`logic/store/legacy.ts` 在**模块顶层**
 *    import 了 `webextension-polyfill`，而它在 Node 里会因为找不到 `chrome`
 *    而抛错（模块加载期抛错会让整条 import 链失败，连不相关的测试都跑不起来）。
 *    这里按 polyfill 期望的形状装一个最小桩：只要 `get` / `remove` 存在就够了。
 *
 * 3. **浏览器 API 桩**（`matchMedia` / `ResizeObserver` / `getBBox`）：jsdom 里没有。
 *    Ant Design Vue 的组件在挂载时会用到它们（自适应断点、Tabs 的滚动测量、
 *    表格的响应式），缺一个就是 `is not a function` 直接炸掉整个用例 ——
 *    而报错位置在 antd 内部，跟被测代码看不出关系。
 *
 * 4. **每个测试前清库**：模块级的 `openDb()` 单例与 `ensureStoreReady()` 的
 *    promise 会跨测试存活，不重置的话第二个测试会看到第一个测试留下的数据。
 */

/* --------------------------------------------------------------------------
   antd 需要的浏览器 API
   -------------------------------------------------------------------------- */

/*
 * ⚠ `matchMedia` 必须返回一个**有 add/removeEventListener 的真对象**：
 *   `@vueuse/core` 的 `usePreferredDark()` 会挂监听，只给一个 `{ matches: false }`
 *   的话它会在挂载时抛「addEventListener is not a function」。
 *   返回 `matches: false` ⇒ 测试跑在浅色主题下，与真机默认一致。
 */
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
})

/** 只提供「观察得到、但从不触发」的最小实现 —— 布局在 jsdom 里本来就不存在 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverStub {
  root = null
  rootMargin = ''
  thresholds: number[] = []
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

Object.assign(globalThis, {
  ResizeObserver: ResizeObserverStub,
  IntersectionObserver: IntersectionObserverStub,
})

/*
 * `SVGElement.prototype.getBBox`：Tabs / Table 的指示条要量文字宽度，
 * 而 jsdom 的 SVG 实现里没有这个方法（会抛 `getBBox is not a function`）。
 * 返回全 0 是诚实的 —— jsdom 不跑布局，量出来的尺寸本来就只能是 0。
 */
if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    writable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  })
}

const storageArea = {
  async get(keys?: unknown) {
    void keys
    return {}
  },
  async set() {},
  async remove() {},
  async clear() {},
  async getBytesInUse() {
    return 0
  },
}

/*
 * ⚠ `onConnect` 必须有，不能省。
 *
 * `logic/messaging.ts` 的 `installConnectListener()` 用它来维护「哪些扩展页面活着」，
 * 而那个函数把整个注册过程包在 try/catch 里（浏览器里 `onConnect` 一定存在，
 * catch 只是防御）。少了这个桩，异常会被那个 catch 吃掉 ——
 * 于是测试**看起来**通过了，实际那条代码路径一次都没跑到。
 * 它是本文件里唯一一个「缺失会静默改变行为」的桩，所以特意标出来。
 */
const runtime = {
  id: 'mail-peon-test',
  getURL: (path: string) => `chrome-extension://mail-peon-test/${path}`,
  onInstalled: { addListener() {} },
  onStartup: { addListener() {} },
  onMessage: { addListener() {} },
  onConnect: { addListener() {} },
  sendMessage: async () => undefined,
  lastError: undefined,
}

const action = {
  async setBadgeText() {},
  async setBadgeBackgroundColor() {},
}

const alarms = {
  async get() {
    return undefined
  },
  async create() {},
  onAlarm: { addListener() {} },
}

const tabs = {
  async query() {
    return []
  },
  async get() {
    throw new Error('no tab')
  },
  onActivated: { addListener() {} },
}

const identity = {
  getRedirectURL: () => 'https://mail-peon-test.chromiumapp.org/',
  async launchWebAuthFlow() {
    return ''
  },
}

Object.assign(globalThis, {
  chrome: {
    storage: { local: storageArea, session: storageArea, sync: storageArea },
    runtime,
    action,
    alarms,
    tabs,
    identity,
  },
  browser: {
    storage: { local: storageArea, session: storageArea, sync: storageArea },
    runtime,
    action,
    alarms,
    tabs,
    identity,
  },
})

beforeEach(async () => {
  // 动态 import：`fake-indexeddb/auto` 与 store 模块都必须在 globalThis 装好之后加载
  const [{ closeDb }, { resetStoreReadyForTests }] = await Promise.all([
    import('~/platform/idb/database'),
    import('~/logic/store/ready'),
  ])

  // ⚠ 顺序不能换：先关连接再删库。反过来的话，`deleteDatabase` 会因为还有打开的
  //   连接而 blocked（firefox / chrome 都这样），于是测试之间互相污染
  closeDb()
  resetStoreReadyForTests()

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('mail-peon')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })

  vi.restoreAllMocks()
})
