/// <reference types="vitest" />

import type { UserConfig } from 'vite'
import { dirname, relative } from 'node:path'
import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import packageJson from './package.json' with { type: 'json' }
import { isDev, port, r } from './scripts/utils.mts'

export const sharedConfig: UserConfig = {
  root: r('src'),
  resolve: {
    alias: {
      '~/': `${r('src')}/`,
    },
  },
  define: {
    __DEV__: isDev,
    __NAME__: JSON.stringify(packageJson.name),
  },
  plugins: [
    Vue(),

    AutoImport({
      imports: [
        'vue',
        {
          'webextension-polyfill': [
            ['=', 'browser'],
          ],
        },
      ],
      dts: r('src/auto-imports.d.ts'),
    }),

    // https://github.com/antfu/unplugin-vue-components
    Components({
      dirs: [r('src/components')],
      // generate `components.d.ts` for ts support with Volar
      dts: r('src/components.d.ts'),
      resolvers: [
        // auto import icons
        IconsResolver({
          prefix: '',
        }),
      ],
    }),

    // https://github.com/antfu/unplugin-icons
    Icons(),

    // https://github.com/unocss/unocss
    UnoCSS(),

    // rewrite assets to use relative path
    {
      name: 'assets-rewrite',
      enforce: 'post',
      apply: 'build',
      transformIndexHtml(html, { path }) {
        return html.replace(/"\/assets\//g, `"${relative(dirname(path), '/assets')}/`)
      },
    },
  ],
  optimizeDeps: {
    include: [
      'vue',
      '@vueuse/core',
      'webextension-polyfill',
    ],
    exclude: [
      'vue-demi',
    ],
  },
}

export default defineConfig(({ command }) => ({
  ...sharedConfig,
  base: command === 'serve' ? `http://localhost:${port}/` : '/dist/',
  server: {
    port,
    hmr: {
      host: 'localhost',
    },
    origin: `http://localhost:${port}`,
  },
  build: {
    watch: isDev
      ? {}
      : undefined,
    outDir: r('extension/dist'),
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    /*
     * 原先这里放了 terserOptions.mangle=false（原意是满足 Chrome 应用商店的代码可读性要求），
     * 但 build.minify 默认是 esbuild，terserOptions 根本不生效，且 terser 也不是本项目依赖。
     * Vite 8 收紧了它的类型，这段死配置会直接让 typecheck 失败，故移除。
     */
    rollupOptions: {
      input: {
        options: r('src/options/index.html'),
        popup: r('src/popup/index.html'),
        sidepanel: r('src/sidepanel/index.html'),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // 单测的全局准备：装 fake-indexeddb、桩 chrome.storage、每个用例前清库。
    // 见 `src/tests/setup.ts` 的说明（import 顺序是这里的关键）。
    setupFiles: [r('src/tests/setup.ts')],
    /*
     * ⚠ 路径是 '**\/*.spec.ts' 而不是 'src/**\/*.spec.ts'：Vite 的 `root` 已经是
     *   `src`（见本文件顶部），所以 `src/**` 会被解析成 `src/src/**` —— 结果是一个
     *   测试都找不到，而报错是「No test files found」这种看起来像配置没错的提示。
     */
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
}))
