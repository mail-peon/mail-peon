/**
 * @param host 目标主机名
 * @returns 是否指向本机
 */
export function isLoopback(host: string): boolean {
  return /^(?:localhost|127\.|0\.0\.0\.0|::1$|\[::1\])/i.test(host)
}

/**
 * 纯 IP 字面量不能当 SNI；给了反而会让部分服务器拒握手
 *
 * @param host 目标主机名
 * @returns 是否是 IP 字面量
 */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * @param host 目标主机名
 * @returns 可直接拼进 URL 的主机写法（IPv6 补方括号）
 */
export function displayHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}
