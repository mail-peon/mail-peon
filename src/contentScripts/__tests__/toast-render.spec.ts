import type { ToastPayload } from '~/logic/notification/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_CSS } from '~/contentScripts/toast.css'

/*
 * ⚠ `webext-bridge/content-script` 在**模块加载期**就 `browser.runtime.connect()`，
 *   而 jsdom 里那个桩没有 `connect` —— 不 mock 的话 import 阶段直接抛，
 *   下面每个用例都会失败在「容器没挂上」，看着像 toast 自己坏了。
 *   toast 的渲染逻辑与消息通道无关，这里只需要它别炸。
 */
vi.mock('webext-bridge/content-script', () => ({
  sendMessage: vi.fn(async () => undefined),
}))

/**
 * 页面 toast 的**渲染契约**测试。
 *
 * 钉住三件用户报过的事（它们都不会报错、也不会让别的断言失败，纯粹视觉上错）：
 *
 *   1. 第一行不带状态 emoji（✅ / ⚠ / ℹ 已去掉）—— 状态只由左侧 4px 色条表达；
 *   2. 复制成功**不写**「已复制」—— 第二行只留验证码本体；
 *   3. 关闭按钮在**第一行右端**，不是内容行之后另起一行、落在左下角。
 *
 * 分工与 `components/__tests__/mail-item-style.spec.ts` 一致：
 *
 *   - **结构**（谁是谁的孩子）在这里挂真模块、断言真 DOM；
 *   - **样式声明**（字号谁大、按钮跟不跟第一行）只能读 `TOAST_CSS` 的规则体 ——
 *     jsdom 不跑布局引擎，`getBoundingClientRect()` 永远是 0，量不出「看起来」。
 *
 * ⚠ 局限：样式那一层测的是**声明**，不是渲染结果。
 *   它保证「验证码的字号大于标题与标签」，不能保证那个字号好看 —— 后者只能靠人看。
 */

const attachShadow = Element.prototype.attachShadow

/**
 * 生产里 shadow root 是 `closed`（页面 JS 读不到我们的 DOM，见 `toast.ts` 顶部说明）。
 * 测试要断言内部结构，于是把 `attachShadow` 换成强制 `open` ——
 * 被测代码一行都不用改，测的仍是它真实创建的那棵 DOM。
 */
function forceOpenShadowRoot(): void {
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element) {
    return attachShadow.call(this, { mode: 'open' })
  })
}

function payload(overrides: Partial<ToastPayload> = {}): ToastPayload {
  return {
    kind: 'code',
    mailId: 'mail-1',
    from: 'GitHub · noreply@github.com',
    code: '123456',
    status: 'copied',
    ...overrides,
  }
}

/** 弹一条 toast 并返回它的 shadow root（每个用例都拿一份干净的模块状态） */
async function show(overrides: Partial<ToastPayload> = {}): Promise<ShadowRoot> {
  // 上一个用例留下的 host 还在 document 里，不摘掉的话 `getElementById` 会拿到旧的
  document.querySelectorAll('#mail-peon-toast-host').forEach(el => el.remove())

  vi.resetModules()
  forceOpenShadowRoot()
  const { showToast } = await import('~/contentScripts/toast')
  showToast(payload(overrides))

  const shadow = document.getElementById('mail-peon-toast-host')?.shadowRoot
  if (!shadow)
    throw new Error('toast 容器没挂上：ensureContainer() 没跑成功')
  return shadow
}

/** 取 CSS 里匹配 `选择器` 的那条规则体（参数是正则源码，元字符由调用方自己转义） */
function ruleBody(css: string, selectorPattern: string): string {
  const match = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match)
    throw new Error(`样式里找不到规则：${selectorPattern}`)
  return match[1]
}

/**
 * toast 自身的文字 —— **不含** shadow root 里那个 `<style>`。
 *
 * ⚠ 别用 `root.textContent`：它把样式**注释**也算进去，而那些注释里写着
 *   「已复制」「无 emoji」之类的说明，于是「界面上没有这几个字」这类断言会假失败。
 */
function toastText(root: ShadowRoot): string {
  return root.querySelector('.toast')?.textContent ?? ''
}

/**
 * 去掉注释后的样式。
 *
 * ⚠ 断言「某条声明**不**存在」时必须用它：本项目习惯在注释里写「以前是 …」这类
 *   反向说明，正则会把它一起匹配上，于是得到**假的失败**。
 */
const css = TOAST_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

beforeEach(() => {
  document.querySelectorAll('#mail-peon-toast-host').forEach(el => el.remove())
})

describe('第一行：发件人 · 发件邮箱 + 关闭按钮', () => {
  it('第一行就是发件人，且不带任何 emoji', async () => {
    const root = await show()

    expect(root.querySelector('.head .title')?.textContent).toBe('GitHub · noreply@github.com')
    /*
     * ⚠ 断言范围是 `.toast` 而不是 `root.textContent`：shadow root 里还有一个
     *   `<style>`，而样式**注释**里写着 ⚠ —— 拿 root 比会把注释一起算进来。
     */
    expect(toastText(root)).not.toMatch(/[\u2705\u26A0\u2139]/)
    expect(root.querySelector('.icon')).toBeNull()
  })

  it('关闭按钮在第一行右端（不是内容行之后另起一行）', async () => {
    const root = await show()

    const head = root.querySelector('.head')
    const close = head?.querySelector('button.close')
    expect(close).toBeTruthy()
    expect(head?.lastElementChild).toBe(close)

    /*
     * ⚠ 这一条正是用户报的「关闭按钮在第三行开头」：
     *   它不能直接是 `.body` 的孩子（那会自成一行），只能在第一行 `.head` 里。
     */
    expect(close?.closest('.head')).toBe(head)
    expect(root.querySelector('.body')?.lastElementChild).not.toBe(close)
  })
})

describe('第二行：验证码（主体）', () => {
  it('成功态：第二行只有验证码，第三行是一句灰色的「√ 已复制」', async () => {
    const root = await show({ status: 'copied' })
    const content = root.querySelector('.content')
    const footer = root.querySelector('.footer')

    expect(content?.querySelector('.label')?.textContent).toBe('验证码')
    expect(content?.querySelector('.code')?.textContent).toBe('123456')
    expect(content?.querySelector('.status')).toBeNull()
    expect(content?.querySelector('button.copy')).toBeNull()

    expect(footer?.querySelector('.copied-hint')?.textContent).toBe('√ 已复制')
    // 第三行 = body 的最后一个孩子
    expect(root.querySelector('.body')?.lastElementChild).toBe(footer)
    // 强调款（绿色加粗的「√ 复制成功」）只属于「用户刚点了复制」那一下
    expect(root.querySelector('.copy-done')).toBeNull()
    expect(toastText(root)).not.toContain('已复制 ✓')
  })

  it('失败态：第二行仍然只有验证码，说明与按钮都挪到第三行', async () => {
    const root = await show({ status: 'failed' })
    const content = root.querySelector('.content')
    const footer = root.querySelector('.footer')

    // 第二行不许再出现状态词或按钮（它们以前挤在验证码右边）
    expect(content?.querySelector('.status')).toBeNull()
    expect(content?.querySelector('button.copy')).toBeNull()

    expect(footer?.querySelector('.status')?.textContent).toBe('自动复制失败')
    expect(footer?.querySelector('button.copy')?.textContent).toBe('复制')
    // 第三行 = body 的最后一个孩子
    expect(root.querySelector('.body')?.lastElementChild).toBe(footer)
    // 按钮跟在说明后面（不是被 `margin-left: auto` 推到最右端）
    expect(footer?.lastElementChild).toBe(footer?.querySelector('button.copy'))
  })

  it('手动态：不写「未自动复制」，复制按钮直接跟在验证码后面', async () => {
    const root = await show({ status: 'manual' })
    const content = root.querySelector('.content')

    expect(root.querySelector('.status')).toBeNull()
    expect(root.querySelector('.footer')).toBeNull()
    expect(content?.lastElementChild).toBe(content?.querySelector('button.copy'))
    expect(toastText(root)).not.toContain('未自动复制')
  })
})

describe('点「复制」之后', () => {
  /** jsdom 里没有 `navigator.clipboard`，装一个只记下写入内容的最小桩 */
  function stubClipboard(written: string[]): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text)
        },
      },
    })
  }

  it('失败态：按钮换成「√ 复制成功」，同时撤掉「自动复制失败」', async () => {
    const written: string[] = []
    stubClipboard(written)

    const root = await show({ status: 'failed' })
    root.querySelector<HTMLButtonElement>('button.copy')?.click()

    await vi.waitFor(() => {
      expect(root.querySelector('.copy-done')).toBeTruthy()
    })
    expect(written).toEqual(['123456'])
    expect(root.querySelector('.copy-done')?.textContent).toBe('√ 复制成功')
    // ⚠ 两句话不能同时出现：「自动复制失败」留着就是自相矛盾的一行
    expect(root.querySelector('.status')).toBeNull()
    expect(root.querySelector('button.copy')).toBeNull()
    // 结果提示留在第三行原位（不是跑到第二行去）
    expect(root.querySelector('.footer')?.querySelector('.copy-done')).toBeTruthy()
    expect(toastText(root)).not.toContain('已复制')
  })

  it('手动态：结果提示就在验证码后面', async () => {
    const written: string[] = []
    stubClipboard(written)

    const root = await show({ status: 'manual' })
    root.querySelector<HTMLButtonElement>('button.copy')?.click()

    await vi.waitFor(() => {
      expect(root.querySelector('.copy-done')).toBeTruthy()
    })
    expect(written).toEqual(['123456'])
    expect(root.querySelector('.content')?.querySelector('.copy-done')?.textContent).toBe('√ 复制成功')
    expect(root.querySelector('button.copy')).toBeNull()
  })
})

describe('样式契约', () => {
  const size = (body: string): number => Number(/font-size:\s*(\d+)px/.exec(body)?.[1])

  it('验证码是整条 toast 里最大的字（主体）', () => {
    const code = size(ruleBody(css, '\\.code'))
    expect(code).toBeGreaterThan(size(ruleBody(css, '\\.title')))
    // `.label` 不自己声明字号（继承 `.content` 的），所以跟它比
    expect(code).toBeGreaterThan(size(ruleBody(css, '\\.content')))
  })

  it('关闭按钮跟着第一行，不再单独占一行', () => {
    expect(ruleBody(css, '\\.head')).toMatch(/display:\s*flex/)
    // 以前它写在内容行之后，还带 align-self: flex-start（脱离第一行）
    expect(ruleBody(css, 'button\\.close')).not.toMatch(/align-self/)
  })

  it('没有状态 emoji 图标的样式位（.icon 规则已删）', () => {
    expect(css).not.toMatch(/\.icon\b/)
  })

  /*
   * 「复制」是文字按钮（与 Popup 的 `MailListItem` 同款做法）。
   * ⚠ 这三条一起才叫「文字按钮」：去掉边框、去掉底色、去掉内边距 ——
   *   少了最后一条它仍会把第二行/第三行撑高，看起来还是个小方块。
   */
  it('复制按钮是文字按钮（无边框、无底色、无内边距）', () => {
    const body = ruleBody(css, 'button\\.copy')
    expect(body).toMatch(/border:\s*0/)
    expect(body).toMatch(/background:\s*transparent/)
    expect(body).toMatch(/padding:\s*0/)
    expect(body).toMatch(/height:\s*auto/)
    // 不再被推到整行的最右端：它跟在左边那句话后面
    expect(body).not.toMatch(/margin-left:\s*auto/)
  })

  it('「√ 复制成功」是绿色，且与复制按钮同字号（换的时候这一行不跳）', () => {
    const copy = ruleBody(css, 'button\\.copy')
    const done = ruleBody(css, '\\.copy-done')
    expect(done).toMatch(/color:\s*#10B981/)
    expect(size(done)).toBe(size(copy))
  })

  /*
   * 自动复制成功的那句确认**不强调**：灰色、不加粗。
   * ⚠ 它与 `.copy-done` 是两个不同的东西（默认预期 vs 用户刚做的动作），
   *   混成一个会让每次收验证码都像发生了什么大事。
   */
  it('「√ 已复制」是灰色、不加粗', () => {
    const hint = ruleBody(css, '\\.copied-hint')
    expect(hint).toMatch(/color:\s*rgba\(245, 245, 247, 0\.6\)/)
    expect(hint).not.toMatch(/font-weight:\s*[6-9]00/)
    expect(hint).not.toMatch(/#10B981/)
  })

  it('失败说明与复制按钮在第三行（.footer）里排一行', () => {
    const footer = ruleBody(css, '\\.footer')
    expect(footer).toMatch(/display:\s*flex/)
    expect(footer).toMatch(/gap:/)
  })
})
