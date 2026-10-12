import { afterEach, describe, expect, it, vi } from 'vitest'
import { looksLikeClipboardRelayUrl, readClipboardText } from '../clipboard-relay'

describe('looksLikeClipboardRelayUrl', () => {
  it('识别 peon-hall 复制的中继地址', () => {
    expect(looksLikeClipboardRelayUrl('ws://127.0.0.1:41316/')).toBe(true)
  })

  it('识别 wss://', () => {
    expect(looksLikeClipboardRelayUrl('wss://relay.example.com:443/path?token=abc')).toBe(true)
  })

  it('接受首尾空白（用户复制时常带）', () => {
    expect(looksLikeClipboardRelayUrl('  ws://127.0.0.1:41316/  ')).toBe(true)
  })

  it('拒绝 http://', () => {
    expect(looksLikeClipboardRelayUrl('http://127.0.0.1:41316/')).toBe(false)
  })

  it('拒绝纯文本', () => {
    expect(looksLikeClipboardRelayUrl('hello world')).toBe(false)
    expect(looksLikeClipboardRelayUrl('')).toBe(false)
    expect(looksLikeClipboardRelayUrl('ws://')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(looksLikeClipboardRelayUrl('WS://127.0.0.1:41316/')).toBe(true)
    expect(looksLikeClipboardRelayUrl('WSS://example.com/')).toBe(true)
  })
})

describe('readClipboardText', () => {
  /*
   * ⚠️ jsdom 默认不实现 `navigator.clipboard` ——我们用 `vi.stubGlobal`
   *    模拟「支持 / 不支持 / 抛错 / 空 / 有内容」五种场景。
   */

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('没有 navigator.clipboard 时返回 null', async () => {
    vi.stubGlobal('navigator', {})
    expect(await readClipboardText()).toBeNull()
  })

  it('剪贴板 API 抛错时返回 null（不冒泡到调用方）', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: async () => {
          throw new Error('permission denied')
        },
      },
    })
    expect(await readClipboardText()).toBeNull()
  })

  it('剪贴板为空时返回 null', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: async () => '',
      },
    })
    expect(await readClipboardText()).toBeNull()
  })

  it('剪贴板有内容时返回字符串', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: async () => 'ws://127.0.0.1:41316/',
      },
    })
    expect(await readClipboardText()).toBe('ws://127.0.0.1:41316/')
  })
})
