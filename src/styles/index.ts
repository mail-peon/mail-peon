/*
 * 样式入口（Popup / Options / Sidepanel 三个界面共用）。
 *
 * ⚠ 这里**只有一套 reset**，而且是 antd 那一套，这是修出来的结论，不是省事。
 *
 *   项目原本引了 `@unocss/reset/tailwind.css`（模板带来的）。它里面有一条：
 *
 *     button, [type='button'], [type='reset'], [type='submit'] { background-color: transparent }
 *
 *   特异度是 **(0,1,1)**（属性选择器 + 元素）。而 antd v4 的组件样式外面包着
 *   `:where(.css-hash)`（`:where()` 特异度为 0），于是 `.ant-btn-primary` 只有
 *   **(0,1,0)** —— 比那条 reset 更低。结果：**所有主色按钮的背景变成透明**，
 *   白字落在透明底上，看起来像被禁用了一样（真机截图里一眼就能看到）。
 *
 *   两条路：把 antd 的样式再包一层提高特异度，或者**只留一套 reset**。
 *   选了后者 —— 两套 reset 抢同一批元素本来就是这件事的根源，
 *   而 `reset.css`（antd 自带）已经覆盖了 box-sizing、body margin、表单元素继承
 *   这些必需项。它唯一与 Tailwind 不同的是给 `p` 留了 `margin-bottom: 1em`，
 *   那由 `shared.css` 里的 `.mp-hint` / `.mp-error` 显式归零（见那边的说明）。
 *
 * ⚠ 顺序也不能换：`main.css` / `shared.css` 里对 `.ant-*` 的收紧要在 reset 之后，
 *   而 `uno.css`（原子类）永远最后 —— 它要能覆盖前面的东西。
 */
import 'ant-design-vue/es/style/reset.css'
import './main.css'
import './shared.css'
import 'uno.css'
