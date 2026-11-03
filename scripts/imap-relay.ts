/**
 * mail-peon IMAP 中继 —— WebSocket ↔ 原始 TCP 的**字节透传**隧道。
 *
 * ## 为什么需要它
 *
 * 浏览器扩展里**没有裸 TCP**：MV3 的 Service Worker 只有 `fetch` / `WebSocket`，
 * `chrome.sockets.tcp` 只属于已废弃的 Chrome Apps（第三方扩展拿不到），
 * 而 `imapflow` / `emailjs-imap-client` 依赖 Node 的 `net` / `tls`，在 SW 里直接炸。
 * 于是「IMAP + 用户名密码」这条通用路线必须借一条隧道。
 *
 * ## ⚠️ 中继能看到你的邮箱凭据
 *
 * 这一点必须说清楚，不能含糊：
 *
 * TLS 是**连接的端点行为**，不是线缆上的开关。中继要连上 `imap.x.com:993`
 * （implicit TLS），就必须自己完成 TLS 握手 —— 而握手完成后，那条连接上的
 * **明文就在中继进程里**，包括 `LOGIN` 命令里的用户名与授权码。
 *
 * 所以中继**默认只绑 `127.0.0.1`**：跑在你自己机器上时，「中继能看到凭据」
 * 等于「你自己的电脑能看到凭据」，没有引入任何新的信任方。
 * 把它放到公网（`HOST=0.0.0.0`）之前请先想清楚这件事。
 *
 * 中继不做的事：不解析 IMAP、不记录邮件内容、不落盘、不主动上报。
 *
 * ## 用法
 *
 * ```bash
 * pnpm relay                       # 监听 127.0.0.1:41316
 * TLS_REJECT_UNAUTHORIZED=0 pnpm relay   # 允许自签证书的邮件服务器（仅测试）
 * ```
 *
 * 然后在扩展的「设置 · 账号」里把中继地址填成 `ws://127.0.0.1:41316/`。
 *
 * ## 类型标注
 *
 * 这个文件是 `.ts`（从 `.mjs` 改名而来），类型直接写在签名上 ——
 * 不是为了好看，而是因为中继里「TCP socket 与 WebSocket 的流控语义」太容易写错，
 * 而静态检查能挡住 `socket.pause` / `ws.pause` 用混这类错误。
 *
 * ⚠ **模块顶层不能写 `await`**：根 `package.json` 没有 `"type": "module"`，
 *   esno（esbuild）会把这个文件编译成 CommonJS，而 CJS 输出格式下 esbuild 直接报
 *   「Top-level await is currently not supported with the "cjs" output format」——
 *   中继**一个字节都不会发**，`pnpm relay` 与冒烟测试全部起不来（实测踩过）。
 *   所以入口调用 `relay/cli.ts` 的 `runRelayCli()`，由它启动异步 `main()`。
 */

import { runRelayCli } from './relay/cli'

runRelayCli()
