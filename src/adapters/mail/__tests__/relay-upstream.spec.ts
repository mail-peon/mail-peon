// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { connectUpstream, describeUpstreamError } from '../../../../scripts/relay/upstream'

const mocks = vi.hoisted(() => ({ tcp: vi.fn(), tls: vi.fn() }))
vi.mock('node:net', () => ({ connect: mocks.tcp }))
vi.mock('node:tls', () => ({ connect: mocks.tls }))
vi.mock('../../../../scripts/relay/config', () => ({ REJECT_UNAUTHORIZED: true }))
beforeEach(() => vi.clearAllMocks())

it('uses SNI and certificate verification for a DNS target', () => {
  connectUpstream({ host: 'imap.example.com', port: 993, tls: true })
  expect(mocks.tls).toHaveBeenCalledWith({ host: 'imap.example.com', port: 993, servername: 'imap.example.com', rejectUnauthorized: true })
  expect(mocks.tcp).not.toHaveBeenCalled()
})

it.each(['127.0.0.1', '::1'])('omits SNI for the IP literal %s', (host) => {
  connectUpstream({ host, port: 993, tls: true })
  expect(mocks.tls).toHaveBeenCalledWith(expect.objectContaining({ host, servername: undefined, rejectUnauthorized: true }))
})

it('connects without TLS only when explicitly requested', () => {
  connectUpstream({ host: 'imap.example.com', port: 143, tls: false })
  expect(mocks.tcp).toHaveBeenCalledWith({ host: 'imap.example.com', port: 143 })
  expect(mocks.tls).not.toHaveBeenCalled()
})

it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'])('explains certificate error %s', (code) => {
  expect(describeUpstreamError(Object.assign(new Error('certificate'), { code })))
    .toBe(`${code}（邮件服务器用了自签证书；测试环境可设 TLS_REJECT_UNAUTHORIZED=0）`)
})

it('preserves other error codes and messages without a certificate hint', () => {
  expect(describeUpstreamError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED')
  expect(describeUpstreamError(new Error('offline'))).toBe('offline')
})
