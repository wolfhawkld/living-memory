# 首批可认领的协作任务（OSS-07）

更新日期：2026-10-01，针对当前 `develop`。以下保留首批协作任务的范围，已完成与待实施状态见任务索引。请先阅读[新人运行指南](../development/first-run.md)、[开发导览](../development/codebase-guide.md)和[贡献约定](../../CONTRIBUTING.md)，在对应 Issue 留下认领范围，避免重复工作；外部贡献的 PR 目标为 `develop`。

本批优先选择文档、合成示例、独立 UI 与边界测试，不要求个人知识库。已有历史 Issue 包含已实现但仍待专项验收的功能；合并过代码不等于人工验收完成，本批不自动关闭那些 Issue。

## 任务索引

| ID | 任务 | 标签 | GitHub / 状态 |
| --- | --- | --- | --- |
| CONTRIB-01 | README 示意素材的 npm 生成入口 | `good first issue`、`documentation` | [#39](https://github.com/wolfhawkld/living-memory/issues/39)，已在 `develop` 完成 |
| CONTRIB-02 | 可直接打开的合成图片与 Mermaid 笔记 | `good first issue`、`documentation` | [#40](https://github.com/wolfhawkld/living-memory/issues/40)，已在 `develop` 完成，专项视觉待用户验收 |
| CONTRIB-03 | 空图谱区域的说明与行动入口 | `good first issue`、`enhancement`、`accessibility` | [#41](https://github.com/wolfhawkld/living-memory/issues/41)，已在 `develop` 完成，视觉待用户验收 |
| CONTRIB-04 | HTTP 错误与 preflight 边界回归 | `help wanted` | [#42](https://github.com/wolfhawkld/living-memory/issues/42)，已在 `develop` 完成 |
| CONTRIB-05 | 原生 Windows 的首次运行记录 | `help wanted`、`documentation` | [#43](https://github.com/wolfhawkld/living-memory/issues/43)，待认领；macOS 暂缓 |

标签表示适合参与的范围，不承诺固定工时。一个任务只做下面写出的交付；发现其他缺陷先记录，不把任务扩大为架构或依赖改造。发布后，以 GitHub Issue 的认领与完成状态为准。

<a id="contrib-01"></a>

## CONTRIB-01：README 示意素材的 npm 生成入口

**已完成（2026-10-01）：** [package.json](../../package.json)已增加 `generate:readme-demo`，并更新[素材说明](../assets/README.md)及[开发导览](../development/codebase-guide.md)。以下保留原任务范围与验收条件。

**原问题：** [生成器](../../scripts/generate-readme-demo.ts)已存在，但缺少容易发现的 npm script，素材说明使用直接 Node 命令。

**范围：** 增加 `generate:readme-demo` 脚本，沿用现有生成器；更新素材说明并在开发导览添加入口。只改包脚本及相关文档，不改生成算法、依赖、时间数值或记忆模型。

**验收：**

- 仓库根目录运行 `npm run generate:readme-demo` 能生成既有 SVG 和 JSON。
- 与当前跟踪的素材逐字节相同，连续生成结果一致；不把真实学习日期或私人路径引入输出。
- 不新增依赖，不无关改动 lockfile；素材仍明确是固定布局与虚构日期的示意，不兼容学习导入格式。

**验证：** 执行新命令两次，比较输出和 `git diff`，检查文档链接及 `git diff --check`。脚本实现不变时无需为一个别名新增镜像测试或完整应用回归；PR 写明实际输出比较结果。

**实际检查：** Node 22.23.1、npm 10.9.8 下连续执行两次 `npm run generate:readme-demo` 成功；SVG（9,476 字节）和 JSON（5,945 字节）两轮结果与原跟踪素材逐字节一致。生成器和 lockfile 未变，包元数据除新增脚本外相同；六个合成概念、11 条关系、固定时间与 `notForLearningImport` 标记保留。文档链接及差异格式通过；没有读取个人知识或学习数据、运行本地浏览器或重复完整应用回归。改动沿用 `develop`，既有发行 tag 不变。

<a id="contrib-02"></a>

## CONTRIB-02：可直接打开的合成图片与 Mermaid 笔记

**已完成（2026-10-01）：** [计算图](../../fixtures/demo-kg/Model/计算图.md)已加入原创静态 SVG 和 Mermaid，示例/阅读说明提供搜索、大窗、图形/源码切换与主题检查入口。本任务仅补公开示例，图片/Mermaid 的专项人工验收仍见 [#18](https://github.com/wolfhawkld/living-memory/issues/18)；以下保留原任务范围。

**原问题：** 图片与 Mermaid 渲染已实现，但默认 16 篇示例没有媒体内容，用户难以直接找到测试对象。

**文件入口：** [示例说明](../../fixtures/demo-kg/README.md)、既有 [Model/计算图.md](../../fixtures/demo-kg/Model/计算图.md)、[附件处理](../../src/server/attachments.ts)、[Markdown 媒体测试](../../tests/markdown-media.test.ts)、[附件测试](../../tests/attachments.test.ts)、[阅读说明](../development/markdown-reader.md)。

**范围：** 在一篇既有示例笔记加入小型原创静态 SVG 和一个简单 Mermaid 围栏，保存仓库内附件，补充如何搜索该节点、打开大窗及切换图形/源码的说明。SVG 以 `<svg` 开始，无脚本、外部资源或网络依赖；不新增概念或修改 renderer/API/依赖。

**验收：**

- 默认仍为 16 个概念、32 条关系；媒体语法不产生额外概念双链，不加入学习日期或预设重温。
- 图片类型在当前附件允许范围内，相对引用可正确解析；图片原创且不含个人路径、截图或第三方版权内容。
- Mermaid 使用可解析的简单语法；说明同时覆盖预期图形和源码入口，并标记合成示例。
- 自动检查与人工浏览器检查分别记录；未运行浏览器时明确保留图片/Mermaid 视觉待验收，不替用户关闭 #18。

**验证：** 定向检查知识解析、附件与媒体测试，确认图谱数量不变；按贡献指南完成 `npm test`、`npm run build`。视觉效果由用户或认领者另行记录，不要求本地浏览器截图作为提交前提。

**实际检查：** 31 项定向检查、496 项完整 Node/HTTP 测试及构建通过。默认知识解析仍为 16 个概念、32 条关系；SSR 挂载一张图片附件和一个 Mermaid 组件。合成临时账号的实际附件请求验证匿名 `401`、正确版本 `200 / image/svg+xml`、错误版本 `409`，SVG 响应逐字节一致，读取前后学习数据不变。SVG XML/静态资源检查通过；Mermaid 原始全文通过实际 parser 的 6 节点、5 条边及标签核对，隔离语法检查用纯文本替身替代无 DOM 的 DOMPurify 层，不证明 strict sanitizer 或浏览器 SVG 绘制。未安装依赖、改变生产策略、读取个人数据或启动本地浏览器；#18 人工视觉继续保留。

<a id="contrib-03"></a>

## CONTRIB-03：空图谱区域的说明与行动入口

**已完成（2026-10-01）：** [GraphSourceContent](../../src/web/GraphSourceContent.tsx)在全库为空且使用图谱模式时显示说明与“刷新知识源”按钮，直接复用 `refreshSource`。新成员默认进入示例状态时，提示先点击“查看真实记录”；时间预览时提示先“恢复实时”。文字、按钮及键盘焦点使用现有主题变量，空库旋转状态显示“暂无节点 · 旋转暂停”。以下保留原任务范围。

**原问题：** 节点列表已有空状态，全库为空时图谱区域仍可能留下没有解释的空画布。新成员的初始空知识库是可复现入口；领域选项由现有概念生成，当前没有可选择的“空领域”。加载失败应继续走原有错误提示，不与空知识库混为一谈。

**文件入口：** [App.tsx](../../src/web/App.tsx)的图谱/列表区域、[GraphView.tsx](../../src/web/GraphView.tsx)、[工作区样式](../../src/web/styles.css)、[账号隔离测试](../../tests/private-accounts-api.test.ts)、[现有浏览器用例](../../tests/e2e/prototype.spec.ts)。

**范围：** 在图谱模式、全库为空时显示简短的 `role="status"` 提示，说明“先将知识 Markdown 放入知识目录，再点击刷新知识源”。可指向顶部既有刷新按钮；若提供图框内按钮，直接复用 `refreshSource`。单独小组件可放入 `src/web`；不重构 App、领域选择或全局错误处理。

**验收：**

- 通过合成的新成员空知识库可看到说明；不把无知识内容误称为正在加载、请求失败或某领域无匹配，不提供此时不存在的切换域选项。
- 指向的刷新按钮可键盘操作，深浅主题下文字清楚；不依赖给空图谱制造虚构节点或默认选中一个概念。
- 非空图谱、列表模式、原有加载错误及 WebGL 不可用处理保持既有行为。
- 显示、刷新或搜索不会新增重温/观察，也不泄露其他账号的概念。

**验证：** 增加能验证实际空/非空分支的有针对性检查，按贡献指南运行 `npm test`、`npm run build`；复用现有认证/合成 fixture，不为测试关闭全局账号校验。浏览器视觉由用户验收。

**实际检查：** 3 项组件 SSR 用例覆盖空库不挂载图谱、不在渲染时刷新，非空库、空筛选视图和列表分支沿用原内容，以及刷新中/锁定状态。既有合成成员 HTTP 用例覆盖空库到刷新后出现成员概念，补充无重温起点、无观察记录及导出隔离断言。499 项完整 Node/HTTP 测试、构建和主题产物的 8 种初始化场景通过。App 的初始加载/连接错误分支、GraphView 的 WebGL 回退未修改；未读取个人数据或启动本地浏览器，实际按钮操作、深浅主题可读性与视觉布局仍由用户验收。

<a id="contrib-04"></a>

## CONTRIB-04：HTTP 错误与 preflight 边界回归

**已完成（2026-10-01）：** 新增 [http-boundaries-api.test.ts](../../tests/http-boundaries-api.test.ts)，用真实 HTTP、合成管理员会话和隔离临时知识/数据目录核对四项边界，并在[开发导览](../development/codebase-guide.md)加入测试入口。以下保留原任务范围。

**原问题：** [app.ts](../../src/server/app.ts)已有 JSON/body 限制、OPTIONS 和未知 API 的处理；[server.test.ts](../../tests/server.test.ts)已覆盖 host/origin/token 等请求约束。需要补充当前缺少的真实 HTTP 错误路径，而不是重复已有校验或修改认证政策。

**范围：** 复用现有 HTTP 测试模式，以临时目录和合成知识覆盖普通非导入 API 的无效 JSON、超过 1 MiB 的请求体、允许/拒绝的 OPTIONS，以及未知 `/api` 路径。导入有独立的 20 MiB 限制且已有对应测试，本任务不重复。只新增/调整相应测试；不改生产路由、错误码、CORS/认证策略或依赖。

**验收：**

- 使用真实请求，断言各路径的状态码和当前契约中的错误码/响应头；不只测内部函数或源文字符串。
- 对需要身份与写入条件的场景使用有效的合成 session，保证失败原因确实是待测边界。
- 验证失败写请求没有产生学习事件或改变重温/配置，临时服务和数据正确清理。
- preflight 分别覆盖当前允许的本机 origin 和不允许的 origin，不把服务改为公网开放。

**当前契约提示：** 普通超限请求应为 `413 / BODY_TOO_LARGE`，无效 JSON 为 `400 / INVALID_JSON`；允许的 OPTIONS 为 204，外部 origin 为 `403 / ORIGIN_FORBIDDEN`，未知 API 用 GET 验证 `404 / NOT_FOUND`。检查允许的 methods/headers、origin 回写与 `Vary`。目前共用 413 文案写 20 MiB，与普通 API 的 1 MiB 不一致；先断言状态/错误码，不把此文案固化成正确的限额说明，文案修正另行确认范围。

**验证：** 定向运行新增测试文件，再按贡献指南完成 `npm test`、`npm run build`。若测出契约与实现矛盾，在 Issue 描述具体证据，再讨论修复范围；不顺手改变安全边界。

**实际检查：** 4 项定向用例、503 项完整 Node/HTTP 测试及构建通过。无效 JSON 返回 `400 / INVALID_JSON`；合法重温请求加尾随空白，恰好 1,048,576 字节返回 `201` 并保存新起点，另一记录多 1 字节返回 `413 / BODY_TOO_LARGE`，原有数据不变。匿名 `OPTIONS` 的本机 `http://127.0.0.1:5173` 返回 `204`、空正文、origin 回写、`Vary: Origin` 及预期 methods/headers；同协议/端口的外部 host 返回 `403 / ORIGIN_FORBIDDEN` 且无允许 origin。已认证的未知 API 返回 `404 / NOT_FOUND`。各失败请求和预检前后完整导出、Snapshot 一致；既有重温起点与配置保留，临时服务与目录清理。未关闭账号验证、读取个人数据、运行本地浏览器或改动生产代码/依赖；共用 413 的“20 MiB”文案问题继续保留，未固化该文案。

<a id="contrib-05"></a>

## CONTRIB-05：原生 Windows 的首次运行记录

**范围调整（2026-10-01）：** 用户暂无 macOS 设备，已明确暂不需要 macOS 支持；本任务只安排原生 Windows 验证，macOS 保留为暂缓、未验证。

**现状：** [新人运行指南](../development/first-run.md)已验证 WSL2/Linux x86_64、Node 22.23.1 与 npm 10.9.8；Windows 原生尚无等价记录，WSL2/Linux 的结果不能代替原生 Windows 验证。

**范围：** 在原生 Windows 的干净 checkout 和独立临时数据目录运行现有默认示例，提交带日期的记录，例如 `docs/development/platform-validation/windows-<日期>.md`，并从新人指南链接。记录 OS/架构、Node/npm、提交版本、shell、准确命令、结果与限制。

**验收：**

- 覆盖 `npm ci`、`npm run build`、本机服务启动、合成管理员建号、默认 16 个概念查询、一次明确重温及停止/重启后保留。
- 使用公开 fixture；把运行数据与凭据放在独立临时目录，不复制或提交数据库、会话、账号密码、完整私密日志。
- 区分命令/HTTP/CLI 结果与浏览器视觉；没测 GPU 或 E2E 时不声明已经通过。
- 失败也可作为有价值的记录：保留可公开复现的命令和精简错误，另开具体缺陷，不借此更新依赖或扩大支持承诺。

**验证：** 由认领者在原生 Windows 实测；维护者检查记录可复现性、本地链接与 `git diff --check`。不要为了此任务更换日常个人数据目录或使用真实 vault。

## 本批之外

自动拟合遗忘参数、多人在线协作、共享知识融合、ChatGPT 语音和 Obsidian 插件仍需独立设计。发布兼容性和版本约定接续 **OSS-08**；本批任务不阻塞日常深浅主题和已有记忆功能的使用，也不把任务发布算作这些功能已实现。
