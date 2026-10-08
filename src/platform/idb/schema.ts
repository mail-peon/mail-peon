/**
 * mail-peon 的 IndexedDB 结构声明（**唯一真相**，与 `ai-docs/design/storage.md` 对齐）。
 *
 * 三处约定，改动前请先想清楚：
 *
 * 1. **库名与版本号都不能随便改。** 库名换了等于丢数据；版本号只能往上加，
 *    并且每次都只能在 `upgrade()` 里**追加**一个 `if (oldVersion < N)` 分支 ——
 *    改旧分支会让老用户与新用户走出两种不同的库结构。
 * 2. **`accounts` / `rules` / `mails` 用「外部键」**（`createObjectStore` 不带
 *    keyPath），键由调用方给出（`accountId` / `ruleId` / `<accountId>:<messageId>`）。
 *    这是刻意的：这几张表的记录会被字段白名单归一化，记录里多一个 `key` 字段
 *    会被当成未知字段清掉。
 * 3. **`settings` / `meta` 用「内部键」**（`id` / `key`），因为它们本来就是单文档。
 *
 * 满足以下任一即写 `ai-docs/decisions/adr-NNNN-<title>.md`：
 * 增加 / 删除一个仓库、改 keyPath（外部键 ↔ 内部键）、改索引、改 `DB_NAME`。
 */

export const DB_NAME = 'mail-peon'

/**
 * 当前 schema 版本。
 *
 * 每次改动结构都要 +1，并在 `upgrade()` 里追加对应分支。
 */
export const DB_VERSION = 2

export type StoreName = 'accounts' | 'rules' | 'mails' | 'settings' | 'meta'

export interface IndexSchema {
  name: string
  keyPath: string
}

export interface StoreSchema {
  name: StoreName
  /** 内部键的字段名；`null` 表示用外部键（写入时必须显式给键） */
  keyPath: string | null
  indexes: IndexSchema[]
}

export const STORES: readonly StoreSchema[] = [
  {
    // 邮箱账号（含 per-account blockedList）
    name: 'accounts',
    keyPath: null,
    indexes: [
      { name: 'by-email', keyPath: 'email' },
      { name: 'by-enabled', keyPath: 'enabled' },
    ],
  },
  {
    // PromptRule
    name: 'rules',
    keyPath: null,
    indexes: [
      { name: 'by-enabled', keyPath: 'enabled' },
      { name: 'by-priority', keyPath: 'priority' },
    ],
  },
  {
    // 邮件；按 receivedAt 滚动淘汰
    name: 'mails',
    keyPath: null,
    indexes: [
      { name: 'by-accountId', keyPath: 'accountId' },
      // receivedAt 是数字时间戳，升序索引的游标即时间序
      { name: 'by-receivedAt', keyPath: 'receivedAt' },
      /*
       * 回收站（v2 新增）。
       *
       * `trashedAt` 只在**进回收站之后**才有值。IndexedDB 的索引**不收录
       * 字段缺失的记录** —— 所以这个索引天然只包含「在回收站里」的邮件，
       * 拿它的游标倒序遍历就是「回收站列表，最近删的在最前」。
       *
       * ⚠ 这正是用**时间戳**而不是布尔量的收益：布尔量要么建不出「只有 true」
       *   的索引（IndexedDB 不支持部分索引），要么得全表扫再过滤。
       */
      { name: 'by-trashedAt', keyPath: 'trashedAt' },
    ],
  },
  {
    // 单文档仓库：app / ai，值统一是 { id, value, updatedAt }
    name: 'settings',
    keyPath: 'id',
    indexes: [],
  },
  {
    // 迁移与初始化标记：migration / init
    name: 'meta',
    keyPath: 'key',
    indexes: [],
  },
]

/**
 * 建库 / 升级。
 *
 * ⚠ 只追加分支，不改已有分支。每个分支内部**只做结构性操作**（建仓库、建索引），
 *   数据搬迁交给应用层（见 `logic/store/legacy.ts`）：放在这里做的话，一旦中途
 *   失败，用户会得到一个「建了库但没数据」的状态，而应用层的一次性迁移是原子的、
 *   可重试的。
 */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    for (const store of STORES) {
      const created = store.keyPath
        ? db.createObjectStore(store.name, { keyPath: store.keyPath })
        : db.createObjectStore(store.name)
      for (const index of store.indexes)
        created.createIndex(index.name, index.keyPath)
    }
  }

  /*
   * v2：回收站。
   *
   * ⚠⚠ 必须是 `else if`，**不是**独立的 `if (oldVersion < 2)`。
   *
   *   全新安装时 `oldVersion === 0`，上面那个分支已经把 `STORES` 里的索引
   *   **全都建好了**（`STORES` 是「当前结构的唯一真相」，里面已经含 `by-trashedAt`）。
   *   此时再执行一次 `createIndex('by-trashedAt', …)` 会抛 `ConstraintError`
   *   （索引已存在），而 `onupgradeneeded` 里的异常会让**整个升级事务 abort** ——
   *   表现是 `AbortError`，**库根本打不开**，而且错误信息完全不提索引重名。
   *   （实测踩过：全套 store 测试挂掉 27 条。）
   *
   *   所以老库才需要补建索引；新库已经由第一个分支建好了。
   */
  else if (oldVersion < 2) {
    const mails = tx.objectStore('mails')
    // 防御：万一某个中间版本已经建过（例如从更早的开发版升上来），别重复建
    if (!mails.indexNames.contains('by-trashedAt'))
      mails.createIndex('by-trashedAt', 'trashedAt')
  }
}
