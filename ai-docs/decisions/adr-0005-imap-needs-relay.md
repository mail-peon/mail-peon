# ADR-0005 · IMAP 在 MV3 里必须经 WebSocket↔TCP 中继

- **状态**：已采纳（2026-XX-XX）
- **影响面**：`adapters/mail`、`manifest.ts`、Options · 账号页、部署方式
- **推翻的文档结论**：`decisions/open-questions.md` Q1（「MVP 用 IMAP + 邮箱密码」）
  与 `02-tech-stack.md § 3.1`（「`emailjs-imap-client` 纯 JS、浏览器里能跑」）

---

## 背景

设计文档把 MVP 的邮箱接入定为「IMAP + 用户名密码」，并把
`emailjs-imap-client` 列为候选，理由是「纯 JS IMAP4 客户端，浏览器里能跑」。

实现阶段核实后，这条结论**不成立**。

---

## 问题

**浏览器扩展拿不到裸 TCP。** 具体三条，任一条都足以否决原方案：

| # | 事实 | 后果 |
| --- | --- | --- |
| 1 | MV3 的 Service Worker 只有 `fetch` / `WebSocket` / `WebTransport`，没有 socket API | 无法直接发 IMAP 的字节流 |
| 2 | `chrome.sockets.tcp` 只属于 **Chrome Apps**（平台本身已废弃），第三方**扩展**拿不到 | 没有「扩展自己的 TCP」这条路 |
| 3 | `imapflow` / `emailjs-imap-client` 依赖 Node 的 `net` / `tls` / `stream` | 打进 SW 会因缺少 Node 内建模块而**构建期或运行期直接失败** |

`fetch` 也无济于事：IMAP 是**有状态的长连接 + 服务端主动推送**的协议，
而 `fetch` 是无状态请求/响应，两者模型不兼容。

---

## 决策

**双轨**：

1. **首选 Gmail API（OAuth 2.0）** —— 纯 HTTPS REST，浏览器原生支持，
   装上就能收到真邮件。实现为 `adapters/mail/providers/gmail/`。
2. **IMAP 保留，但走 WebSocket↔TCP 中继** —— 把「字节怎么出去」抽成
   `MailSocket`（`adapters/mail/transport/types.ts`），协议层
   （`providers/imap/client.ts`，自研的极简 IMAP4rev1 客户端）**完全不依赖环境**。
   中继的一个可用实现随仓库提供：`scripts/imap-relay.ts`。

### 为什么自研 IMAP 客户端而不是用现成库

`imapflow` / `emailjs-imap-client` 都绑死 Node 的 `net`。要复用它们，
要么打一堆 Node polyfill（体积 + 运行时风险），要么等它们支持自定义传输。
自研的代价被限定在两件事上，而我们只需要其中很小的一部分：

- 命令：`LOGIN` / `SELECT` / `UID FETCH` / `UID SEARCH` / `LOGOUT`
- 解析：**字面量**（`{N}` 后的精确 N 字节）与行内扫描（不做语法树、不做括号配对）

`postal-mime`（零依赖、纯浏览器）负责 MIME 解析。

### 为什么这条中继不违背「不做服务端中转」

设计文档的非目标是「不做**服务端中转**」，理由是**邮件隐私敏感**。
本方案的隐私性质与之不冲突：

- TLS 在**扩展与邮件服务器之间**端到端建立，中继只搬运**密文**；
- 中继不解析 IMAP、不落盘、不知道用户读了哪封；
- 它是**用户自己的**基础设施（自带、自部署），不是一个我们运营的共享服务；
- 中继是**可选的**：只用 Gmail 的用户完全不需要它。

一句话：它是一根网线，不是一个服务。

---

## 后果

### 好的

- **Gmail 用户零配置**就能用（除了一次 OAuth 授权）。
- 两条路径在「原始 RFC822 → `Mail`」这一步**完全共用代码**：Gmail 用
  `format=raw` 拿完整原文，IMAP 用 `BODY.PEEK[]` 拿原始字节，都喂同一个
  `parser.ts`。不存在「两套 payload 解析各自踩坑」。
- IMAP 的协议逻辑可单测（`MailSocketFactory` 可注入假实现），
  不需要真邮箱、真网络。
- 将来若出现别的传输（native messaging、更完善的 `WebTransport`），
  **只加一个 `MailSocket` 实现，协议层一行不用改**。

### 代价（必须如实记录）

- **IMAP 不是开箱即用**：用户要自己起一个中继。这一条会显著降低
  「非 Gmail 用户」的转化。
- Gmail OAuth 要求用户**自建 Google Cloud OAuth 客户端**（扩展类型 + 重定向 URI）。
  根本原因是设计文档「不做服务端中转」⇒ 没有服务端托管 client secret ⇒
  只能让用户自带凭据。上架时若审查要求「开箱即用」，这一条要重新决策。
- 自研 IMAP 客户端意味着**协议兼容性由我们负责**：目前只覆盖
  `INBOX` + 增量 `UID FETCH`，没有文件夹切换、没有 `\Seen` 回写、
  没有 `CONDSTORE` / `QRESYNC` 这类扩展。
  常驻的 `IDLE` 放在**中继**里（见下），不在这个客户端里 ——
  客户端只做「连一次、抓一批、断开」。
  这些缺口在功能上都是「有意不做」，但将来要加时不能指望上游修 bug。

### 长连接放在中继里

既然中继已经存在，**常驻 IMAP 连接就放在它那里**：

| | 理由 |
| --- | --- |
| 插件侧做不到 | MV3 Service Worker 空闲约 30 秒被回收，常驻连接保不住 |
| 中继天然合适 | 普通 Node 进程，可以长时间挂着 `IDLE` |
| 不扩大信任面 | 中继为了通 TLS 本来就要终止握手、看得到明文（包括邮箱密码） |

于是实时性来自中继，而插件保持「被推醒 → 单次连接抓增量 → 继续待命」。
插件另有一个低频 `chrome.alarms` 兜底，用于「中继没起 / 连接没恢复」的情况。

见 [`../design/sync-flow.md`](../design/sync-flow.md)。

### 后续

- Outlook / Microsoft Graph 走同一套 REST 模式（`providers/outlook/`），
  没有新的架构问题。
- 若将来 CRX 审查要求收窄 `host_permissions`，中继的 host 需要用户显式授权 ——
  它已经在用户的账号配置里，但 `*://*/*` 那条（给 content script 用）要另外处理。

---

## 补充（后续决策）

- **中继怎么交付给用户**：见 [`relay-deployment.md`](./relay-deployment.md)。
  结论是「用户级自启 + Rust 单安装器（安装/卸载两个选项）」——
  「零额外安装」与「不做公共中继」互斥，已在那边论证。
- **⚠️ 实现缺陷（已修复）**：`scripts/imap-relay.ts` 原用裸 `net.connect()` 连邮件
  服务器，`tls` 参数被解析但从未使用 —— 993 是 implicit TLS，所以 IMAP 当时实际连不上。
  现已改为 `tls.connect({ host, port, servername })`（`servername` 是 SNI，不能省），
  并加上了「证书链默认校验」「`tls=0` + 993 直接拒绝」两条保护。
  同批修的还有一个**会导致整个中继进程崩溃**的 bug：WebSocket 关闭原因超过 123 字节时
  `ws.close()` 会抛异常，一个非法请求即可 DoS。详见
  [`relay-deployment.md § 5`](./relay-deployment.md)。
