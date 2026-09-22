# 主题配色基础（THEME-01）

更新：2026-09-22。对应[浅色主题计划](../planning/light-theme-todo.md)的第一项，该项交付时仍只启用深色主题。协作任务：[Issue #29](https://github.com/wolfhawkld/living-memory/issues/29)。

后续状态：THEME-02 已加入[主题入口与本机偏好](theme-preferences.md)，并让登录壳和控件先支持浅色。下文保留 THEME-01 交付时的范围与验证记录。

## 配色来源与接入方式

[theme-palette.ts](../../src/web/theme-palette.ts) 是公共配色来源，模块不依赖 DOM、React 或 Three.js：

- `ui`：页面、面板、文字、边框、强调色及阴影；先迁移原有根变量，局部组件颜色在 THEME-03 接入。
- `memory`：六种状态的节点、列表、图例、曲线标记和模拟状态色。
- `memoryBadge`：详情徽标的六种状态色。未知 `#7f8da9`、待确认 `#a7adbd` 是既有的较淡变体，与节点的 `#4175af`、`#a4a9b6` 区分保存；其余状态复用 `memory`，本轮不改变外观。
- `graph`：场景背景、普通/弱化/选中关系、选中环、节点发光强度与透明度、普通/强调标签、Bloom 和灯光。

`App`、`DemoPanel` 和图谱直接读取同一配色对象，`GraphView` 不再导出公共状态色。图谱标签沿用原有尺寸、避让和缓存逻辑；光晕纹理保留白色透明度遮罩，由材质赋予状态色。

`themeCssVariables()` 将相同定义映射为 CSS 变量；`themeRootCss()` 序列化成根样式。[Vite 配置](../../vite.config.ts)在开发页面与生产 HTML 的 head 中加入 `lm-default-theme` 样式，确保 React 加载前已有基础背景与文字色，无需复制一份 CSS 色值或增加生成文件。配色来源只允许仓库内的可信定义。

旧的 `--mint / --amber / --coral / --unknown` 暂时作为兼容别名；新状态变量使用 `--memory-状态名` 和 `--memory-badge-状态名`。图谱仍直接使用 `DARK_THEME`，目前没有切换控件、浅色配色或账号主题偏好。

## 固定色值盘点与后续迁移

| 范围 | THEME-01 结果 / 后续任务 |
| --- | --- |
| `styles.css` 根变量、状态徽标 | 已迁移；组件背景、交互状态、提示、曲线轴/网格/线条、页面纹理在 THEME-03/04 处理 |
| `GraphView.tsx` 与 `graph-labels.ts` | 已集中语义配色及光效参数；动态换色、标签缓存失效与浅色光效在 THEME-04 处理 |
| `App.tsx`、`DemoPanel.tsx` | 已解除从 GraphView 导入状态颜色的依赖，仍使用原值 |
| `account.css`、`domain-controls.css`、`concept-search.css`、`pending-writes.css` | 登录、账户、领域、搜索及待同步界面的局部颜色在 THEME-03 处理 |
| `concept-history.css`、`scenario-practice.css`、`learning-evidence.css` | 长期保持徽标已接入；其余历史/练习/信心/长期保持容器及交互状态在 THEME-03 处理 |
| `concept-reader.css`、`markdown-content.css`、`MarkdownContent.tsx` | 大窗、Markdown、代码、表格、公式及 KaTeX 错误色在 THEME-03 处理 |
| `mermaid-renderer.ts`、`mermaid-diagram.css`、`markdown-image.css` | Mermaid 配置、图表重渲染和媒体容器在 THEME-05 处理；普通图片不反色 |
| `index.html` 的浏览器主题色、`color-scheme: dark` | 随 THEME-02 的实际主题、首屏偏好和根主题标记统一更新 |

这一步未改动图谱生命周期、相机、布局、旋转计时、账号作用域或学习数据。下一项 THEME-02 接入主题状态与偏好；其后各渲染层逐项完成适配，不能仅修改 CSS 根变量便宣称整套浅色主题可用。

## 验证记录

新增 2 项 Node 测试覆盖现有样式变量依赖、六种原始状态色、徽标变体，以及替代配色的 CSS 序列化与默认对象不被修改。完整 Node 测试 **241/241 通过**，`npm run build` 通过；保留既有图谱大包的体积提示。浏览器视觉验收由用户进行，本轮未执行浏览器测试。

已通过只读 HTTP 检查确认本地服务返回新的生产 HTML，配色样式与公共定义一致且只注入一次，文档字符集声明仍位于开头。
