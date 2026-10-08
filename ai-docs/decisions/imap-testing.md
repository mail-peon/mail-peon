# IMAP 验收指南（QQ 邮箱）

> 目的：用真实邮箱验证「扩展 → 中继 → IMAP 服务器」这条链路的**协议正确性**。
> 这一步与「中继用什么语言写、怎么打包、怎么签名」无关 —— 见
> [`relay-deployment.md § 5`](./relay-deployment.md#5-落地顺序已确认)。

---

## 0. 前置：✅ 已就绪

中继的 `tls` 已修复（原先是裸 `net.connect()` 连 993，必失败）。现在的行为：

- `tls=1` → 用 `tls.connect()` 连服务器，**证书链默认校验**（SNI 已带上）
- `tls=0` + 993 端口 → **直接拒绝**，而不是静默用明文去连一个只接受 TLS 的端口
- 自签证书的测试服务器：`TLS_REJECT_UNAUTHORIZED=0 pnpm relay`

自测中继本身是否正常（不需要真邮箱）：

```bash
pnpm relay:test
```

预期 9 条断言全绿。

---

## 1. QQ 邮箱侧准备

来源：[QQ 邮箱官方帮助 · 如何开启 POP3/SMTP/IMAP 服务并获取授权码](https://help.mail.qq.com/detail/0/1087)

QQ 邮箱**默认关闭**第三方客户端服务，所以不能直接用网页登录密码。

1. 登录 QQ 邮箱网页版
2. 顶部导航「**设置**」→「**账号与安全**」
3. 找到「**POP3/IMAP/SMTP/Exchange/CardDAV 服务**」区域 → 打开 **IMAP** 开关
4. 按提示用绑定手机号发短信验证，点「我已发送」
5. 页面弹出 **16 位授权码** → 复制保存

> ⚠️ **授权码 ≠ 邮箱密码**。第三方客户端登录时：
> **用户名填完整邮箱地址**，**密码栏填这串 16 位授权码**。
> 直接在密码栏填 QQ 密码会登录失败。

---

## 2. 中继侧

```bash
cd D:\Projects\mail-peon
pnpm relay
```

预期输出（默认绑 `127.0.0.1:8787`）：

```
[imap-relay] IMAP 中继已启动：ws://127.0.0.1:8787/
[imap-relay] 在扩展的账号配置里填：ws://127.0.0.1:8787/
中继运行中 › [r] 重启  [q] 退出
>
```

> PowerShell 中文显示乱码是控制台编码问题（GBK），不是脚本坏了。
> 先 `chcp 65001` 可看清。

### 交互式控制台

| 按键 | 作用 |
| --- | --- |
| `r` + 回车 | **重启**中继（先断开所有连接再重新监听） |
| `q` + 回车 | 退出 |
| `Ctrl+C` / `SIGTERM` | 同上（走同一套清理） |

**重启会主动断开现有连接**，因为 `ws` 的 `server.close()` 会等连接自己结束，
而 watch 连接是**常驻**的（一直挂着 `IDLE`）—— 不主动断的话，
「重启」会表现为「敲了 r 没反应」。

⚠️ **只在交互式终端里生效**。中继的长期形态是后台服务（见
[`relay-deployment.md`](./relay-deployment.md)），而服务没有 TTY —— 那种情况下会打印
「（非交互式终端：q 退出 / r 重启 不可用，用 Ctrl+C 结束）」并正常跑下去，
不会因为等一个永远不来的 stdin 而卡住。

这一条有**真 TTY 测试**覆盖（`pnpm relay:console-test`，用 winpty 起一个真终端
喂按键）—— 因为 `process.stdin.isTTY` 在管道下恒为 false，普通自动化测试
**永远走不到**那些分支。

### 端口被占用：`我明明关了终端`

真机上很常见，而且**不是错觉**。三个原因叠在一起：

1. `pnpm relay` 会再 fork 两层（`pnpm` → `esno` → `node`），
   关掉终端窗口不一定会带走子进程；
2. 在 IDE 的终端里按「停止」有时只结束了外层 shell；
3. 中继被当成**后台任务**起过（编辑器插件、`Start-Job`）时，它压根没有前台窗口可关。

**处理方式是启动时问一句**，不需要用户自己去执行别的命令：

```
[imap-relay] 端口 8787 已被占用（PID 9072）。
[imap-relay]   多半是上一次的中继没退干净 —— 关掉终端窗口不一定会带走它
[imap-relay]   （`pnpm relay` 会再 fork 一层 node，IDE 的「停止」有时只结束了外层 shell）。
要结束 PID 9072 并用端口 8787 启动吗？[Y/n]
```

- 回车 / `y` → 结束占用者并继续启动（会打印 `已结束 PID 9072`）
- `n` → 不杀、不启动，并给出换端口的命令
- **非交互式**（管道 / 后台服务）→ 不问、直接退出并提示，不会卡在一个永远不来的回答上
- 查不出占用者 PID（`netstat` / `lsof` 不可用）→ 不猜，直接提示换端口

`relay:kill` 仍保留，给脚本化场景用（它只杀两类进程：正在监听目标端口的，
以及命令行里含 `imap-relay` 的—— 不做「杀掉所有 node」那种事）。

这条交互有**真 TTY 测试**覆盖（`pnpm relay:port-test`，13 条断言，三种回答都验）。

> ⚠️ 测试里断言输出时必须**先去掉空白**：`winpty` 会在第 80 列硬换行，
> 所以 `IMAP 中继已启动` 收到的是 `IMAP 中继已启\r\n动`。
> 直接用 `includes()` 会假失败 —— 而假失败的断言比没有断言更糟，
> 它会逼着后来的人去改正确的代码。

### ⚠️ 配置项一律走命令行参数

三个平台语法**完全一致**：

| 配置 | 命令行 | 环境变量 |
| --- | --- | --- |
| 端口 | `pnpm relay --port 8788` | `PORT=8788` |
| 监听地址 | `pnpm relay --host 0.0.0.0` | `HOST=0.0.0.0` |
| 令牌 | `pnpm relay --token xxx` | `RELAY_TOKEN=xxx` |
| 白名单 | `pnpm relay --allow-hosts imap.qq.com` | `ALLOWED_HOSTS=…` |
| 不校验证书 | `pnpm relay --tls-reject-unauthorized 0` | `TLS_REJECT_UNAUTHORIZED=0` |

**不要写 `PORT=8788 pnpm relay`** —— 那是 **bash 语法**。PowerShell 会把
`PORT=8788` 当成命令名去找，报「术语 'PORT=8788' 不会被识别为 cmdlet、函数、
脚本文件或可执行程序的名称」。PowerShell 里要写 `$env:PORT=8788; pnpm relay`。

环境变量那条路保留着，因为**后台服务形态靠它注入配置**（服务没有命令行）。
优先级是：命令行参数 → 环境变量 → 默认值。

---

## 3. 扩展侧配置

「设置 · 账号」→ 新增账号，按下表填：

| 字段 | 值 |
| --- | --- |
| 备注名 | 随便（如「QQ 邮箱」） |
| 邮箱地址 | `你的QQ号@qq.com` |
| 协议 | `IMAP（用户名密码）` |
| IMAP 服务器 | `imap.qq.com` |
| 端口 | `993` |
| 使用 TLS | ✅ **必须开**（993 是 implicit TLS） |
| 用户名 | `你的QQ号@qq.com`（完整地址） |
| 密码 / 应用专用密码 | **16 位授权码**（不是 QQ 密码） |
| WebSocket 中继地址 | `ws://127.0.0.1:8787/` |

然后点「**测试连接**」。

---

## 4. 验收清单

按顺序观察，每条都要对上。**第 2 条是最容易实现错的**，也是设计文档的硬约束。

- [ ] **① 测试连接通过** —— 返回「收件箱有 N 封邮件，UIDVALIDITY …」
      （N 应该是你 QQ 邮箱里真实的邮件总数）

- [ ] **② 首次同步拉取 0 封，只写同步位置**
      点「设置 · 通用 → 立即同步增量」，预期：
      - 提示「首次同步只记录同步位置，不会拉取历史邮件」
      - 拉取 `0` 封
      - 「存储用量」条数**不变**
      - `extension` 侧不要出现任何新邮件

      > 这条是 `decisions/open-questions.md` Q5 的硬约束。
      > 若这里灌进来一堆历史邮件，说明游标逻辑写错了。

- [ ] **③ 第二次同步能拉到新邮件**
      给这个 QQ 邮箱**发一封测试邮件**（从别的邮箱发，或自己给自己发），
      然后再点一次「立即同步增量」，预期拉到 ≥1 封。

- [ ] **④ 邮件出现在 Popup**
      点浏览器工具栏图标 → 能看到那封邮件。
      完整模式下应有 AI 生成的摘要（前提是 AI Key 已配好并测试通过）。

- [ ] **⑤ 解析正确**
      检查这四项没有乱码 / 丢失：
      - 发件人名（中文发件人要看 RFC 2047 解码对不对）
      - 主题（同上）
      - 时间（看时区有没有偏）
      - 正文（看有没有被 HTML 标签污染）

- [ ] **⑥ 验证码链路（可选但推荐）**
      用这个 QQ 邮箱去某个网站注册/登录，触发一封验证码邮件 →
      页面顶部应弹出 toast，且验证码已进剪贴板。

---

## 5. 出问题时怎么定位

| 现象 | 最可能的原因 |
| --- | --- |
| 「当前环境没有裸 TCP，IMAP 需要配置一个中继地址」 | 中继地址字段没填 |
| 中继终端没有任何 `CONNECT` 输出 | 扩展没连上中继（地址/端口不对，或中继没运行） |
| 中继有 `CONNECT … (tls)` 但立刻 `CLOSE … tcp error` | 服务器地址 / 端口错，或网络不通 |
| `CLOSE … tcp error: UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 邮件服务器用了自签证书（正常服务器不会）。测试环境可设 `TLS_REJECT_UNAUTHORIZED=0` |
| 「登录失败」 | 密码栏填的不是 16 位授权码，或用户名不是完整邮箱地址 |
| 「无法打开收件箱」 | 账号缺 IMAP 权限（QQ 邮箱没开 IMAP 服务） |
| 测试通过但同步拉不到新邮件 | QQ 邮箱可能把测试邮件归到了「广告邮件」「订阅邮件」等文件夹 —— 本扩展**只读 INBOX** |

### 中继日志会显示什么

```
CONNECT imap.qq.com:993
CLOSE  imap.qq.com:993（ws closed）
```

它**不打印任何邮件内容或凭据**。但要知道：
**中继能看到你的授权码**（它必须完成 TLS 握手的对端行为）——
所以中继要跑在自己机器上（默认绑 `127.0.0.1` 就是为了这个）。

---

## 6. 已知限制（本次验收不用管）

- 只读 `INBOX`，不切换文件夹（QQ 邮箱的「广告邮件」等分类看不到）
- 只读 INBOX，**不做** IDLE 之外的长连接操作（如 `\Seen` 回写）
- 不回写 `\Seen`（不会改动你在 QQ 邮箱里的未读状态 —— 这是**有意**的）
- 首次同步**故意**不拉历史（这是产品约束，不是 bug）

---

## 7. 积压处理（大邮箱必读）

> 这一节记录一次真机故障，因为它决定了「游标落后几千封」时会发生什么。

### 症状

邮箱 35492 封、游标停在 `UID 37727`，点「立即同步增量」后 UI 报
**「请求超时（background 可能正在休眠）」**，而中继日志里
`CONNECT imap.qq.com:993 (tls)` 之后再无输出。

### 根因（两个，叠在一起）

1. **拉的是整段积压的正文。** 当时实现用 `UID FETCH <cursor+1>:*`，
   服务器会把游标之后**所有**邮件正文都发过来；代码里的 `limit: 50` 只是
   **收完之后**在客户端做的截断。几千封 × 每封几十 KB → 必然撞爆
   IMAP 客户端的 30 秒命令超时。
2. **而且它丢邮件。** 它保留的是**最新**的 50 封，然后把游标推到 `UIDNEXT - 1` ——
   中间那几千封因为游标已经越过它们，**永远不会再被拉取**。界面上完全看不出来
   （同步「成功」了，只是少了邮件）。

### 修法

```
1. UID SEARCH UID <cursor+1>:*      ← 只拿 UID 列表（整数，几乎不占带宽）
2. backlog.slice(0, 50)             ← 取**最旧**的一批，不是最新
3. UID FETCH <batch[0]>:<batch[-1]> ← 确定区间，只传这 50 封的正文
4. 游标推进到本批最大 UID            ← 不推到 UIDNEXT-1
```

**积压多批消化**：下一批从本批末尾继续。每批 50 封，
几千封积压会分多轮追平 —— 而**任何一轮失败都不丢件**（游标没动，下次重拉同一批）。

只有当 `SEARCH` 返回空（真的没有新邮件）时，游标才推到 `UIDNEXT - 1`。

### 附带修的两处

- **UI 超时**：`accounts:sync-now` / `accounts:test` 这类天生耗时的消息之前也用
  8 秒超时，正常操作会被误判成失败。现在走 3 分钟，并且报错文案只说事实
  （「『accounts:sync-now』等待超过 180 秒仍未返回」），不再猜「background 可能正在休眠」——
  那个猜测在本次故障里把排查方向直接带偏了。
- **删掉了危险的 API**：`ImapClient` 里那个「拉 `UID > x` 全部」的方法**被删除**，
  没有保留成 deprecated。留一个「能用但在真实邮箱上必然出错、而且会静默丢件」的方法，
  比没有它更糟。

---

## 8. 「点了同步一直停在同步中」（MV3 的 30 秒回收）

### 症状

点「立即同步增量」后界面一直显示「同步中」，永不结束；中继日志显示这次同步
**确实跑了 32 秒**（`CONNECT` → 32 秒后 `CLOSE`），游标也推进了（37727 → 37729）。

也就是说：**同步成功了，但 UI 永远收不到结果。**

### 根因

MV3 的 Service Worker 在**没有事件** 30 秒后被回收 —— 而一条**正在进行中**的
`webext-bridge` 消息（`sendMessage` 的 promise 还没 settle）**不算事件**。

所以「点同步 → 等它跑完 → 把结果作为返回值送回 UI」这个形态，在同步超过 30 秒时
必然失败：worker 被杀，promise 永远不 settle，`await` 它的界面就停在「同步中」。
用户的邮箱有 3 万多封，一轮正好 32 秒 —— 恰好越过那条线。

### 修法：改成「启动 + 广播」

```
UI  → accounts:sync-now  →  { started: true }   ← 立刻返回，不持有长消息
                             （同步在后台继续跑）
UI  ← sync:done          ←  { ok, results, error? }  ← 跑完广播
```

关键点：

- **消息往返不再承载耗时操作**，worker 的 30 秒回收机制就伤不到它；
- 同步过程本身会 `await` 网络与 IDB，这些**会**让 worker 保活；
- **失败也广播** —— 否则 UI 会一直停在「同步中」，正是修之前的行为；
- UI 侧用 `onSyncDone()` 订阅，`busy` 状态由广播收尾。

### 为什么这一条花了这么久才定位

因为**单测测不出来**：单测里的 provider 是假的，同步是毫秒级的，永远不会
跨过 30 秒那条线。为此补了一层**端到端测试**
（`src/adapters/mail/__tests__/imap-e2e.spec.ts`）：

```
真 IMAP provider → 真中继进程 → 真（虚构）IMAP 服务器 → 真 IDB
```

用的是扩展**同一份**代码，只把「邮件服务器」换成
`src/adapters/mail/testing/mock-imap-server.ts`。它顺带验了字面量按**字节**解析、
`SEARCH` 响应切分、游标推进等只能在真协议往返里暴露的东西。

> ⚠️ 这层测试必须跑在 **node** 环境（文件顶部 `// @vitest-environment node`）。
> 默认的 jsdom 会往全局塞它自己的 `Event`，而 Node 的 `net.Socket` 断言事件类型 ——
> 结果是「服务器收到命令但一个字都不回」，看起来像 IMAP 协议问题。
> 另外 `environmentMatchGlobs` 在 Vitest 5 里**已被移除**，配了它是静默失效的。

---

## 9. `Cannot read properties of undefined (reading 'fingerprint')`

### 症状

background 控制台报：

```
Error in event handler: TypeError: Cannot read properties of undefined (reading 'fingerprint')
```

界面看起来只是「某个页面没刷新」，但**这是 background 在抛异常**。

### 根因：`sidepanel` 不是合法的 context 名

`webext-bridge` 的 `formatEndpoint`（`chunk-REMFLVJH.js:31`）只对三个 context
原样返回端点名：

```js
if (["background", "popup", "options"].includes(context)) return context
return `${context}@${tabId}${frameId ? `.${frameId}` : ""}`
```

所以按 context 名去发 `{ context: 'sidepanel' }` 会被解析成 **`sidepanel@null`** ——
而 Sidepanel 页面注册自己时用的是 **`sidepanel@<tabId>`**，两边对不上。
紧接着 `connMap.get()` 返回 `undefined`，而 `deliver()` 里**无条件**读
`dest().fingerprint`（`background.js:115`）→ 抛异常。

**这个异常是异步抛的**（`deliver` 是回调），所以它不会被 `sendMessage` 的
try/catch 接住 —— 调用方拿到的 promise 既不 resolve 也不 reject。

### 修法

1. **只往 `webext-bridge` 认得的 context 发**（`popup` / `options` / `devtools`）。
   Sidepanel 以 `popup` 身份注册（见 `logic/bridge.ts` 文件头）。
2. **自己维护「活着的扩展页面」表**：在 `runtime.onConnect` 里解析连接名，
   记下端点名，断开时移除。**只往表里的 key 发。**
   —— 因为 `connMap` 只在对方握手完成后才有条目，「先发了再说，失败会 reject」
   在这里是错的：它抛的是同步 TypeError。

`logic/__tests__/messaging.spec.ts` 把这两条钉住了（9 条断言）。

### 以及：`sidepanel` 这个名字确实诱人

`RuntimeContext` 的完整取值是
`'devtools' | 'background' | 'popup' | 'options' | 'content-script' | 'window'`
—— 没有 `sidepanel`。Chrome 有 side panel 这个 UI，但 `webext-bridge` 不区分它。

---

## 10. 腾讯邮箱的短时分连接限流

排查期间出现过一种现象：中继日志里连续多条

```
CONNECT imap.qq.com:993 (tls)
CLOSE  imap.qq.com:993（tcp closed）    ← 600ms 后
```

**这不是本项目的 bug。** 600ms 是 TLS 握手完成、连接刚建立的时间点，
服务器在收到第一条命令前就关了连接 —— 典型的**短时间大量新建连接被限流**。

触发条件是「连续点『立即同步增量』」：每次点击都新建一条 IMAP 连接。
腾讯邮箱对同一账号的并发 / 频率连接数有限制。

**应对**：等一两分钟再点；或者等中继推送触发的那一轮。
若要确认，打开字节追踪就能看到连接在 TLS 之后**一条命令都没发出去**
（对比正常情况会看到 `A0001 LOGIN …`）：

```bash
pnpm relay:trace          # 等价于 RELAY_TRACE=1 pnpm relay
```

> ⚠️ **Windows / PowerShell 不能写 `RELAY_TRACE=1 pnpm relay`** ——
> `VAR=value cmd` 是 bash 语法，PowerShell 会把整串当成一个命令名去找，
> 报「术语 'RELAY_TRACE=1' 不会被识别为 cmdlet…」。
> 用 `pnpm relay:trace`，或 `$env:RELAY_TRACE=1; pnpm relay`。
> 项目里所有带环境变量的脚本都走 `cross-env`，所以三个平台语法一致。

> ⚠️ `RELAY_TRACE=1` 会把 `LOGIN` 命令打到终端 —— 那里面**含你的授权码**。
> 只在排查时打开，看完关掉并清一下终端回滚缓冲。

---

## 11. 「点同步一直停在同步中」，但中继日志显示同步是成功的

### 症状

字节追踪里明明一切正常：

```
→ A0001 LOGIN "…"          ← A0001 OK Success login ok
→ A0002 SELECT INBOX       ← * 35497 EXISTS … [UIDNEXT 37732]
→ A0003 UID SEARCH UID 37732:*
                           ← * SEARCH          （没有新邮件，完全正常）
→ A0004 LOGOUT             ← A0004 OK LOGOUT Completed
```

但界面上按钮**一直在转圈**，而且**没有任何错误**。偶尔又能成功。

### 根因：`sync:done` 只走广播，而广播不保证送达

`accounts:sync-now` 为了绕开 MV3 的 30 秒回收（§ 8），改成「立刻返回 + 跑完广播」。
问题在于**广播的送达是有条件的**：background 侧的 `connMap` 要**先有那个端点**，
而条目只在对方握手完成后才写入。三种情况都会让消息**静默消失**：

1. 页面在 background 重载**之前**就连上了（旧连接不在新 `connMap` 里）；
2. 同一个 context 有多个连接（`connMap` 每个 context 名只留最后一个）；
3. 端点名对不上（见 § 9 的 `sidepanel@null`）。

消息丢了，`busy` 就永远是 `true` —— 这正是「偶尔能成功」的来源：
连上/没连上是时序问题。

### 修法：结果存一份，UI **轮询兜底**

```
UI  → accounts:sync-now     → { started: true, startedAt }
                               （后台同时把结果记进 lastSync）
UI  → accounts:sync-status  → lastSync        ← 每 1.5 秒问一次，直到拿到
UI  ← sync:done             ← 广播（快，但可能丢）  ← 谁先到算谁的
```

- **`finishedAt` 必须晚于本次点击的 `startedAt`** —— 否则拿到的是**上一轮**的结果，
  直接用它收尾会让界面显示过期的数字；
- 上限 6 分钟，超时给出明确提示（而不是无限轮询）；
- 组件卸载时停止轮询。

这不会重新引入 § 8 的问题：`accounts:sync-now` 已经立刻返回了，
`accounts:sync-status` 是同步**跑完之后**才发的短请求，不承载耗时操作。

### 测试

`src/options/pages/__tests__/general-sync.spec.ts`（6 条）。
「广播丢失」在测试里就是**注册的监听器不调用**。

> ⚠️ 这组测试**验证过它能抓到 bug**：把 `startSyncWatchdog(...)` 那一行注释掉
> （即修复前的行为），6 条里有 5 条失败；恢复后 6 条全过。
> 一个修复前后都通过的测试证明不了任何事情 —— 写完修复测试后请务必这样验一次。
