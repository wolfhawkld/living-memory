# 第三方依赖许可检查记录

更新：2026-10-01。

本文记录 Living Memory 当前依赖和构建产物的许可核对结果。基线是提交 `0abb3f9` 中的 [`package.json`](../../package.json) 与 [`package-lock.json`](../../package-lock.json)，并以当前已安装的 `node_modules` 中对应的 `package.json`、`LICENSE`、`NOTICE`、`OFL` 等文件作为本地证据。许可核对为只读操作，没有读取个人数据或修改应用、构建配置及依赖。

本文是审查记录，不是已经完成的 `THIRD_PARTY_NOTICES`。没有为了填表复制全部传递依赖的许可证正文，也没有把缺少 lockfile 元数据的包无证据地归类。未来发行包应按实际随包的源代码、运行时、bundle 和字体重新生成 notice 清单。

## 分发边界

当前 Git 源码分发跟踪项目源代码、文档、[`package.json`](../../package.json)、[`package-lock.json`](../../package-lock.json) 和项目根 [`LICENSE`](../../LICENSE)。`node_modules/` 与 `dist/` 被 `.gitignore` 忽略，因此源码归档当前不附带已安装依赖或构建产物；lockfile 中的许可证字段只是依赖元数据，不能替代未来二进制或 bundle 分发中的许可证/版权文本。

项目根 MIT 许可只覆盖项目自身在该许可范围内的代码和材料。它不授权个人知识库、用户内容、外部 HTML 或其中的第三方内容；外部网页在项目材料中只是链接，本审查没有复制外部 HTML 正文。

## 直接生产依赖

`package.json` 的 12 个直接生产依赖与 lockfile 版本一致，已安装包的声明许可证均为 MIT。表中的本地路径是当前安装快照中的证据；`node_modules` 不属于源码归档。

| 包 | 锁定版本 | 声明许可证 | 本地许可证证据 |
| --- | ---: | --- | --- |
| `3d-force-graph` | `1.80.0` | MIT | `node_modules/3d-force-graph/LICENSE` |
| `express` | `5.2.1` | MIT | `node_modules/express/LICENSE` |
| `gray-matter` | `4.0.3` | MIT | `node_modules/gray-matter/LICENSE` |
| `katex` | `0.16.22` | MIT | `node_modules/katex/LICENSE` |
| `mermaid` | `12.0.0` | MIT | `node_modules/mermaid/LICENSE` |
| `react` | `19.3.0` | MIT | `node_modules/react/LICENSE` |
| `react-dom` | `19.3.0` | MIT | `node_modules/react-dom/LICENSE` |
| `react-markdown` | `10.1.0` | MIT | `node_modules/react-markdown/license` |
| `rehype-katex` | `7.0.1` | MIT | 包根没有独立许可证文件；`node_modules/rehype-katex/readme.md` 的 License 节声明 MIT 并链接上游许可 |
| `remark-gfm` | `4.0.1` | MIT | `node_modules/remark-gfm/license` |
| `remark-math` | `6.0.0` | MIT | 包根没有独立许可证文件；`node_modules/remark-math/readme.md` 的 License 节声明 MIT 并链接上游许可 |
| `three` | `0.186.0` | MIT | `node_modules/three/LICENSE` |

因此，直接生产依赖中没有 Apache、BSD、OFL、MPL 或 EPL 包。这个结论只针对直接依赖；传递闭包包含其他许可证，见下文。

## KaTeX 代码与字体

[`src/web/App.tsx`](../../src/web/App.tsx) 直接导入 `katex/dist/katex.min.css`。当前根依赖是 `katex@0.16.22`；Mermaid 的依赖解析还安装了 `node_modules/mermaid/node_modules/katex@0.16.47`，其许可证证据为该目录下的 `LICENSE`。本地构建产物中可以观察到两个版本：`dist/assets/MarkdownContent-*.js` 和 CSS 使用 0.16.22，`dist/assets/katex-*.js` 含 Mermaid 带入的 0.16.47。两个版本的本地 `LICENSE` 都是 MIT。

根 KaTeX 包的 `node_modules/katex/dist/fonts/` 有 60 个字体文件，即 20 组字体各包含 TTF、WOFF、WOFF2，涵盖不同字重/字形的 AMS、Caligraphic、Fraktur、Main、Math、SansSerif、Script、Size1、Size2、Size3、Size4 和 Typewriter。当前本地 `dist/` 有 59 个外部字体文件（20 TTF、20 WOFF、19 WOFF2）；`KaTeX_Size3-Regular.woff2` 被内联为 `dist/assets/App-BKm5OHnK.css` 的 data URI，内容与根 KaTeX 源字体相同。除这些字体外，`dist/` 没有静态 SVG、PNG、JPG、GIF、WebP、音频或视频文件；Mermaid 的 SVG 属于运行时生成内容。

KaTeX 官方仓库声明 MIT，并说明使用时需要同时提供 CSS 和字体文件：

- [KaTeX 官方仓库](https://github.com/KaTeX/KaTeX)
- [KaTeX 官方 LICENSE](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)
- [KaTeX 官方字体仓库](https://github.com/KaTeX/katex-fonts)
- [KaTeX 字体仓库 LICENSE](https://github.com/KaTeX/katex-fonts/blob/master/LICENSE)

这些链接是上游来源引用；本文件没有复制外部网页正文。实际发行时仍应保留随所用 KaTeX 包提供的许可和版权信息。

## lockfile 许可证字段统计

以下是 `package-lock.json` 中 470 个 `node_modules/*` package records 的 `license` 字段统计。它统计 lockfile 记录，不等同于当前机器实际安装的可选平台包数量。

| lockfile `license` 字段 | 记录数 |
| --- | ---: |
| MIT | 361 |
| ISC | 44 |
| Apache-2.0 | 33 |
| BSD-3-Clause | 13 |
| MPL-2.0 | 12 |
| BSD-2-Clause | 2 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| EPL-2.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| 缺失 | 1 |

唯一缺失字段是 `khroma@2.1.0`。它的 `node_modules/khroma/package.json` 同样没有 `license` 字段，但本地 `node_modules/khroma/license` 明确包含 MIT 文本；因此自动化报告应保留“lock/package 元数据缺失、本地文件显示 MIT”的区别。

## 生产依赖闭包

从 12 个直接生产依赖沿 `dependencies`、`optionalDependencies` 和 `peerDependencies` 解析，当前 lockfile 生产闭包共有 325 个 records。实际 Vite bundle 可能因 tree-shaking 少于这个闭包；发行时应以实际附带内容为准。

| 许可证类别 | 生产闭包记录数 |
| --- | ---: |
| MIT | 266 |
| ISC | 38 |
| Apache-2.0 | 6 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 2 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| EPL-2.0 | 1 |
| Unlicense | 1 |
| lockfile/license 缺失 | 1 |

需要在未来运行时或 bundle notice 中重点保留的本地许可证文件包括：

- Apache-2.0：`chevrotain@11.1.2` 及 `@chevrotain/cst-dts-gen`、`gast`、`regexp-to-ast`、`types`、`utils`，各自有 `LICENSE.txt`。
- 双许可证：`dompurify@3.4.15` 的 `LICENSE` 与 `LICENSE-MPL`。
- EPL-2.0：`elkjs@0.9.3` 的 `LICENSE.md`。
- BSD-2-Clause：`entities@6.0.1/LICENSE`、`esprima@4.0.1/LICENSE.BSD`。
- BSD-3-Clause：`d3-ease`、`d3-sankey`、`ngraph.events`、`ngraph.forcelayout`、`ngraph.graph`、`ngraph.random`、`qs`、`rw`、`sprintf-js` 各自的 LICENSE 文件。
- ISC：38 个记录，主要是 D3 与通用工具依赖；应由未来 notice 生成步骤按实际 bundle 列出包名、版本和许可证。
- Unlicense：`robust-predicates@3.0.3/LICENSE`。
- `khroma@2.1.0`：见上面的元数据缺失说明；不要只根据 lockfile 自动归类。

部分 Apache/MPL/平台二进制包只存在于开发工具链或可选平台记录中。若发行包包含完整 `node_modules`、构建工具或开发运行时，应重新按实际附带包扩大清单；不能仅凭“直接依赖都是 MIT”省略传递包。

## 未来发行要求

当前仓库没有 `THIRD_PARTY_NOTICES`，本文件也不声称已经完成该文件。未来发行 Vite `dist`、包含运行时依赖的压缩包或其他二进制时，应：

1. 根据最终包内实际存在的 JS、字体和运行时包生成包名/版本/许可证清单。
2. 随包保留上游 `LICENSE`、`NOTICE`、版权声明和必要的许可证文本；Apache-2.0、EPL-2.0、双许可证包和其他非 MIT 包要逐项核对其原始条款及修改/通知要求。
3. 对 KaTeX 的两个实际版本和字体文件单独保留 MIT 许可与版权信息。
4. 把 `khroma` 的缺失元数据作为审查警告，不能把 lockfile 的缺失字段解释成“无许可证”。

当前源码归档只含 lockfile 和项目源码，不包含已安装依赖或 `dist`；未来一旦改变分发内容，应重新审计，而不是把本记录当成完整、永久有效的 notice 清单。

## 上游仓库入口

直接依赖的上游仓库由各自已安装 `package.json` 的 `repository` 字段给出：

- [3d-force-graph](https://github.com/vasturiano/3d-force-graph)、[Express](https://github.com/expressjs/express)、[gray-matter](https://github.com/jonschlinkert/gray-matter)
- [KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid)、[React](https://github.com/facebook/react)、[React DOM](https://github.com/facebook/react)
- [react-markdown](https://github.com/remarkjs/react-markdown)、[remark-math](https://github.com/remarkjs/remark-math)、[remark-gfm](https://github.com/remarkjs/remark-gfm)、[three.js](https://github.com/mrdoob/three.js)

传递依赖的许可证判断以上述本地包文件与 lockfile 为基线；需要进一步核实时，应使用对应原始仓库或 [SPDX License List](https://spdx.org/licenses/) 的许可证标识，不使用转载许可证页面或未经核验的聚合表。
