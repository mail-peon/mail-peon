import { describe, expect, it } from 'vitest'
import {
  clearStore,
  count,
  del,
  get,
  getAllEntries,
  iterate,
  openDb,
  put,
  putMany,
  retryable,
  runTx,
} from '~/platform/idb/database'
import { DB_NAME, DB_VERSION, STORES } from '~/platform/idb/schema'

/**
 * IDB 原语单测（`03-roadmap.md` M1 验收：「IDB 单测覆盖 80%
 * （`openDb` / `put` / `iterate` / `runTx` / `retryable`）」）。
 *
 * 这些断言值得写的原因：`platform/idb/database.ts` 里那三条规矩
 * （事务里不 await 非 IDB、写事务要等 txDone、重试只给幂等操作）**都不是**
 * 类型能表达的约束。它们被破坏时的症状是「偶发丢数据」—— 靠手测永远抓不到。
 */

describe('schema', () => {
  it('库名与版本是契约，不能被随手改掉', () => {
    // 这两个值改了等于丢用户数据（见 schema.ts 头部第 1 条）。写死断言是为了让
    // 「不小心改动」在 CI 里就失败，而不是等用户升级后发现库空了
    expect(DB_NAME).toBe('mail-peon')
    expect(DB_VERSION).toBe(1)
  })

  it('五个仓库的形状与设计文档一致', () => {
    expect(STORES.map(store => store.name)).toEqual(['accounts', 'rules', 'mails', 'settings', 'meta'])

    const byName = Object.fromEntries(STORES.map(store => [store.name, store]))
    // 外部键仓库：keyPath 为 null
    expect(byName.accounts.keyPath).toBeNull()
    expect(byName.rules.keyPath).toBeNull()
    expect(byName.mails.keyPath).toBeNull()
    // 内部键仓库
    expect(byName.settings.keyPath).toBe('id')
    expect(byName.meta.keyPath).toBe('key')

    expect(byName.accounts.indexes.map(index => index.name)).toEqual(['by-email', 'by-enabled'])
    expect(byName.rules.indexes.map(index => index.name)).toEqual(['by-enabled', 'by-priority'])
    expect(byName.mails.indexes.map(index => index.name)).toEqual(['by-accountId', 'by-receivedAt'])
  })
})

describe('openDb', () => {
  it('建出全部仓库与索引', async () => {
    const db = await openDb()
    // `objectStoreNames` / `indexNames` 是 DOMStringList，不是数组 —— 没有
    // `Symbol.iterator`，所以展开运算符用不了，得走 Array.from
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['accounts', 'mails', 'meta', 'rules', 'settings'])

    const tx = db.transaction('mails', 'readonly')
    expect(Array.from(tx.objectStore('mails').indexNames).sort()).toEqual(['by-accountId', 'by-receivedAt'])
  })

  it('重复调用返回同一个连接（单例）', async () => {
    expect(await openDb()).toBe(await openDb())
  })
})

describe('put / get / del', () => {
  it('外部键仓库：键由调用方给，记录里不含键字段', async () => {
    const record = { accountId: 'a1', email: 'me@example.com' }
    await put('accounts', record, 'a1')

    const loaded = await get<typeof record>('accounts', 'a1')
    expect(loaded).toEqual(record)
    // 键是外部的 —— 记录本身不该多出 id / key 字段（多了会被归一化清掉，
    // 于是「键从哪来」这件事在两条路径上不一致）
    expect(loaded && 'id' in loaded).toBe(false)
  })

  it('内部键仓库：键写在记录里，put 不传键', async () => {
    await put('settings', { id: 'app', value: { minimalMode: true }, updatedAt: 'now' })
    const doc = await get<{ id: string, value: unknown }>('settings', 'app')
    expect(doc?.value).toEqual({ minimalMode: true })
  })

  it('get 不存在的键返回 undefined（而不是抛错）', async () => {
    expect(await get('accounts', 'nope')).toBeUndefined()
  })

  it('del 删掉一条', async () => {
    await put('accounts', { email: 'a@b.com' }, 'a1')
    await del('accounts', 'a1')
    expect(await get('accounts', 'a1')).toBeUndefined()
  })

  it('putMany 一次写多条', async () => {
    await putMany('accounts', [
      { key: 'a1', value: { email: 'a@b.com' } },
      { key: 'a2', value: { email: 'c@d.com' } },
    ])
    expect(await count('accounts')).toBe(2)
  })
})

describe('iterate', () => {
  it('按索引游标遍历，limit 到量即停', async () => {
    await putMany('mails', [
      { key: 'a:1', value: { accountId: 'a', receivedAt: 100 } },
      { key: 'a:2', value: { accountId: 'a', receivedAt: 200 } },
      { key: 'a:3', value: { accountId: 'a', receivedAt: 300 } },
    ])

    const ascending: number[] = []
    await iterate<{ receivedAt: number }>(
      'mails',
      { index: 'by-receivedAt', direction: 'next' },
      value => ascending.push(value.receivedAt),
    )
    expect(ascending).toEqual([100, 200, 300])

    // 倒序 + limit：这就是「读最近 N 封」的实现方式，不需要读全表再排序
    const descending: number[] = []
    await iterate<{ receivedAt: number }>(
      'mails',
      { index: 'by-receivedAt', direction: 'prev', limit: 2 },
      value => descending.push(value.receivedAt),
    )
    expect(descending).toEqual([300, 200])
  })

  it('按 IDBKeyRange 只扫一段（淘汰过期前缀用）', async () => {
    await putMany('mails', [
      { key: 'a:1', value: { receivedAt: 100 } },
      { key: 'a:2', value: { receivedAt: 200 } },
      { key: 'a:3', value: { receivedAt: 300 } },
    ])

    const seen: number[] = []
    await iterate<{ receivedAt: number }>(
      'mails',
      { index: 'by-receivedAt', range: IDBKeyRange.upperBound(200), direction: 'next' },
      value => seen.push(value.receivedAt),
    )
    expect(seen).toEqual([100, 200])
  })
})

describe('runTx', () => {
  it('多步操作在同一事务里，全部可见', async () => {
    await runTx(['accounts', 'settings'], 'readwrite', async (ctx) => {
      await put('accounts', { email: 'a@b.com' }, 'a1', ctx)
      await put('settings', { id: 'app', value: 1, updatedAt: 'now' }, undefined, ctx)
    })

    expect(await get('accounts', 'a1')).toBeDefined()
    expect(await get('settings', 'app')).toBeDefined()
  })

  it('中途抛错 → 整批回滚（显式 abort）', async () => {
    await put('accounts', { email: 'keep@b.com' }, 'keep')

    await expect(
      runTx(['accounts'], 'readwrite', async (ctx) => {
        await put('accounts', { email: 'temp@b.com' }, 'temp', ctx)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // 「事务」这个词的全部意义就在这里：不 abort 的话，已经发出去的写会照常提交，
    // 调用方看到失败、数据却变了
    expect(await get('accounts', 'temp')).toBeUndefined()
    expect(await get('accounts', 'keep')).toBeDefined()
  })

  it('在事务里读设置会失活外层事务（这是那条规矩存在的原因）', async () => {
    /*
     * 这条断言是**反例的规范化**：它固定住「事务里不能 await 非本事务的 IDB 操作」
     * 这个事实，这样将来有人想「在 pruneMails 里顺便 readAppSettings」时，
     * 至少有一个测试告诉他为什么不行。
     *
     * 真实症状是 InvalidStateError —— 事务在控制权交回事件循环时自动提交，
     * 之后的请求全部失败。
     */
    const failing = runTx(['mails'], 'readwrite', async (ctx) => {
      // 新开一个事务（不是 ctx.tx）—— 这一步会让外层事务在下一个微任务排空时提交
      await get('settings', 'app')
      await put('mails', { receivedAt: 1 }, 'a:1', ctx)
    })

    await expect(failing).rejects.toThrow()
  })
})

describe('retryable', () => {
  it('可重试的错误会重试，最终成功', async () => {
    let attempts = 0
    const result = await retryable(async () => {
      attempts++
      if (attempts < 3) {
        const error = new Error('storage hiccup')
        error.name = 'AbortError'
        throw error
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('不可重试的错误立刻抛出（重试不会变好，只会掩盖问题）', async () => {
    let attempts = 0
    await expect(
      retryable(async () => {
        attempts++
        const error = new Error('quota full')
        error.name = 'QuotaExceededError'
        throw error
      }),
    ).rejects.toThrow('quota full')
    expect(attempts).toBe(1)
  })

  it('重试次数用尽后抛出最后一个错误', async () => {
    let attempts = 0
    await expect(
      retryable(async () => {
        attempts++
        const error = new Error('still broken')
        error.name = 'UnknownError'
        throw error
      }),
    ).rejects.toThrow('still broken')
    expect(attempts).toBe(3)
  })
})

describe('clearStore / getAllEntries', () => {
  it('清空只影响指定的仓库', async () => {
    await put('accounts', { email: 'a@b.com' }, 'a1')
    await put('rules', { name: 'r1' }, 'r1')

    await clearStore('accounts')

    expect(await count('accounts')).toBe(0)
    expect(await count('rules')).toBe(1)
  })

  it('getAllEntries 带回真实的外部键（记录里没有它）', async () => {
    await put('accounts', { email: 'a@b.com' }, 'a1')
    const entries = await getAllEntries<{ email: string }>('accounts')
    expect(entries).toEqual([{ key: 'a1', value: { email: 'a@b.com' } }])
  })
})
