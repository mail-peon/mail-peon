import type { MailAccount, MailAddress } from '~/logic/types'
import PostalMime from 'postal-mime'
import { MAX_BODY_CHARS, normalizeAddresses } from '~/logic/store/migrations'
import { fallbackMessageId, mailKey } from '~/logic/types'

/**
 * RFC822 → `Mail` 归一化（`ai-docs/features/01-mail-inbox-connect.md § 5`）。
 *
 * **这一层被两个 provider 共用**，这是刻意的设计：
 *
 *   - IMAP 给的是 `BODY.PEEK[]` 的原始字节；
 *   - Gmail 给的是 `format=raw` 的 base64url 原文。
 *
 * 两者都是**完整 RFC822**，所以「原始邮件 → Mail」只有这一份实现。
 * 如果 Gmail 走 `format=full`（结构化 payload）就得再写一套 payload 解析 ——
 * 那意味着附件、编码、`Content-Type` 边界、RFC 2047 头解码这些坑要踩两遍，
 * 而且两边的行为迟早会分叉。
 *
 * ⚠ 关于用 `postal-mime` 而不是设计文档里写的 `mailparser`：
 *   `mailparser` 依赖 Node 的 `stream` / `Buffer` / `iconv-lite`，在 MV3 Service Worker
 *   里打包会拖进一堆 Node polyfill（体积 + 运行时风险）。`postal-mime` 是零依赖的
 *   纯浏览器实现，API 更小，正好覆盖我们需要的字段。
 */

export interface ParsedMail {
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  /** 纯文本正文；没有 text 部分时由 HTML 退化而来 */
  text: string
  /** 原始 HTML（**MVP 不入库**，只用于文本退化与调试） */
  html: string
  /** 解析出来的时间戳；解析不出时为 `null`（由调用方兜底） */
  date: number | null
  messageId: string | null
  listUnsubscribe: string | null
}

/**
 * 解析一封原始邮件。抛错表示这封邮件根本读不出来（调用方应跳过它、继续处理其余的）。
 *
 * `postal-mime` 的输入类型是 `ArrayBuffer | Blob | string | ...`。给它 `ArrayBuffer`
 * 而不是 `Uint8Array` 是刻意的：TS 的 `ArrayBufferLike` 在不同 TS/lib 版本下
 * 不完全兼容（`SharedArrayBuffer` 那段历史），传 buffer 最省事也最没有歧义。
 */
export async function parseRawMail(source: Uint8Array): Promise<ParsedMail> {
  // ⚠ 不能直接传 `source.buffer`：`Uint8Array` 可能是更大 buffer 上的视图
  //   （IMAP 的字面量切分就常常这样），传底层 buffer 会把邻居的字节也喂进去。
  const email = await PostalMime.parse(source.slice().buffer as ArrayBuffer)

  const html = email.html ?? ''
  const text = email.text ?? (html ? htmlToText(html) : '')

  return {
    from: normalizeAddresses(email.from ? [toRawAddress(email.from)] : []),
    to: normalizeAddresses((email.to ?? []).map(toRawAddress)),
    cc: normalizeAddresses((email.cc ?? []).map(toRawAddress)),
    subject: decodeHeader(email.subject ?? ''),
    text,
    html,
    date: email.date ? Date.parse(email.date) || null : null,
    messageId: normalizeMessageId(email.messageId),
    listUnsubscribe: readHeader(email.headers, 'list-unsubscribe'),
  }
}

function toRawAddress(address: { name?: string, address?: string }): { name: string, address: string } {
  return { name: address.name ?? '', address: address.address ?? '' }
}

function readHeader(headers: Array<{ key: string, value: string }> | undefined, key: string): string | null {
  const found = headers?.find(header => header.key.toLowerCase() === key)
  return found?.value ?? null
}

/**
 * messageId 归一：去掉尖括号。
 *
 * ⚠ 必须做这件事：`Message-ID: <abc@host>` 与 `Message-ID: abc@host` 是同一封邮件，
 *   而账本键是 `<accountId>:<messageId>`。不去尖括号的话，同一封邮件在两次同步里
 *   （一次读头、一次读原始）会算出两个键 —— 症状是**邮件重复入库**。
 */
export function normalizeMessageId(value: string | undefined | null): string | null {
  if (!value)
    return null
  const trimmed = value.trim().replace(/^<|>$/g, '')
  return trimmed || null
}

/**
 * MIME 编码字（RFC 2047）解码。
 *
 * `postal-mime` 已经解过大部分，但主题里嵌套编码 / 折行的情况它偶尔漏掉，
 * 而漏掉的症状是用户看到 `=?UTF-8?B?5LiA5Liq5Li76aKY?=` 这种原文。
 * 这里做一层兜底，**只处理确定能解的部分**，解不出就原样返回（不猜）。
 */
export function decodeHeader(value: string): string {
  if (!value.includes('=?'))
    return value

  try {
    return value.replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)(\s+(?==\?[^?]+\?[BQ]\?))/gi, '$1').replace(
      /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
      (match, charset: string, encoding: string, payload: string) => {
        try {
          const bytes = encoding.toUpperCase() === 'B'
            ? base64ToBytes(payload)
            : quotedPrintableToBytes(payload)
          return new TextDecoder(charset.toLowerCase()).decode(bytes)
        }
        catch {
          return match
        }
      },
    )
  }
  catch {
    return value
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

function quotedPrintableToBytes(value: string): Uint8Array {
  const cleaned = value.replace(/_/g, ' ')
  const out: number[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.slice(i + 1, i + 3)
      if (/^[0-9A-F]{2}$/i.test(hex)) {
        out.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    out.push(cleaned.charCodeAt(i))
  }
  return new Uint8Array(out)
}

/**
 * HTML → 纯文本。
 *
 * ⚠ 刻意**不用 DOM 解析**（`DOMParser` / `innerHTML`）：这段代码跑在 Service Worker 里，
 *   SW 没有 DOM。手写正则虽然土，但它是唯一在三种上下文（SW / 页面 / 测试）里都能
 *   跑的方案，而且我们只需要「够 AI 读」的文本，不需要精确还原排版。
 *
 * 顺序很重要：先把 `<script>` / `<style>` 整块删掉，再换行标签，最后剥标签 ——
 * 反过来做的话，被剥掉的标签之间的脚本内容会混进正文（AI 会看到一堆 JS）。
 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** `snippet` = text 前 240 字（设计文档的字段定义） */
export const SNIPPET_CHARS = 240

/**
 * `ParsedMail` + 账号 → `Mail`。
 *
 * `receivedAt` 的取值优先级（顺序不能换）：
 *   1. `fallbackDate`（provider 给的服务器时间：IMAP 的 `INTERNALDATE`、Gmail 的
 *      `internalDate`）—— 它表达「邮件什么时候到的服务器」，比 `Date:` 头可靠得多，
 *      因为 `Date:` 是发件人写的、可以任意伪造或干脆是错的（时区错的邮件很常见）。
 *   2. `Date:` 头。
 *   3. `Date.now()`。
 */
export function toMail(
  parsed: ParsedMail,
  account: Pick<MailAccount, 'id'>,
  options: { fallbackDate?: number, messageId?: string } = {},
): import('~/logic/types').Mail {
  const messageId = normalizeMessageId(options.messageId) ?? parsed.messageId ?? fallbackMessageId()
  const receivedAt = options.fallbackDate ?? parsed.date ?? Date.now()
  const bodyText = parsed.text.slice(0, MAX_BODY_CHARS)

  return {
    id: mailKey(account.id, messageId),
    accountId: account.id,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc.length ? parsed.cc : undefined,
    subject: parsed.subject,
    snippet: parsed.text.slice(0, SNIPPET_CHARS),
    bodyText,
    // ⚠ MVP 不存 HTML（隐私 + 体积）。要展示时按 messageId 重拉。
    bodyHtml: undefined,
    receivedAt,
    processing: 'pending',
    copyStatus: 'none',
    read: false,
    messageId,
    listUnsubscribe: parsed.listUnsubscribe ?? undefined,
  }
}

/** 取第一个发件人的展示串（`Name <a@b.com>`），供 toast / badge 用 */
export function formatSender(from: MailAddress[]): string {
  const first = from[0]
  if (!first)
    return '(未知发件人)'
  if (first.name && first.address)
    return `${first.name} <${first.address}>`
  return first.name || first.address || '(未知发件人)'
}

/** 取域名（规则匹配 / 排除列表用） */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1 ? '' : address.slice(at + 1).toLowerCase()
}
