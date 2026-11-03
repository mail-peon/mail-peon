import type { Buffer } from 'node:buffer'
import process from 'node:process'
import { displayHost } from './addresses'
import { ALLOWED_HOSTS, HOST, PORT, REJECT_UNAUTHORIZED, RELAY_TOKEN, TRACE } from './config'

/** 启动成功后的提示（每次启动都打，包括 `r` 重启之后） */
export function logListening(): void {
  log(`IMAP 中继已启动：ws://${displayHost(HOST)}:${PORT}/`)
  log(`在扩展的账号配置里填：${HOST === '127.0.0.1' ? `ws://127.0.0.1:${PORT}/` : 'wss://<你的域名>/'}`)
  if (TRACE) {
    log('⚠️  RELAY_TRACE=1 —— 会把 IMAP 往返打到终端，**包括你的邮箱授权码**。')
    log('    只用来排查问题，看完请关掉（并清一下终端回滚缓冲）。')
  }
  if (!REJECT_UNAUTHORIZED)
    log('⚠️  TLS_REJECT_UNAUTHORIZED=0 —— 不校验证书链，仅限测试环境')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1')
    log('⚠️  正在监听非本机地址：连上来的任何人都能用它连邮件服务器，务必同时设置 RELAY_TOKEN 与 ALLOWED_HOSTS')
  if (!RELAY_TOKEN)
    log('⚠️  未设置 RELAY_TOKEN —— 只应在 127.0.0.1 上使用')
  if (!ALLOWED_HOSTS.length)
    log('⚠️  未设置 ALLOWED_HOSTS —— 允许连任意邮件服务器')
}

/**
 * @param message 日志正文（前缀与时间戳由这里补）
 */
export function log(message: string): void {
  process.stdout.write(`[imap-relay] ${new Date().toISOString()} ${message}\n`)
}

/**
 * 打印一条连接上的原始字节（只在 `RELAY_TRACE=1` 时）。
 *
 * ⚠ 打的是**文本行**，二进制正文只报长度 —— IMAP 的 `FETCH` 会回几千字节的邮件，
 *   整段打出来会把终端刷爆，反而看不到关键的那几行命令。
 *
 * ⚠ 这里会打出 `LOGIN` 命令，也就是**用户的邮箱授权码**。
 *   所以默认关闭，且打开时明确警告（见 `logListening`）。
 *
 * @param direction 箭头方向（→ 扩展发往服务器，← 服务器发往扩展）
 * @param bytes 这一段的原始字节
 */
export function trace(direction: '→' | '←', bytes: Buffer): void {
  if (!TRACE)
    return

  const text = bytes.toString('utf8')

  /*
   * 含控制字符（除 CR/LF）的当作二进制正文，只报长度。
   *
   * eslint-disable 是必要的：这条规则本意是「别在正则里塞控制字符」，
   * 而这里**就是要**判断「有没有控制字符」—— 控制字符正是被检测的对象。
   */
  // eslint-disable-next-line no-control-regex -- 见上：控制字符就是被检测的对象
  if (/[\u0000-\u0008\u000E-\u001F]/.test(text)) {
    log(`  ${direction} （${bytes.length} 字节正文）`)
    return
  }

  for (const line of text.split('\r\n').filter(Boolean).slice(0, 20))
    log(`  ${direction} ${line}`)
}
