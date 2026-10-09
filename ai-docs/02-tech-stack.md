# 02 · 技术栈

> 列清"已经有的"和"将要加的"，避免重复引入或漏装。

---

## 1. 模板已内置

源自 [`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext)。

### 框架 / 语言

- **Vue 3**（Composition API + `<script setup>`）
- **Vite 8.x** 多入口构建（background / popup / options / sidepanel / contentScript）
- **TypeScript**（5.9，`strict`）
- **UnoCSS**（原子化 CSS + `presetIcons`，图标用 `i-pixelarticons-*`）
- **VueUse**（`@vueuse/core`；`useWebExtensionStorage` 已不再使用）

### 扩展能力

- **webextension-polyfill**：浏览器 API 跨浏览器统一
- **webext-bridge**：跨上下文（bg/popup/options/content/sidepanel）消息

### 工具链

- **pnpm** workspace
- **ESLint**（`@antfu/eslint-config`）
- **Vitest**（单元测试，模板里给了 demo）
- **web-ext**（Firefox 本地运行）

### 参考项目

- **offer-hunter**（[`D:\Projects\offer-hunter`](https://github.com/)）：同模板出品的浏览器扩展。架构思路（IndexedDB、adapter、平台注册表、`chrome.scripting.executeScript`、`webext-bridge`、SecretInput 组件）**完全参考**——见 `offer-hunter/src/platform/idb/`、`offer-hunter/src/adapters/ai/`、`offer-hunter/src/manifest.ts`。

---

## 2. 存储

**全部走 IndexedDB**，不用 `chrome.storage.local`。

- 通用封装：`src/platform/idb/database.ts`（参考 `offer-hunter/src/platform/idb/database.ts`）
  - `openDb()` 单例懒开
  - `runTx(stores, mode, fn)` 事务包装（事务里不准 await 非 IDB 的 promise；`withTx` 是它内部的私有实现）
  - `put / putMany / get / del / iterate / count / clearStore` 原语
  - `retryable()` 限重试（AbortError / UnknownError / InvalidStateError）
- Schema：`src/platform/idb/schema.ts`（stores + 索引 + `upgrade()` 一次性迁移）
- 门面：`src/logic/store/{accounts,rules,mails,settings,ready,migrations}.ts`

> 详细 schema 见 [`design/storage.md`](./design/storage.md)；数据模型见 [`design/data-model.md`](./design/data-model.md)。

---

## 3. 待新增依赖

> 按里程碑分批加。每加一个，写明 **为什么 / 在哪用**。

### 3.1 邮箱协议层

**已落地**：

| 包 | 用途 | 为什么是它 |
| --- | --- | --- |
| **自研 `ImapClient`**（`src/adapters/mail/providers/imap/client.ts`） | IMAP4 客户端 | 现成库都绑死 Node 的 `net`（浏览器里跑不了，见 §4）。自研只需 `LOGIN` / `SELECT` / `UID SEARCH` / `UID FETCH` / `IDLE` + 字面量解析，代价可控。传输层抽象成 `MailSocket`，于是同一份客户端既能走中继、也能在 Node 里直连 |
| `postal-mime` | 解析 MIME（RFC822） | 零依赖、纯浏览器。产出 `from/subject/bodyText/…` |
| `ws`（仅中继 / 测试） | 中继的 WebSocket 服务端与测试客户端 | 中继是独立 Node 进程，不在浏览器里 |

**已否决**（早期计划里列过）：

| 包 | 否决原因 |
| --- | --- |
| `emailjs-imap-client` | 同样绑 Node `net`；而且它替我们做了太多（我们要的是「能精确控制命令与字面量」） |
| `mailparser` | 基于 Node `stream`，浏览器里要一堆 polyfill。已被 `postal-mime` 取代 |
| `node-imap` | Node 习气最重，polyfill 成本最高 |

> **决策**：`MailProvider` 适配器抽象（参考 offer-hunter 的 `adapters/sites/`）。
> 已实现 `imap`（用户名密码 + 中继）与 `gmail`（REST + OAuth）；`outlook` 待实现。

### 3.2 AI 层

| 包 | 用途 | 选择理由 |
| --- | --- | --- |
| **自研 fetch 客户端** | 调 OpenAI 兼容 / Anthropic Chat | 不绑 SDK、降低体积、支持自定义 baseURL |
| **zod** | 解析与校验 AI 输出 JSON | AI 可能格式错，**必须** zod 校验后才入库 |

> **决策**：多 Provider 适配器（镜像 `offer-hunter/src/adapters/ai/`），详见 [`features/02-ai-summary.md`](./features/02-ai-summary.md)。

### 3.3 工具

| 包 | 用途 |
| --- | --- |
| `nanoid` | 生成 mail id / rule id（比 UUID 短） |
| `zod` | AI 输出 schema 校验（关键：AI 格式可能错） |
| `esno`（开发期） | 跑 `scripts/*.ts`（中继与运维脚本是 TypeScript） |

> ⚠️ `dayjs` **没有引入**：只有「相对时间」一个函数需要，
> 所以手写在 `MailListItem.vue` 的 `formatRelative` 里 —— 多一个依赖不划算。

---

## 4. 不引入的东西（明确否决）

| 候选 | 否决原因 |
| --- | --- |
| `npm/imapflow` | Node-only；浏览器 import 失败 |
| `chrome.storage.local` | 整体改 IndexedDB（参考 offer-hunter） |
| `crypto.subtle` 做加密（MVP） | 无"既方便又安全"的密钥来源，明文 + 隐私声明（M3+ 加口令保护） |
| Pinia | 跨上下文状态用 IndexedDB + bridge 更轻；不上 Pinia |
| Tailwind | UnoCSS 已替代 |
| Element Plus / Naive UI | 体量大；MVP 用 UnoCSS + 简单组件足够 |
| 服务端中转 | **不允许**：邮件隐私敏感，本地 + 用户自带 API key 走全部路径 |

---

## 5. 类型与代码风格

- `auto-imports.d.ts` 模板已生成；新增 API（如 `chrome.alarms`）需在 `shim.d.ts` 加类型签名。
- `webext-bridge` 的消息名在 `src/logic/messaging.ts` 中维护，并在 `shim.d.ts` 通过 `ProtocolMap` 扩展，避免拼写错。**那份声明是通道形状的单一真相**。
- ESLint：`single quotes` + `no semi`（沿用模板）。
- 所有 **AI 输出** 必须经 `zod` 校验后才落库。
- **i18n**：所有 UI 文案集中 `src/logic/strings.ts`，不在 `.vue` 里硬编码中文字符串。

---

## 6. 测试策略

| 层 | 工具 |
| --- | --- |
| IDB 原语 | Vitest + `fake-indexeddb` |
| 纯函数（解析、匹配、提示词组装） | Vitest 单测 |
| 规则匹配 / AI 输出 schema | Vitest + fixture |
| 跨上下文消息 | 用 `webext-bridge` 的 mock 测试 channel |
| Manifest 派生 | Vitest + glob（如 offer-hunter 的 `src/__tests__/manifest.spec.ts`） |
| E2E | Playwright（模板已配）+ 真邮箱 fixture（可选） |

> 测试覆盖目标：**核心逻辑（mail/ai/rules/idb）80%**；UI 用 Vitest 跑关键流程。

---

## 7. 构建产物

- `pnpm dev` → 加载 `extension/` 到浏览器
- `pnpm build` → 输出到 `extension/dist/`
- `pnpm pack:zip` / `pack:crx` / `pack:xpi` 上架用

> 构建大小目标：MVP **< 300 KB** JS（不含 `mailparser` 体积）。

---

## 8. 后续读什么

- 路线图：[`03-roadmap.md`](./03-roadmap.md)
- 数据模型：[`design/data-model.md`](./design/data-model.md)
- 存储 schema：[`design/storage.md`](./design/storage.md)