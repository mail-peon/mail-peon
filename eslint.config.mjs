import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: [
      // 由 unplugin 在构建时生成
      'src/auto-imports.d.ts',
      'src/components.d.ts',
      // 构建产物
      'extension/**',
      // 项目文档：markdown 解析器会把 ** 当指数运算符，pass-through 处理器会把
      // markdown 当 TS 解析导致大量误报。文档校验留给 prettier/markdownlint。
      'ai-docs/**',
    ],
  },
  {
    /*
     * 纯 JS / MJS 里关掉 `unused-imports/no-unused-vars`。
     *
     * 这条规则是**为 TS 设计的**：它要区分「完全没用」与「只在类型位置用了」
     * （`import type { X }` 之后 `X` 只出现在类型注解里，此时不该报）。它靠
     * 「有没有类型信息」来做这个判断，而这个 config 没有开 TS 的项目服务，
     * 于是它的兜底行为退化成「把所有只被赋值一次的变量都当成只用于类型」——
     * `const reallyUnused = 1` 也会被报成
     * 「'reallyUnused' is assigned a value but only used as a type」。
     *
     * ⚠ 实测：`.js` 与 `.mjs` 都会命中，且与 `no-unused-vars` **重复报同一行**。
     *   这是规则在 JS 上的配置问题，不是代码问题 —— 所以修在这里，
     *   而不是在每个 JS 文件顶部写 `eslint-disable`（那会把真问题一起盖掉）。
     *
     * 基础规则 `no-unused-vars`（antfu config 已启用）在 JS 上工作正常，
     * 所以未使用变量的检查**没有丢**，只是换回了那个正确的规则。
     */
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
    },
  },
)
