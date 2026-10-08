import { beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'

/**
 * 单测的全局准备。
 *
 * 三件事，每件都是「不做就跑不起来」的：
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
 * 3. **每个测试前清库**：模块级的 `openDb()` 单例与 `ensureStoreReady()` 的
 *    promise 会跨测试存活，不重置的话第二个测试会看到第一个测试留下的数据。
 */

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
