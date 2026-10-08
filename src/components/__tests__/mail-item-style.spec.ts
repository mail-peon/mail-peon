import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `MailListItem` 的**样式契约**测试。
 *
 * ## 为什么用「读源码 + 解析规则」而不是挂载组件量尺寸
 *
 * jsdom 不跑布局引擎 —— `getBoundingClientRect()` 永远返回全 0。
 * 所以「图标到底画在哪儿」在 jsdom 里量不出来。
 * 但**声明**是能量出来的：从 `<style scoped>` 里取出规则，断言它的定位声明。
 *
 * 这一层测的正是那几个「不会让任何断言失败、也不报错，纯粹视觉上错位」的 bug
 * ——只能靠把数值和选择器钉住来防回归：
 *
 *   - 图标跑到了「时间的上方」（偏移相对了错误的祖先）；
 *   - 偏移贴死了边（用户报「太靠右上了」）；
 *   - 按下后出现一圈方框（用户报「不要有边框」）；
 *   - 复制按钮还是个方块按钮（用户要求改成文字）。
 *
 * ⚠ 局限要说清楚：这测的是**声明**，不是**渲染结果**。
 *   它保证定位相对了谁、数值不为 0、颜色取自哪个变量；
 *   它**不能**保证那个值在视觉上好看。后者只能靠人看。
 *
 * ⚠ 显示 / 隐藏的**行为**（悬停进卡片出现、点复制不影响它）在
 *   `mail-list-item.spec.ts` 里测 —— 那边挂真组件、派发真事件。
 *   两个文件的分工：这里管「长什么样」，那里管「什么时候出现」。
 */

/**
 * 取出 scoped 样式里匹配 `选择器` 的那条规则体。
 *
 * ⚠ 参数是**正则源码**（不是转义后的字面量）：选择器里有 `.` 之类的元字符，
 *   调用方按需要自己写。早期版本在这里又转义了一次，
 *   于是传进来的 `\s*` 被当成字面量，规则永远找不到 ——
 *   而失败信息是「样式里找不到规则」，看起来像样式缺了，其实是断言写错了。
 */
function ruleBody(css: string, selectorPattern: string): string {
  const match = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match)
    throw new Error(`样式里找不到规则：${selectorPattern}`)
  return match[1]
}

const source = readFileSync(resolve(process.cwd(), 'src/components/MailListItem.vue'), 'utf8')

/**
 * 去掉注释后的 CSS。
 *
 * ⚠ 断言「某条声明**不**存在」时必须用它，不能用原始源码 ——
 *   本项目习惯在注释里写「早期版本设过 `pointer-events: none`」这类反向说明，
 *   正则会把它一起匹配上，于是得到**假的失败**：代码是对的，测试却说错了。
 */
const css = source
  .slice(source.indexOf('<style scoped>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('垃圾桶按钮的位置与外观', () => {
  /*
   * ⚠ 位置的定义在**热区**（`.trash-zone`）上，按钮只是填满它
   *   （`.trash { inset: 0 }`）。两处各写一遍偏移必然出现「改一个忘一个」。
   */
  it('热区绝对定位到卡片右上角', () => {
    expect(ruleBody(css, '\\.trash-zone')).toMatch(/position:\s*absolute/)
  })

  /*
   * ⚠⚠ 这一条是「切换时不割裂」的**算术保证**。
   *
   *   时间在文档流里，它的**右边缘**距卡片内容区 = 卡片的 `padding-right`。
   *   垃圾桶是绝对定位的，要让它的**右边缘**落在同一条竖直线上：
   *
   *     right(热区) = padding-right(卡片)
   *
   *   ⚠ 注意不是「让图标中心对齐时间右边缘」（那会得到
   *     `padding-right - 热区宽/2`）—— 那是另一种对齐，
   *     效果是图标整体往里缩、看起来被挤到中间。
   *     用户明确要的是「图标右侧位置在文字右侧」：**两个右边缘重合**，
   *     切换时右边不跳。我一开始按错的公式算，白折腾了一轮。
   *
   *   这个关系一旦被破坏（改了 padding 没改偏移，或反过来），
   *   时间与垃圾桶切换时右边缘就会错开 —— 用户看到的正是「割裂」。
   *
   *   所以断言的是**关系**而不是具体数值：数值可以调，
   *   但两个值必须始终互相自洽。
   */
  it('热区右边缘与时间右边缘重合（切换时不割裂）', () => {
    const cardBody = ruleBody(css, '\\.mail-item')
    const zoneBody = ruleBody(css, '\\.trash-zone')

    /*
     * 卡片是 `padding: 10px 12px`（上下 10、左右 12）的简写。
     * 只取右侧那个值。
     */
    const paddingMatch = /padding:\s*(\d+)px\s+(\d+)px/.exec(cardBody)
    expect(paddingMatch, '.mail-item 必须是 `padding: Apx Bpx` 的简写形式').not.toBeNull()
    const paddingRight = Number(paddingMatch![2])

    const right = Number(/right:\s*(\d+)px/.exec(zoneBody)?.[1])
    expect(Number.isFinite(right)).toBe(true)

    /*
     * ⚠ 容差 0：两个右边缘必须**正好**重合。
     *
     *   最初这里给过 2px 容差，结果把 `right` 改成贴边的 `2px`
     *   （与时间右边缘差 4px，正是用户报的「割裂」）时测试**照样通过**，
     *   等于没在守。改成「中心对齐」那个公式时又是 1px 偏差、
     *   也照样通过 —— 两次都说明：**容差一旦放宽就守不住东西**。
     *
     *   这两个值本来就是同一个数（卡片的右侧内边距），没有理由不等。
     */
    expect(right).toBe(paddingRight)
  })

  /*
   * ⚠ 竖向同理：时间行高 14px、在头部里居中；热区 18px 也要居中，
   *   否则图标会比时间偏上或偏下。
   */
  it('热区竖向也与时间居中对齐', () => {
    const cardBody = ruleBody(css, '\\.mail-item')
    const zoneBody = ruleBody(css, '\\.trash-zone')
    const timeSlotBody = ruleBody(css, '\\.time-slot')

    const paddingTop = Number(/padding:\s*(\d+)px/.exec(cardBody)?.[1])
    const zoneHeight = Number(/height:\s*(\d+)px/.exec(zoneBody)?.[1])
    const timeHeight = Number(/height:\s*(\d+)px/.exec(timeSlotBody)?.[1])
    const top = Number(/top:\s*(\d+)px/.exec(zoneBody)?.[1])

    // top = padding-top - (热区高 - 时间行高) / 2
    const expected = paddingTop - (zoneHeight - timeHeight) / 2
    expect(Math.abs(top - expected)).toBeLessThanOrEqual(1)
  })

  /*
   * ⚠ 核心：偏移必须是**相对卡片**的、并且留了距离。
   *   两条都踩过（都是用户报的）：
   *   - 偏移曾经相对 `.time-slot` 算（因为那里有 `position: relative`），
   *     于是图标落在「时间的正上方」＝卡片中部；
   *   - 后来贴死 `2px` —— 「太靠右上了，要有一定的距离」。
   */
  it('不满打满算贴边（不会压着卡片边框）', () => {
    const body = ruleBody(css, '\\.trash-zone')

    const top = Number(/top:\s*(\d+)px/.exec(body)?.[1])
    const right = Number(/right:\s*(\d+)px/.exec(body)?.[1])

    expect(top).toBeGreaterThan(0)
    expect(right).toBeGreaterThan(0)
  })

  it('按钮填满热区（偏移只在热区上写一次）', () => {
    const body = ruleBody(css, '\\.trash')
    expect(body).toMatch(/inset:\s*0/)
    expect(body).not.toMatch(/top:/)
    expect(body).not.toMatch(/right:/)
  })

  /*
   * ⚠ 包含块必须是卡片本身：`.mail-item` 上有 `position: relative`。
   *   少了它，热区会往上找到别的定位祖先（或者视口），
   *   图标就不在卡片里了 —— 而 `top` / `right` 的数值看起来完全正常。
   */
  it('.mail-item 是定位祖先（否则偏移不算在卡片上）', () => {
    expect(ruleBody(css, '\\.mail-item')).toMatch(/position:\s*relative/)
  })

  it('.time-slot 不是定位祖先（否则图标会落在时间上方）', () => {
    expect(ruleBody(css, '\\.time-slot')).not.toMatch(/position:\s*(relative|absolute)/)
  })

  it('先灰后红：默认灰、悬停才红', () => {
    expect(ruleBody(css, '\\.trash')).toMatch(/color:\s*var\(--mp-text-faint\)/)
    expect(ruleBody(css, '\\.trash:hover')).toMatch(/color:\s*var\(--mp-danger\)/)
  })
})

describe('垃圾桶按钮的可访问性', () => {
  /*
   * ⚠ 用户明确要求「按下后不要有边框」。
   *   一圈 `outline` 在 1px 边框的小按钮上看起来就像按钮自带的边框。
   */
  it('没有焦点框（outline）', () => {
    expect(ruleBody(css, '\\.trash:focus,[\\s\\S]*?\\.trash:focus-visible')).toMatch(/outline:\s*none/)
  })

  /*
   * ⚠ 但不能什么都不给：`.trash-zone` 默认 `opacity: 0`，
   *   而只用键盘的用户从没悬停过卡片 ⇒ 按钮完全不可见，
   *   等于他根本发现不了这个功能。
   */
  it('键盘用户能看到（focus-within 保留可见性）', () => {
    expect(css).toMatch(/\.mail-item:focus-within\s+\.trash-zone/)
  })
})

describe('复制按钮的样式契约', () => {
  it('是文字按钮（无边框、无底色）', () => {
    const body = ruleBody(css, '\\.copy')
    expect(body).toMatch(/border:\s*0/)
    expect(body).toMatch(/background:\s*transparent/)
  })

  /*
   * ⚠ 复制成功用绿色，并且与 `.copy` 用同样的字号 ——
   *   两者互斥地出现在同一位置，盒模型差一点就会让那一行跳动。
   */
  it('复制成功是绿色，且与复制按钮同字号', () => {
    const done = ruleBody(css, '\\.copy-done')
    expect(done).toMatch(/color:\s*var\(--mp-success\)/)

    const copySize = /font-size:\s*(\d+)px/.exec(ruleBody(css, '\\.copy'))
    const doneSize = /font-size:\s*(\d+)px/.exec(done)
    expect(copySize?.[1]).toBe(doneSize?.[1])
  })
})
