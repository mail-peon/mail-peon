# 中继部署方案（决策稿）

> **约束**：① 允许有中继 ② 对最终用户无感知 ③ 不做公共中继服务
> **结论**：三条不能同时成立。本文记录已确认的取舍与落地方式。
>
> 相关：[ADR-0005](./adr-0005-imap-needs-relay.md)（为什么 IMAP 必须有中继）

---

## 1. 为什么三条不能同时成立

「无感知」有两种解释，结论相反：

| 解释 | 含义 | 能否满足 |
| --- | --- | --- |
| **A. 零额外安装** | 用户只装浏览器扩展，别的一律不装 | ❌ 与 ③ 冲突 |
| **B. 装一次就再也不用管** | 用户跑一个安装器，之后全自动 | ✅ 可行（已选定） |

**A 做不到的原因是权限模型，不是工程难度：**

1. 扩展**开不了 TCP** —— 没有中继就收不到 IMAP；
2. 扩展**不能下载并执行程序** —— MV3 禁止远程代码，浏览器也不给扩展「启动进程」的能力；
3. 扩展**不能安装 native messaging host** —— 那一步必须由安装器写注册表 / plist，
   `connectNative` 只能连**已经注册好**的 host。

> **推论**：要真正做到零额外安装，只能放弃 IMAP，改用 REST 类 provider
> （Gmail / Outlook / JMAP）—— 那是另一条平行路线，见 §4。

### 已验证的备选（均不可行）

| 备选 | 否决原因 |
| --- | --- |
| Netlify / Vercel Functions 之类 serverless | 请求-响应模型没有长连接；沙箱无裸 TCP；超时上限（Netlify 10s/26s）扛不住 IMAP |
| Cloudflare Workers | 有 `cloudflare:sockets` 与 WebSocket，**理论可行**；但受 CPU 时间与子请求限制，长连接 + 大附件容易撞上，且等于把密码交给 Cloudflare（回到 ③ 的问题） |

---

## 2. 已确认的部署形态

### 2.1 服务语言与安装方式

| 项 | 决定 |
| --- | --- |
| 中继实现语言 | **Rust**（最终形态） |
| 为什么不用 Node | 用户机器上得先有 Node 运行时，对普通用户是劝退项；Rust 出单个静态二进制，双击即用 |
| 安装形态 | **一个安装器**，界面提供「安装服务」/「卸载服务」两个选项 |
| 服务级别 | **用户级自启**（不是系统服务） |

**为什么用用户级而不是系统服务**：中继只监听 `127.0.0.1`，跟用户登录绑定完全够用；
而装成系统服务要管理员权限，会让安装过程多一个 UAC / `sudo` 弹窗 ——
那正是「无感知」要避免的东西。代价是「登录后才运行」，对本地代理没有影响。

| 平台 | 机制 | 要提权吗 |
| --- | --- | --- |
| Windows | 计划任务（`schtasks /sc onlogon`）或 `HKCU\...\Run` | 不需要 |
| macOS | LaunchAgent（`~/Library/LaunchAgents/*.plist`）；macOS 13+ 可用 `SMAppService` | 不需要 |
| Linux | `systemd --user` unit 或 `~/.config/autostart/*.desktop` | 不需要 |

> 若将来确实需要「开机即起（无需登录）」，才升级到系统服务
> （Windows SCM / LaunchDaemon / systemd system unit），那时必须提权。

### 2.2 Rust 技术选型

| 用途 | crate |
| --- | --- |
| async 运行时 | `tokio` |
| WebSocket 服务端 | `tokio-tungstenite` |
| TCP | `tokio::net::TcpStream` |
| TLS（连 993 必须） | `tokio-rustls` / `rustls` + `webpki-roots` |
| 服务注册（Windows） | `windows-service` |
| 服务注册（跨平台） | `service-manager` |
| 安装器 GUI | `native-dialog`（最轻，三平台原生对话框） |

**安装器形态**：启动后弹一个只剩两个按钮的窗口。
- 「安装服务」→ 提权（如需要）→ 注册自启 → 释放二进制 → 启动
- 「卸载服务」→ 停服务 → 反注册 → 删文件

### 2.3 扩展 ↔ 中继 的约定

| 项 | 决定 |
| --- | --- |
| 中继地址 | 固定 `ws://127.0.0.1:<port>`，**配置字段对用户隐藏** |
| 端口 | 中继监听 `127.0.0.1:0` 由系统分配，把实际端口写进发现文件（见下）；扩展读它，读不到则回退到固定默认端口 |
| 发现文件 | Windows `%LOCALAPPDATA%\mail-peon\port`；macOS `~/Library/Application Support/mail-peon/port`；Linux `~/.local/share/mail-peon/port` |
| 版本协商 | 中继在 WebSocket 握手后上报版本；扩展发现不兼容时提示更新（避免「扩展更新了但 exe 没更新」） |
| 扩展连不上时 | 文案必须是「**请先运行 mail-peon 助手**」，**不能**是「网络错误」 |

---

## 3. 落地时必须处理的坑

| 坑 | 处理 |
| --- | --- |
| **代码签名（最贵的一步）** | Windows：无签名 → SmartScreen 拦截「Windows 已保护你的电脑」（OV/EV 证书，EV 可立刻免警告）。macOS：**必须签名 + notarize**，否则 Gatekeeper 直接拒绝运行（Apple Developer $99/年）。Linux：不需要 |
| **端口冲突** | 见 §2.3，靠 `:0` + 发现文件 |
| **多账号并发** | 每条 WebSocket 连接开独立 TCP，**不能复用**（IMAP 是有状态协议） |
| **三平台打包** | Windows `.exe`(Inno/NSIS 或自研)；macOS `.pkg`/`.dmg`；Linux `.deb`/`.rpm`/AppImage。三套都要维护 |
| **后台无界面 → 排查难** | 中继写日志到固定路径；扩展侧给出可操作文案 |

---

## 4. 与 REST provider 路线的关系（并行，不互斥）

「零额外安装」这条路线只能靠 REST 类 provider 实现：

| Provider | 覆盖 | 状态 |
| --- | --- | --- |
| Gmail API | Gmail / Google Workspace | ✅ 已实现 |
| Microsoft Graph | Outlook / Hotmail / M365 | ⬜ 待实现（同模式） |
| JMAP | Fastmail 等少数 | ⬜ 待实现（同模式） |

**目标形态**：两条路并存，用户按自己的邮箱选。

```
装好扩展
  ├─ Gmail / Outlook ──▶ 点一次 OAuth ──▶ 完成        零额外安装
  └─ 其它邮箱（IMAP）──▶ 提示「需安装 mail-peon 助手」
                            └─▶ 运行一个安装器 ──▶ 之后全自动
```

两条路在代码里**已经共用** `MailProvider` 抽象与同一个 `parser.ts`，
互不影响：加 provider 不动中继，加中继不动 provider。

---

## 5. 落地顺序（已确认）

**先在本地把 Node 中继 + 真邮箱这条链路跑通，再谈 Rust 与打包。**

理由：这一步验证的是**协议本身** —— IMAP 客户端、字面量解析、游标逻辑、TLS 链路 ——
而这些与「用什么语言写中继、怎么打包、怎么签名」**完全无关**。
在没验证的协议上直接写 Rust，等于叠两层不确定性。

| # | 步骤 | 状态 |
| --- | --- | --- |
| 1 | 修 Node 中继的 `tls`（原用裸 `connect()` 连 993，IMAP 根本连不上） | ✅ 已完成 |
| 2 | 修背压 / `ALLOWED_HOSTS` 通配 / 关闭帧崩溃 | ✅ 已完成 |
| 3 | **用户用真邮箱（QQ 邮箱）验证协议正确** → [`imap-testing.md`](./imap-testing.md) | ⬜ **当前阶段** |
| 4 | 照抄成 Rust（此时有参照实现与测试用例，是机械工作） | ⬜ |
| 5 | 安装器 + 服务注册 + 三平台打包 | ⬜ |
| 6 | 代码签名 / notarize | ⬜ |

> 第 4 步之前 Node 版**不要删**：它是协议正确性的参照实现，
> 且 `scripts/imap-relay.test.mjs` 的端到端用例要继续跑。

### 第 1、2 步实际改了什么（供第 4 步 Rust 重写时对照）

| 改动 | 原因 |
| --- | --- |
| `net.connect()` → `tls.connect({ …, servername, rejectUnauthorized })` | 993 是 implicit TLS，裸 TCP 握手必失败。`servername` 是 SNI，不能省 |
| 新增 `TLS_REJECT_UNAUTHORIZED`（**默认开**） | 只给自签证书的测试环境留逃生口；默认关掉的话中间人攻击不可检出 |
| `tls=0` + 993 直接拒绝 | 否则会用明文去连一个只接受 TLS 的端口，现象是「连接被关闭」且看不出原因 |
| TCP → WS 方向加背压（在途字节计数 + `socket.pause/resume`） | 没有它，大附件会让内存无上限堆积 |
| WS → TCP 方向加背压（`write()` 返回 false → `ws.pause()`，`drain` → `ws.resume()`） | 同上，反方向 |
| `ALLOWED_HOSTS` 支持 `*` 通配 | 之前只支持精确匹配 |
| **关闭帧原因按字节截断到 120 + `try/catch`** | ⚠️ **真崩溃**：WebSocket 关闭原因上限 123 字节，超了 `ws.close()` 直接 `throw`，把**整个中继进程打崩**（一个非法请求即可 DoS）。扩展侧表现为「所有账号突然都收不到邮件」 |
| 加 `uncaughtException` / `unhandledRejection` 兜底 | 中继是后台常驻进程，崩了用户看不到任何提示。宁可废掉一条连接，也不要整个进程退出 |

回归测试（`pnpm relay:test`）现在覆盖 9 条断言，其中这三条是本次新增的：
「TLS 握手真的发生」「默认拒绝自签证书」「策略拒绝后进程仍存活」。

### 中继脚本也被类型检查覆盖了

`scripts/imap-relay.mjs` 之前不在任何 tsconfig 里，ESLint 的 TS 解析器拿不到类型
信息，`unused-imports/no-unused-vars` 于是把每个 `const` 都误报成「只用作类型」——
当时的处理是在文件顶上写 `eslint-disable`，**那是盖问题而不是解决问题**。

现在：

- 新增 `tsconfig.scripts.json`（`allowJs` + `checkJs` + `types: ["node"]`）
- `pnpm typecheck` = `tsc --noEmit && tsc -p tsconfig.scripts.json` —— **脚本和产品代码同一道门禁**
- 加了 `@types/ws`，并给关键位置补了 JSDoc 类型
- 删掉了全部 `eslint-disable`

补类型的过程中**真的抓出两个 bug**（都是运行期才会炸的）：

| bug | 后果 |
| --- | --- |
| `tls.createServer({ key, cert })` 的调用签名不匹配 | 参数被当成「路径字符串」重载，测试里的 TLS 回声服务器起不来 |
| `Buffer.from(wsData)` 对 `RawData` 的重载不兼容 | ts 直接拒绝；运行期遇到 `ArrayBuffer` 分片形态时会构造出错误内容 |

顺带修了 **ESLint 配置本身的一个缺陷**：`unused-imports/no-unused-vars` 在
**所有** `.js` / `.mjs` 上都会误报（实测 `const reallyUnused = 1` 也被报成
「only used as a type」），因为它需要 TS 的项目服务来判断「是否只出现在类型位置」，
而这个 config 没开。已在 `eslint.config.mjs` 里对 JS 文件关掉该规则 ——
基础规则 `no-unused-vars` 仍在工作，所以**未使用变量的检查没有丢**。

### tsconfig 的 TS 6/7 兼容修正

编辑器（自带更新的 TS）报了两条，工作区 TS 5.9.3 不报 —— 但两条都是**真问题**，
TS 6 起会变成硬错误：

| 报错 | 处理 |
| --- | --- |
| `baseUrl` 已弃用，将于 TS 7.0 停止工作 | **删掉**。`paths` 的取值本来就相对 tsconfig 所在目录解析（TS 4.4+），`baseUrl: "."` 从头到尾是多余的 |
| 仅当设置了 `noEmit` 等之一时才能用 `allowImportingTsExtensions` | **保留该选项并补上 `noEmit`**。它**不是**模板残留：代码里有 6 处 `.mts` 后缀 import（`from '../scripts/utils.mts'` 等） |

> ⚠️ 第二项中途差点修错：最初只搜了 `from '…​.ts'`（零命中），据此判断该选项无用并删掉 ——
> 结果 tsc 立刻报出 6 处 **`.mts`** import 的 TS5097。搜索模式漏了扩展名变体。
> 教训是「删配置前先用编译器的报错确认，而不是用自己的 grep 确认」。

删掉 `baseUrl` 后用**反证**验证了 `~/*` 别名仍然生效：临时加一个
`import type { X } from '~/logic/this-file-does-not-exist'`，tsc 如期报 TS2307。

---

## 6. 待决

1. 主推哪条路？（建议：Gmail/Outlook 做主推，IMAP 作为「高级选项」）
2. 现在就做 Outlook provider 吗？（β 路线上性价比最高的一步）
