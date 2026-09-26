# 主题配色基础（THEME-01）

更新：2026-09-22。对应[浅色主题计划](../planning/light-theme-todo.md)的第一项，该项交付时仍只启用深色主题。协作任务：[Issue #29](https://github.com/wolfhawkld/living-memory/issues/29)。

后续状态（2026-09-26）：THEME-02～05 已接入[主题偏好](theme-preferences.md)、[工作区与阅读层](theme-workspace.md)、[图谱](theme-graph.md)和 [Mermaid/媒体](theme-media.md)。THEME-06 总体验收仍待进行。下文配色基础与验证记录保留 THEME-01 阶段信息，迁移表同步标记后续进度。

## 配色来源与接入方式

[theme-palette.ts](../../src/web/theme-palette.ts) 是公共配色来源，模块不依赖 DOM、React 或 Three.js：

- `ui`：页面、面板、文字、边框、强调色及阴影；THEME-01 迁移原有根变量，THEME-03 已补充局部组件颜色。
- `memory`：六种状态的节点、列表、图例、曲线标记和模拟状态色。
- `memoryBadge`：详情徽标的六种状态色。未知 `#7f8da9`、待确认 `#a7adbd` 是既有的较淡变体，与节点的 `#4175af`、`#a4a9b6` 区分保存；其余状态复用 `memory`，本轮不改变外观。
- `graph`：场景背景、普通/弱化/选中关系、选中环、节点发光强度与透明度、普通/强调标签、Bloom 和灯光。

THEME-01 让 `App`、`DemoPanel` 和图谱读取同一配色对象，`GraphView` 不再导出公共状态色；THEME-03 将页面状态色进一步接入 CSS 变量。图谱标签沿用原有尺寸、避让和缓存逻辑；光晕纹理保留白色透明度遮罩，由材质赋予状态色。

`themeCssVariables()` 将相同定义映射为 CSS 变量；`themeRootCss()` 序列化成根样式。[Vite 配置](../../vite.config.ts)在开发页面与生产 HTML 的 head 中加入 `lm-default-theme` 样式，确保 React 加载前已有基础背景与文字色，无需复制一份 CSS 色值或增加生成文件。配色来源只允许仓库内的可信定义。

旧的 `--mint / --amber / --coral / --unknown` 暂时作为兼容别名；新状态变量使用 `--memory-状态名` 和 `--memory-badge-状态名`。THEME-04 加入完整 `LIGHT_THEME`，图谱按有效主题读取配色；页面 CSS 使用同一状态定义。

## 固定色值盘点与后续迁移

| 范围 | THEME-01 结果 / 后续任务 |
| --- | --- |
| `styles.css` 根变量、状态徽标 | 已迁移；THEME-03 接入页面组件，THEME-04 取消图谱覆盖层的强制深色边界并适配悬停提示 |
| `GraphView.tsx` 与 `graph-labels.ts` | THEME-04 已接入动态换色、标签缓存失效、局部光晕与浅色后处理配置 |
| `App.tsx`、`DemoPanel.tsx` | 已解除从 GraphView 导入状态颜色的依赖；THEME-03 已改用语义状态 CSS 变量 |
| `account.css`、`domain-controls.css`、`concept-search.css`、`pending-writes.css` | THEME-03 已接入登录、账户、领域、搜索及待同步界面的局部颜色 |
| `concept-history.css`、`scenario-practice.css`、`learning-evidence.css` | THEME-03 已接入历史/练习/信心/长期保持容器、徽标及交互状态 |
| `concept-reader.css`、`markdown-content.css`、`MarkdownContent.tsx` | THEME-03 已接入大窗、Markdown、代码、表格、公式及 KaTeX 错误色 |
| `mermaid-renderer.ts`、`mermaid-diagram.css`、`markdown-image.css` | THEME-05 已接入 Mermaid 队列内配置、图表重渲染和媒体容器；普通图片不反色 |
| `index.html` 的浏览器主题色、`color-scheme: dark` | THEME-02 已按实际主题、首屏偏好和根主题标记统一更新 |

THEME-01 未改动图谱生命周期、相机、布局、旋转计时、账号作用域或学习数据。后续 THEME-02～05 已接入偏好、页面、图谱与媒体展示；实际浏览器效果仍待用户验收。

## 验证记录

THEME-01 阶段新增 2 项 Node 测试覆盖现有样式变量依赖、六种原始状态色、徽标变体，以及替代配色的 CSS 序列化与默认对象不被修改。该阶段完整 Node 测试 **241/241 通过**，`npm run build` 通过；保留既有图谱大包的体积提示。浏览器视觉验收由用户进行，本轮未执行浏览器测试。

已通过只读 HTTP 检查确认本地服务返回新的生产 HTML，配色样式与公共定义一致且只注入一次，文档字符集声明仍位于开头。
