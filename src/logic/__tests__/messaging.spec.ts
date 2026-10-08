import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isBroadcastableEndpoint, parseEndpointName } from '~/logic/messaging'

/**
 * 广播目标解析的测试。
 *
 * 这一组对应一个**真机故障**：background 抛出
 * `TypeError: Cannot read properties of undefined (reading 'fingerprint')`。
 *
 * 根因是 `webext-bridge` 的 `formatEndpoint` **只对 `background` / `popup` / `options`
 * 原样返回端点名**，其余一律拼成 `<context>@<tabId>`。所以按 context 名去发
 * `sidepanel` 会解析成 `sidepanel@null`，而 Sidepanel 页面注册自己时用的是
 * `sidepanel@<tabId>` —— 两边对不上，`connMap.get()` 返回 undefined，
 * 而它内部**无条件**读 `dest().fingerprint`。
 *
 * 关键点：这个错误**不会**让消息丢失后再报错，而是让整个消息处理抛异常 ——
 * 所以「看起来只是某个页面收不到广播」的地方，实际上 background 正在报错。
 */

describe('parseEndpointName', () => {
  it('解析 webext-bridge 的连接名（JSON）', () => {
    expect(parseEndpointName('{"endpointName":"popup","fingerprint":"uid::AbC1234"}')).toBe('popup')
  })

  it('带 tabId 的端点名原样返回', () => {
    expect(parseEndpointName('{"endpointName":"content-script@12","fingerprint":"uid::x"}')).toBe('content-script@12')
  })

  it('不是 JSON 时返回空串（扩展里还有别的 runtime.connect 使用者）', () => {
    expect(parseEndpointName('some-other-extension-port')).toBe('')
    expect(parseEndpointName('')).toBe('')
    expect(parseEndpointName(undefined)).toBe('')
  })

  it('是 JSON 但没有 endpointName 时返回空串', () => {
    expect(parseEndpointName('{"fingerprint":"uid::x"}')).toBe('')
    expect(parseEndpointName('{"endpointName":123}')).toBe('')
    expect(parseEndpointName('null')).toBe('')
  })
})

describe('isBroadcastableEndpoint', () => {
  it('接受 webext-bridge 认得的三个扩展页面 context', () => {
    expect(isBroadcastableEndpoint('popup')).toBe(true)
    expect(isBroadcastableEndpoint('options')).toBe(true)
    expect(isBroadcastableEndpoint('devtools')).toBe(true)
  })

  it('带 tabId 后缀的也接受（按 @ 前那一段判断）', () => {
    expect(isBroadcastableEndpoint('devtools@7')).toBe(true)
  })

  /*
   * 这两条是本次故障的核心断言。
   *
   * `sidepanel` 不在 webext-bridge 的 `RuntimeContext` 里，`formatEndpoint` 会把
   * `{ context: 'sidepanel' }` 解析成 `sidepanel@null` —— 与页面注册的键不一致。
   * 所以它**必须**被拒绝：宁可少发一条广播，也不能让 background 抛异常。
   *
   * （Sidepanel 页面改为以 `popup` 身份注册来收广播，见 `src/sidepanel/index.html`。）
   */
  it('拒绝 sidepanel（它不在 RuntimeContext 里，发过去会让 background 崩）', () => {
    expect(isBroadcastableEndpoint('sidepanel')).toBe(false)
    expect(isBroadcastableEndpoint('sidepanel@3')).toBe(false)
  })

  it('拒绝空值与未知端点', () => {
    expect(isBroadcastableEndpoint('')).toBe(false)
    expect(isBroadcastableEndpoint('content-script@1')).toBe(false)
    expect(isBroadcastableEndpoint('window@1')).toBe(false)
  })
})

describe('broadcastToExtension 不往未连接的端点发', () => {
  /*
   * 这一条验的是「没连上就不发」。background 侧的 connMap 只在对方握手完成后才有
   * 条目，而 `sendMessage` 内部**无条件**读 `connMap.get(dest).fingerprint` ——
   * 所以「先发了再说，失败会 reject」是错的：它抛的是同步 TypeError。
   */
  beforeEach(() => {
    vi.resetModules()
  })

  it('没有任何页面连接时不调用 sendMessage', async () => {
    const { broadcastToExtension } = await import('~/logic/messaging')
    // 不该抛错，也不该有任何副作用
    expect(() => broadcastToExtension('data:changed', { reason: 'accounts' })).not.toThrow()
  })
})
