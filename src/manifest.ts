import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import { readFile } from 'node:fs/promises'
import { isDev, isFirefox, port, r } from '../scripts/utils.mts'

/**
 * MV3 manifest 生成器（Chrome + Firefox 双端分支）。
 *
 * 权限表与取舍见 `ai-docs/01-architecture.md § 5`。**刻意不申请的**：
 *
 * | ~~权限~~            | 否决原因 |
 * | ---                 | --- |
 * | `notifications`     | 改用 Badge + 页面顶部 Toast（`design/page-toast.md`） |
 * | `clipboardWrite`    | 复制走 `navigator.clipboard.writeText`（SW / content script 在用户激活态下调用） |
 * | `unlimitedStorage`  | IndexedDB 默认配额远大于旧 storage 的 10MB |
 * | `scripting`         | toast 用常驻 content script 注入；上架审查受阻再切按需注入 |
 */
export async function getManifest() {
  const pkg = JSON.parse(await readFile(r('package.json'), 'utf-8')) as typeof PkgType

  const manifest: Manifest.WebExtensionManifest = {
    manifest_version: 3,
    name: pkg.displayName || pkg.name,
    version: pkg.version,
    description: pkg.description,
    action: {
      default_icon: 'assets/icon-128.png',
      // 工具栏图标 hover 时的提示语：用产品名（pkg.displayName），不是包名
      default_title: pkg.displayName || pkg.name,
      // 点 icon = 打开 Popup（Chrome 默认行为）。**不**开 sidePanel 的
      // openPanelOnActionClick —— 两者互斥，而 Popup 是极简模式的主要界面。
      default_popup: 'dist/popup/index.html',
    },
    options_ui: {
      page: 'dist/options/index.html',
      open_in_tab: true,
    },
    background: isFirefox
      ? {
          // Firefox 的 MV3 用 `scripts`（不是 service_worker），且不能并存
          scripts: ['dist/background/index.mjs'],
          type: 'module',
        }
      : {
          service_worker: 'dist/background/index.mjs',
        },
    /**
     * 四个尺寸各是一份独立文件（`pnpm icons` 生成，见 `scripts/icons.ts`）。
     * 不要图省事全部指向 512 —— 16px 那份是缩放器直接抽的，比浏览器临时把
     * 512 缩到 16 干净得多（工具栏上肉眼可见的差别）。
     */
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: [
      'tabs', // 查激活 tab（toast 投递）
      'activeTab', // 当前 tab 短时访问
      'alarms', // 兜底定时抓取（推送失效时的保险丝，见 design/sync-flow.md § 7）
      'sidePanel', // Chrome 侧边栏
      'identity', // Gmail OAuth（launchWebAuthFlow）
      'storage', // 仅用于一次性迁移的兼容读取（迁移完成后摘除）
    ],
    /**
     * 邮箱 provider 走的都是 HTTPS REST，所以 host_permissions 是必须的：
     *   - Gmail API + OAuth token 端点
     *   - `<all_urls>` 只为让常驻 content script 能注入所有页面渲染 toast
     *     （上架审查时这是审查点，M3 前可考虑收窄，见 `decisions/open-questions.md` Q15）
     */
    host_permissions: [
      'https://gmail.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      '*://*/*',
    ],
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['dist/contentScripts/index.global.js'],
        // 空闲时不挂任何 DOM（toast 容器懒创建），所以不需要 run_at 调优；
        // document_idle 能让它避开页面自身的脚本初始化高峰
        run_at: 'document_idle',
      },
    ],
    /*
     * ⚠ **刻意没有 `web_accessible_resources`**。
     *
     * 模板原本在这里暴露 `dist/contentScripts/style.css`（给注入到页面的 Vue 应用
     * 当样式表用）。mail-peon 的 toast 把自己的 CSS 作为字符串塞进 **closed shadow
     * root**（见 `contentScripts/toast.css.ts` 的说明），不加载任何外部资源 ——
     * 所以那个声明现在指向一个不存在的文件，而 `web_accessible_resources` 每多一项，
     * 扩展被网页探测 / 指纹识别的面就大一分。
     *
     * 将来若要注入图片 / 字体，在这里按需加，并且只 `matches` 真正需要的站点。
     */
    content_security_policy: {
      extension_pages: isDev
        // this is required on dev for Vite script to load
        ? `script-src 'self' http://localhost:${port}; object-src 'self'`
        : 'script-src \'self\'; object-src \'self\'',
    },
  }

  // 侧栏：Chrome 用 side_panel，Firefox 用 sidebar_action（互斥给键，不要并存）
  if (isFirefox) {
    manifest.sidebar_action = {
      default_panel: 'dist/sidepanel/index.html',
    }
    // Firefox 的隐私声明（AMO 要求）：本扩展不收集任何数据
    ;(manifest as unknown as Record<string, unknown>).browser_specific_settings = {
      gecko: {
        id: '{b3f9a2c7-5e41-4d0a-9f7b-6c82d1e45a30}',
        strict_min_version: '109.0',
      },
    }
  }
  else {
    // sidebar_action 在 Chromium 内核上不生效
    ;(manifest as unknown as Record<string, unknown>).side_panel = {
      default_path: 'dist/sidepanel/index.html',
    }
  }

  return manifest
}
