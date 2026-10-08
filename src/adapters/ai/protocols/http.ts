/**
 * 协议层共用的 HTTP 细节：地址归一化、超时、错误摘要。
 *
 * 两个协议（OpenAI / Anthropic）在这几件事上完全一致，各写一份的话，
 * 「改超时时间」这类改动必然会漏掉其中一家。
 */

/**
 * 单次对话请求的超时。
 *
 * 取 90s：正常平台 30s 内就会返回，超过这个量级基本是端点挂住或网络断了。
 * 没有超时的话界面会永远停在「分析中…」，用户只能重装扩展。
 */
export const AI_REQUEST_TIMEOUT_MS = 90_000

/** 连通性探测只要一句「回复 ok」，给它更短的超时 */
export const AI_PING_TIMEOUT_MS = 20_000

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export { responseErrorDetail } from '~/platform/http'
