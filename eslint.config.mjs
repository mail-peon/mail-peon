import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: [
      // 由 unplugin 在构建时生成
      'src/auto-imports.d.ts',
      'src/components.d.ts',
      // 构建产物
      'extension/**',
      // Playwright 的运行产物（e2e 之后会生成，不是源码）
      'test-results/**',
      'playwright-report/**',
      // 项目文档：markdown 解析器会把 ** 当指数运算符，pass-through 处理器会把
      // markdown 当 TS 解析导致大量误报。文档校验留给 prettier/markdownlint。
      'ai-docs/**',
    ],
  },
)
