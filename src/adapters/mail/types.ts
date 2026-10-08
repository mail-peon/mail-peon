import type { MailAccount, SyncCursor } from '~/logic/types'

// 从领域模型转出，让 provider / 编排层 / UI 都从这一处取类型
export type { SyncCursor }

/**
 * 邮箱协议抽象层。
 *
 * 架构镜像 `offer-hunter/src/adapters/sites/`：**目录约定 + 默认导出 + glob 注册表**。
 * 新增一家 provider = 加一个 `providers/<id>/index.ts`，注册表自动发现，不用改注册表。
 *
 * ⚠ **本抽象与设计文档的一处必要偏差**（见 `ai-docs/decisions/adr-0005`）：
 *   文档把增量游标写死成 IMAP 的 `lastSeenUid: number`，但 Gmail API 的增量游标是
 *   `historyId: string`，且没有 `UIDVALIDITY` 概念。若把 `lastSeenUid` 硬编进这套
 *   接口，加第二个 provider 就要改 `syncAccount` —— 那正是适配器层要消掉的耦合。
 *   因此改成 `SyncCursor = Record<string, unknown> | null`，形状由各 provider 自定，
 *   编排层只负责透传与持久化。
 */

/**
 * 一轮同步最多**拉取**多少封新邮件。
 *
 * ⚠ 这个数字与「一轮最多**处理**多少封」是两件事，别混：
 *   - 这里是**拉取**上限。它是为了不让一次 `UID FETCH` 传输过多正文 ——
 *     IMAP 客户端的单条命令有超时（30s），一批几千封必然撞爆。
 *   - 拉到的每一封都会走完 pipeline（解析 + AI + 入库），**不会**被丢弃。
 *
 * 50 是实测出来的保守值：一轮 50 封 × 平均几十 KB 正文，远在 30 秒命令超时内。
 *
 * ⚠ 积压会**多轮消化**，而不是被跳过：provider 每轮只推进到本批最大 UID，
 *   下一轮心跳从那里继续（见 `providers/imap/index.ts` 的 `fetchSince`）。
 *   3 万封的邮箱、5 分钟一次心跳，理论上积压几轮就能追平。
 */
export const MAX_MESSAGES_PER_SYNC = 50

/**
 * provider 的声明（Options 表单按它渲染，避免在 UI 里写 `if (provider === 'imap')`）。
 *
 * 与 `AiPlatformDefinition` 同形：**UI 只读这张表**，所以「加了一家 provider 但
 * 设置页没有它的字段」这种事在结构上不可能发生。
 */
export interface MailProviderDefinition {
  /** 协议 id，必须等于 `providers/<id>/` 的目录名 */
  id: string
  /** 用户在 Options 看到的名字 */
  label: string
  /** 一句话说明（表单下方的小字） */
  hint: string
  /** 需要哪些配置字段 —— 表单据此渲染 */
  fields: MailProviderField[]
  /**
   * 当前浏览器环境能不能真的用起来。
   *
   * 这是本抽象存在的**最实际的理由**：MV3 没有裸 TCP（`chrome.sockets.tcp` 只属于
   * 已废弃的 Chrome Apps），所以「IMAP + 密码」这条路在扩展里天生走不通 ——
   * 除非用户在配置里填一个 WebSocket↔TCP 中继地址。让它显式说出来（而不是等
   * 用户填完表单点「测试连接」才报一个看不懂的错）是 provider 的责任。
   */
  availability: 'ready' | 'needs-relay'
  /** 兼容性说明（`availability !== 'ready'` 时展示） */
  availabilityNote?: string
}

export interface MailProviderField {
  key: keyof MailAccount['config']
  label: string
  type: 'text' | 'password' | 'number' | 'toggle'
  placeholder?: string
  required?: boolean
  /** 默认值（表单初值） */
  default?: string | number | boolean
}

/** 服务器上的一封原始邮件（未经解析） */
export interface RawMail {
  /**
   * 原始字节流。
   *
   * ⚠ 用 `Uint8Array` 而不是 `string` 承载：MIME 头里的非 ASCII 是 RFC 2047 编码的，
   *   但正文可能是任意 8bit / base64 / quoted-printable，先转字符串再解析会在
   *   编码边界上出错。解析交给 `postal-mime`（它本来就吃 `ArrayBuffer`）。
   */
  source: Uint8Array
  /** 服务器给的 messageId（用于去重与构造账本键） */
  messageId?: string
  /** provider 私有的序号（IMAP 是 UID），用于推进游标 */
  seq: number
}

/**
 * 一次增量拉取的结果。
 *
 * `nextCursor` 与 `mails` **一起返回**（而不是让编排层自己从 `mails` 里取 max seq）：
 * 只有 provider 知道「没有新邮件时游标该不该动」。IMAP 要用 `UIDNEXT`，
 * Gmail 要用响应里的 `historyId`，而 `mails` 为空时两者都得推到底。
 */
export interface FetchResult {
  mails: RawMail[]
  /** 拉完之后应该存下来的新游标 */
  nextCursor: SyncCursor
  /**
   * 服务器端「邮箱被重建」之类的信号（IMAP 的 UIDVALIDITY 变化）。
   *
   * 非空表示**之前的游标已失效**：编排层要把它写成 `account.lastError` 并在 UI 上
   * 提示用户（设计文档明确要求「检测到就清零 + 警告用户；不试图恢复」）。
   */
  warning?: string
}

export interface TestConnectionResult {
  ok: boolean
  /** 成功时展示的信息（如「INBOX 中有 1234 封邮件」） */
  detail?: string
  error?: string
}

export interface MailConnection {
  /**
   * **首次同步**：拿当前游标，**不拉任何邮件**。
   *
   * 设计文档的硬约束（`decisions/open-questions.md` Q5）：首次连上不拉历史，
   * 只记 `UIDNEXT` / `historyId`。返回 `null` 表示「这次拿不到有效游标」——
   * 那种情况下不能落一个假游标，否则下次会把整箱历史当增量拉下来。
   */
  getInitialCursor: () => Promise<SyncCursor>
  /**
   * 后续同步：拉 `cursor` 之后的新邮件。
   *
   * ⚠ 实现方**必须**把「拉的这一批」与「游标推进到哪」当成一件事来设计：
   *
   *   - `nextCursor` 只能推进到**本批确实处理过的最大的那个位置**，
   *     绝不能直接跳到「服务器最新」—— 那会让本批之外的新邮件永久不被拉取
   *     （IMAP provider 踩过：积压几千封时只有最新的 50 封被处理，其余静默丢失）。
   *   - 积压应当**多轮消化**，每轮取最旧的一批并推进到那批末尾。
   *
   * 这条注释放在接口上而不是某个实现里，因为它是**契约**，不是实现细节。
   */
  fetchSince: (cursor: SyncCursor) => Promise<FetchResult>
  logout: () => Promise<void>
}

/**
 * provider 在运行期回调宿主的钩子。
 *
 * 存在的理由很具体：OAuth provider 的 access token 只有 1 小时，刷新出来的新 token
 * **必须写回存储**，否则每轮心跳都要多一次 token 交换往返。而 provider 层刻意
 * **不依赖存储**（它要能在单测里跑），所以「写回去」这件事得由宿主注入。
 *
 * 之前这里试用过「模块级可变 sink」——那是错的：两个账号并发同步时会互相覆盖
 * 对方的 sink，症状是 A 账号的 token 被写进 B 账号。改成显式传参之后，
 * 这种串号在类型上就表达不出来。
 */
export interface MailConnectionHooks {
  /** access token 刷新成功（OAuth 类 provider 用；IMAP 不用） */
  onTokenRefreshed?: (token: { token: string, expiresAt: number }) => Promise<void> | void
}

export interface MailProvider {
  readonly id: string
  /** 连接一个账号，返回可用的 MailConnection */
  connect: (account: MailAccount, hooks?: MailConnectionHooks) => Promise<MailConnection>
  /** 连通性 + 鉴权探测（Options 的「测试连接」按钮） */
  testConnection: (account: MailAccount, hooks?: MailConnectionHooks) => Promise<TestConnectionResult>
}

/** 造一个 `MailAccount`（Options「新增账号」用；id 由调用方给 nanoid） */
export function createAccount(patch: Partial<MailAccount> & { id: string }): MailAccount {
  return {
    label: '',
    email: '',
    provider: 'gmail',
    config: {},
    blockedList: [],
    enabled: true,
    createdAt: Date.now(),
    cursor: null,
    ...patch,
  }
}
