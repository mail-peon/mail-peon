import type { RawData } from 'ws'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createServer as createTlsServer } from 'node:tls'
import { WebSocket } from 'ws'
import { spawnScript } from './runScript'

/**
 * IMAP 中继的**端到端**冒烟测试。
 *
 * 覆盖四件事，每一件都对应一个「真机上才会暴露、而且极难归因」的失效模式：
 *
 * 1. **字节原样往返**（含 CRLF 与二进制）—— 粘包 / 半包 / 方向搞反
 * 2. **256 KB 大块不丢字节** —— 邮箱推得快、WebSocket 慢时的堆积与截断
 * 3. **TLS 握手真的发生了** —— 这是「`tls` 参数曾被忽略」那个 bug 的回归测试：
 *    中继必须用 `tls.connect()` 连邮件服务器，而不是裸 `net.connect()`
 * 4. **`tls=0` + 993 被明确拒绝** —— 而不是静默地用明文去连一个 implicit TLS 端口
 *
 * 用法：`pnpm relay:test`
 */

const RELAY_PORT = 18899
/** 第二个中继实例的端口（用来验证「证书校验默认开启」时用另一套环境变量） */
const STRICT_PORT = 18896
/** TLS 回声服务器：用自签证书，用来验证中继确实做了 TLS 握手 */
const TLS_ECHO_PORT = 18897
/** 明文回声服务器 */
const ECHO_PORT = 18898

/** 等一会儿（中继是独立进程，只能靠等它起来） */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 把 ws 给的 `RawData` 归一成 `Buffer`。
 *
 * ⚠ 不能直接 `Buffer.from(data)`：`RawData = Buffer | ArrayBuffer | Buffer[]`，
 *   而 `Buffer.from` 对 `ArrayBuffer` 的重载在 TS 里与「字符串/类数组」那组
 *   不兼容（`ArrayBuffer` 不是 `ArrayLike<number>`）。真机上也确实会遇到
 *   三种形态 —— 取决于 `binaryType` 与是否分片。所以显式分支处理。
 *
 * @param data ws 回调给的原始数据
 * @returns 归一后的字节
 */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data))
    return data
  if (data instanceof ArrayBuffer)
    return Buffer.from(data)
  // Buffer[]：分片到达，拼起来
  return Buffer.concat(data)
}

async function main() {
  const failures: string[] = []

  /**
   * 记一条断言结果。
   *
   * @param name 断言描述
   * @param ok 是否通过
   * @param detail 失败时的补充信息
   */
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (ok) {
      process.stdout.write(`  ✅ ${name}\n`)
    }
    else {
      failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
      process.stdout.write(`  ❌ ${name}${detail ? ` — ${detail}` : ''}\n`)
    }
  }

  // ---------- 明文回声服务器 ----------
  const echo = createNetServer((socket) => {
    socket.on('data', chunk => socket.write(chunk))
  })
  await new Promise(resolve => echo.listen(ECHO_PORT, '127.0.0.1', () => resolve(undefined)))

  // ---------- TLS 回声服务器 ----------
  const tlsPair = makeSelfSigned()
  /** @type {import('node:tls').Server | null} */
  let tlsEcho = null
  if (tlsPair) {
    /*
     * ⚠ 赋给局部 const 再 listen：TS 的 `let tlsEcho: Server | null` 在
     *   `await` 之后的闭包里会**丢掉收窄**（闭包可能在赋值之后再执行），
     *   于是 `tlsEcho.listen` 报「可能是 null」。用局部 const 把收窄固定下来。
     */
    const server = createTlsServer({ key: tlsPair.key, cert: tlsPair.cert }, (socket) => {
      socket.on('data', chunk => socket.write(chunk))
    })
    await new Promise(resolve => server.listen(TLS_ECHO_PORT, '127.0.0.1', () => resolve(undefined)))
    tlsEcho = server
  }

  // ---------- 中继 ----------
  /*
   * ⚠ 用 `spawnScript` 而不是 `spawn(process.execPath, ['scripts/imap-relay.ts'])`：
   *   Node 不认 `.ts`，必须经 esno 跑（见 `runScript.ts` 的说明）。
   *   之前这里读 `RELAY_SCRIPT` 环境变量，现在脚本路径是固定的，那个开关没必要了。
   */
  const child = spawnScript('scripts/imap-relay.ts', [], {
    // ⚠ 只对「自签证书」那一组断言放开证书校验；下面还有单独的用例验证默认是拦的
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', ALLOWED_HOSTS: '127.0.0.1,localhost', TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /*
   * ⚠ `?.` 不是多余的防御：`spawn` 的返回类型在 `stdio` 是数组字面量时会被
   *   TS 推成一个交叉类型，`stdout` 在那里面可能是 `null`。运行期它一定存在
   *   （我们显式要了 `pipe`），但类型上要收一下。
   */
  child.stdout?.on('data', chunk => process.stdout.write(`  relay> ${chunk}`))
  child.stderr?.on('data', chunk => process.stderr.write(`  relay! ${chunk}`))

  await wait(1200)

  try {
    // ===== 1. 基本往返 =====
    {
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/127.0.0.1:${ECHO_PORT}?tls=0`)
      ws.binaryType = 'arraybuffer'
      const received: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      check('WebSocket 建连成功', true)
      ws.on('message', data => received.push(toBuffer(data)))

      const payload = Buffer.concat([
        Buffer.from('A0001 LOGIN "me@x.com" "p@ss\\"word"\r\n', 'utf8'),
        Buffer.from([0x00, 0xFF, 0x0D, 0x0A, 0x7F]),
      ])
      ws.send(payload)
      await wait(400)
      const echoed = Buffer.concat(received)
      check('字节原样回传（含 CRLF 与二进制）', echoed.equals(payload), `收到 ${echoed.length} / 期望 ${payload.length} 字节`)

      // ===== 2. 256 KB 大块 =====
      received.length = 0
      const big = Buffer.alloc(256 * 1024)
      for (let i = 0; i < big.length; i++)
        big[i] = i % 251
      ws.send(big)
      await wait(900)
      const bigEcho = Buffer.concat(received)
      check('256 KB 大块不丢字节', bigEcho.length === big.length && bigEcho.equals(big), `收到 ${bigEcho.length} / 期望 ${big.length}`)

      ws.close()
      await wait(300)
      check('关闭 WebSocket 后中继仍存活（不崩）', child.exitCode === null)
    }

    // ===== 3. TLS 握手真的发生了（回归：tls 参数曾被忽略）=====
    if (tlsEcho) {
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/127.0.0.1:${TLS_ECHO_PORT}?tls=1`)
      ws.binaryType = 'arraybuffer'
      const received: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      ws.on('message', data => received.push(toBuffer(data)))

      // 明文 IMAP 命令经中继 → TLS 握手 → TLS 回声服务器 → 原路回来
      ws.send(Buffer.from('A0001 CAPABILITY\r\n', 'utf8'))
      await wait(600)
      const echoed = Buffer.concat(received).toString('utf8')
      check(
        'tls=1 时中继用 TLS 连服务器（握手成功并回传 IMAP 命令）',
        echoed.includes('A0001 CAPABILITY'),
        `收到: ${JSON.stringify(echoed.slice(0, 80))}`,
      )
      ws.close()
      await wait(200)
    }
    else {
      process.stdout.write('  ⏭  跳过 TLS 断言（无法生成自签证书）\n')
    }

    // ===== 3b. 证书校验默认必须是**开**的 =====
    //
    // 这一条守的是一个安全属性，不是一个功能：`TLS_REJECT_UNAUTHORIZED` 是
    // 「本机自签证书」的逃生口，一旦默认值写反，中间人攻击就不可检出了 ——
    // 而那种错误在功能测试里完全看不出来（连接照样成功）。
    if (tlsEcho) {
      const strict = spawnScript('scripts/imap-relay.ts', [], {
        // 刻意**不设** TLS_REJECT_UNAUTHORIZED
        env: { ...process.env, PORT: String(STRICT_PORT), HOST: '127.0.0.1', ALLOWED_HOSTS: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      strict.stdout?.on('data', chunk => process.stdout.write(`  strict> ${chunk}`))
      strict.stderr?.on('data', chunk => process.stderr.write(`  strict! ${chunk}`))
      await wait(1200)

      try {
        const err = await new Promise<string | number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${STRICT_PORT}/127.0.0.1:${TLS_ECHO_PORT}?tls=1`)
          let settled = false

          /** 收口：只允许 settle 一次（三条路径都会调它） */
          const done = (value: string | number): void => {
            if (settled)
              return
            settled = true
            resolve(value)
            try {
              ws.terminate()
            }
            catch {}
          }
          ws.once('open', () => {
            // 升级成功，接下来要么收到服务器发来的数据（= 握手通过了，坏），
            // 要么被中继关掉（= 校验生效了，好）
            ws.once('message', () => done('handshake-succeeded'))
            ws.once('close', code => done(`closed:${code}`))
            // 用 setTimeout 的第三个参数传值，而不是包一层箭头函数（省一次分配）
            setTimeout(done, 1500, 'no-data')
          })
          ws.once('error', () => done('error'))
        })
        check(
          '默认拒绝自签证书（TLS_REJECT_UNAUTHORIZED 默认开）',
          err !== 'handshake-succeeded' && err !== 'no-data',
          `结果 ${err}`,
        )
      }
      finally {
        strict.kill()
      }
    }

    // ===== 4. 993 端口必须走 TLS：tls=0 连 993 应被拒 =====
    {
      const result = await expectPolicyClose(`ws://127.0.0.1:${RELAY_PORT}/127.0.0.1:993?tls=0`)
      check(
        'tls=0 + 993 被拒（而不是静默用明文去连 implicit TLS 端口）',
        result === 1008,
        `关闭码 ${result}`,
      )
    }

    // ===== 5. 白名单拒绝 =====
    {
      const result = await expectPolicyClose(`ws://127.0.0.1:${RELAY_PORT}/imap.notallowed.com:993?tls=1`)
      check('ALLOWED_HOSTS 之外的 host 被拒（1008）', result === 1008, `关闭码 ${result}`)
    }

    // ===== 6. 拒绝之后进程还活着 =====
    //
    // 对应的是一类「中继崩了但没人知道」的故障：进程退出后扩展侧只表现为
    // 「突然所有账号都收不到邮件」，用户没有任何线索。
    await wait(200)
    check('多次策略拒绝之后中继仍存活', child.exitCode === null)
  }
  finally {
    child.kill()
    await new Promise(resolve => echo.close(resolve))
    if (tlsEcho)
      await new Promise(resolve => tlsEcho.close(() => resolve(undefined)))
  }

  process.stdout.write('\n')
  if (failures.length) {
    process.stdout.write(`失败 ${failures.length} 项：\n${failures.map(item => `  - ${item}`).join('\n')}\n`)
    process.exitCode = 1
  }
  else {
    process.stdout.write('IMAP 中继冒烟测试全部通过\n')
  }
}

/**
 * 连一条**预期会被中继拒绝**的连接，返回它的关闭码。
 *
 * ⚠ 不能断言「没触发 open」：WebSocket 的升级握手由 HTTP server 先完成，
 *   中继的策略检查发生在 `connection` 事件里 —— 所以 `open` **一定会先触发**，
 *   然后才是 `close(1008)`。断言 open 没发生是错的（第一版就写错了），
 *   真正要验的是「它被以策略违规关闭，而不是被放行」。
 *
 * 超时返回 `'timeout'`：那才是「被静默放行」的表现。
 *
 * @param url 要连的 WebSocket 地址
 * @param timeoutMs 等多久算「被静默放行」
 * @returns 关闭码，或 `'error'` / `'timeout'`
 */
function expectPolicyClose(url: string, timeoutMs = 3000): Promise<number | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false

    /** 收口：只允许 settle 一次（三条路径都会调它） */
    const done = (value: number | 'error' | 'timeout'): void => {
      if (settled)
        return
      settled = true
      resolve(value)
      try {
        ws.terminate()
      }
      catch {}
    }

    ws.once('close', code => done(code))
    ws.once('error', () => done('error'))
    setTimeout(done, timeoutMs, 'timeout')
  })
}

/**
 * 生成一对自签证书。
 *
 * 优先用 openssl（几乎处处都有）；没有就返回 null，调用方跳过 TLS 断言 ——
 * 宁可少测一条，也不要让整套测试因为环境缺工具而失败。
 */
function makeSelfSigned() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mail-peon-relay-test-'))
    const keyPath = join(dir, 'key.pem')
    const certPath = join(dir, 'cert.pem')

    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' })

    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
  }
  catch {
    return null
  }
}

main().catch((error) => {
  process.stderr.write(`测试自身出错：${error?.stack ?? error}\n`)
  process.exitCode = 1
})
