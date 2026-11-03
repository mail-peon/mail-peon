// ---------------------------------------------------------------------------
// 跨上下文消息体（消息名与签名在 shim.d.ts 的 ProtocolMap 里）
// ---------------------------------------------------------------------------

/**
 * 一轮同步的结果摘要（`accounts:sync-now` 的返回值）。
 *
 * 放在领域模型里而不是 `shim.d.ts`：`.d.ts` 里只有类型声明，运行时拿不到它，
 * 而 Options 的「立即同步」要遍历这个数组渲染结果。
 */
export interface SyncSummary {
  accountId: string
  label: string
  /** 是否只是记了游标（首次同步不拉历史） */
  firstSync: boolean
  fetched: number
  /** 被排除邮箱挡掉的封数 */
  blocked: number
  /** 解析 / 处理失败的封数 */
  failed: number
  warning?: string
}

/** Shared background sync result without UI or browser dependencies. */
export interface SyncDonePayload {
  ok: boolean
  results: SyncSummary[]
  error?: string
  finishedAt?: number
}

/** AI 连通性测试结果 */
export interface AiTestResult {
  ok: boolean
  detail?: string
  error?: string
  latencyMs?: number
}

/** 邮箱连通性测试结果 */
export interface MailTestResult {
  ok: boolean
  detail?: string
  error?: string
}
