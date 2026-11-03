import type { RelayTarget } from './protocol'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { isIpLiteral } from './addresses'
import { REJECT_UNAUTHORIZED } from './config'

/**
 * TCP and implicit TLS share the same address and certificate policy.
 * DNS names require SNI; IP literals must not be sent as a server name.
 */
export function connectUpstream(target: Pick<RelayTarget, 'host' | 'port' | 'tls'>) {
  return target.tls
    ? tlsConnect({ host: target.host, port: target.port, servername: isIpLiteral(target.host) ? undefined : target.host, rejectUnauthorized: REJECT_UNAUTHORIZED })
    : netConnect({ host: target.host, port: target.port })
}

export function describeUpstreamError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code
  const hint = code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    ? '（邮件服务器用了自签证书；测试环境可设 TLS_REJECT_UNAUTHORIZED=0）'
    : ''
  return `${code ?? error.message}${hint}`
}
