# 本地 Web 预览发布准备

本页保留发行前的范围与核对流程；固定版本的使用说明见 [v0.0.1-preview.1](v0.0.1-preview.1.md)，最终提交和发布结果以 [GitHub release](https://github.com/wolfhawkld/living-memory/releases/tag/v0.0.1-preview.1)为准。

更新：2026-10-01。本文供维护者核对首个预览版的范围和发布条件，也帮助贡献者了解默认分支中的程序能做什么。可运行应用、合成示例、MIT 许可和通过检查的开发成果已通过 [PR #37](https://github.com/wolfhawkld/living-memory/pull/37) 同步到 `main`；正式预览发布需完成下述准备。候选名称为 **Living Memory 本地 Web 预览版**，候选 tag 为 `v0.0.1-preview.1`，尚未发布。

后续 [PR #38](https://github.com/wolfhawkld/living-memory/pull/38) 已将 OSS-03～06 的运行、公开内容检查和协作准备集中同步到 `main`，合并提交 `400f622`；该阶段的分支与 PR CI 均通过。OSS-07 导览与首批任务已在 `develop` 完成，OSS-08 已建立[更新记录](../../CHANGELOG.md)、[版本兼容约定](versioning-and-compatibility.md)及[升级恢复步骤](upgrade-and-recovery.md)，包元数据准备为 `0.0.1-preview.1`。这些后续成果仍需集中进入最终发行的 `main` 提交。

## 默认分支同步范围

本轮以长期 `develop` 为来源，集中评审后合入 `main`。OSS-02 开始检查时的历史快照为 `main=1db01b4`、`develop=8d3f151`，相差 55 个提交、286 个文件；这不是当前分支差异，后续已由 PR #37/#38 集成。下列功能属于累计成果，具体交互与未验收部分以对应开发说明为准。

| 范围 | 本阶段包含的内容 |
| --- | --- |
| 图谱与阅读 | 3D/2D 图谱、深浅主题、领域切换、全库搜索、按需跨域关联、发光与空闲旋转、自适应镜头；Markdown 大窗、公式、图片和 Mermaid |
| 记忆记录 | `time-only-v0` 时间基线、明确确认重温、估计日期补记、冻结的回忆观察、场景调用与事前信心、本人确认长期保持 |
| 学习管理 | 少量复习、重点/暂缓与预算、中断续做、应用和总结、学习历史、薄弱点总览、时间与表现对照、前后观察对照、知识修正人工跟进 |
| 数据与账号 | 本地管理员/成员登录与私人知识空间、JSON 导出及预览恢复、人工确认概念改名/移动的历史衔接、待同步协调、超时及幂等重试 |
| 开发与集成 | Node/TypeScript 本地服务、React/Vite 前端、SQLite 学习库、CLI、可选 progressive-kg 收尾刷新 hook、16 个合成概念、测试和 CI、MIT 许可 |

默认示例不要求贡献者拥有 progressive-kg。知识内容与个人学习记录独立；浏览、查询和生成不会自动确认重温，回忆与使用证据暂不自动调整遗忘参数。长期保持只有本人手工解除才恢复衰减。

阶段集成时仅核对了范围、跟踪文件与运行所需入口。后续 OSS-05 已检查可达历史文本、全部 13 个 PNG 版本、示例、依赖许可及两份 CI 日志，并泛化公开文档的个人库存信息；范围与限制见[公开内容检查记录](public-content-review-2026-10-01.md)。未发现跟踪的个人数据库、凭证目录或构建产物，不将这次有限检查当作完整审计。

## 已有验证和待验收范围

历史阶段提交 `9d14cf0` 的 [分支 CI](https://github.com/wolfhawkld/living-memory/actions/runs/36824188815) 与 [PR CI](https://github.com/wolfhawkld/living-memory/actions/runs/36824199178) 均通过，覆盖 496 项 Node/HTTP 测试、构建、主题构建检查及 10 项浏览器回归。PR #37 合入 `main` 的提交为 `d9e847e`，当时仅再补充该次集成结果文档；其应用、测试、包元数据及 CI 配置与当时通过检查的阶段提交一致。后来新增的文档、准备版本和验证见本页后续记录，正式发布仍需核对最终发行提交。

2026-10-01 已核对 OSS-07 文档提交 `e6c5ac7` 的 [develop CI](https://github.com/wolfhawkld/living-memory/actions/runs/36846175655) 全部通过。OSS-08 另通过 38 项兼容专项、构建与合成原路径恢复演练，具体范围见[验证记录](upgrade-validation-2026-10-01.md)；这些证据不替代最终发行提交的 CI。

CI 浏览器使用 Linux 软件渲染，验证基本 WebGL 和交互路径。本地浏览器视觉验收由用户进行；实际桌面 GPU 帧率、功耗、大知识库规模和其他系统的安装体验尚没有完整验证结论。真实延迟回忆与记忆收益也仍待观察，时间颜色是管理提示，不是记忆百分比。

复习安排的专项浏览器试用曾按用户要求跳过；图片/Mermaid 专项、导入恢复、历史衔接和外部 KG 更新等验收范围分别见 [迭代 TODO](../planning/iteration-todo-2026-09-22.md)。用户已确认部分交互，不将这些确认扩大为所有异常路径通过。

## 版本和分发方式

`v0.0.1-preview.1` 是候选预览 tag；`develop` 的 `package.json`、lockfile 顶层及根包版本现已统一为准备版本 `0.0.1-preview.1`，依赖解析不变。tag 仍待最终发行的 `main` 提交通过检查后创建。设计文档中的完整 v0.1 路线与软件预览版本是不同概念，前者仍未整体完成。

首个预览提供源码与安装说明。用户在本机执行 `npm ci`、`npm run build` 和 `npm start`，首次打开 `http://127.0.0.1:4317` 创建管理员，再使用合成示例或接入自己的 Markdown 知识源。当前建议使用与 CI 相同的 Node `22.23.1`；OSS-03 已核验隔离目录运行流程并保存[新人运行指南](../development/first-run.md)。指南已改为发布后使用固定 tag，发布前及贡献者使用 `develop`；OSS-07～08 文档与版本准备仍待阶段集成。当前不附带 `node_modules` 或 `dist`；未来分发构建包时按[第三方许可检查](third-party-licenses.md)保留实际包含的代码与字体许可。

GitHub release 由 tag 固定源码位置，并自动提供源码归档；发布时应明确标记为 prerelease。当前 `private: true` 继续防止误发 npm 包，首轮不提供独立安装器或托管在线服务。tag、release 页面与源码版本的关系见 [GitHub release 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)和[发布管理](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

## 升级与数据保留

本轮版本元数据和文档不新增数据库迁移或改变记忆规则。已有使用者先按[升级与恢复步骤](upgrade-and-recovery.md)同步待写入记录，暂停服务并完整备份数据、外部知识及目录外 CLI 状态，再更新源码、安装依赖与构建。浏览器状态另行处理；恢复使用配套源码/数据和原知识路径，不承诺改变根目录后自动衔接。

学习 JSON 当前使用 `schemaVersion: 1`，可按[导入恢复说明](../development/learning-data-import.md)预览、去重并确认恢复；它不包含 Markdown 正文、附件、账号密码或浏览器草稿。导出恢复不能代替整机迁移或完整备份。SQLite 没有统一结构版本和通用迁移机制，预览也不承诺稳定公开 API；具体旧字段、版本与客户端边界见[兼容约定](versioning-and-compatibility.md)。

## 正式预览发布前的清单

- [x] OSS-03：固定 Node 版本文件，核验干净目录安装、首次建号、示例知识源和自有知识库接入。
- [x] OSS-04：重组 README、分类文档导航与当前使用说明，新增明确标记的合成示意图；历史图片的公开内容检查继续按 OSS-05。
- [x] OSS-05：记录历史内容、附件、许可与 CI 日志的有限检查范围，泛化个人库存信息并补充截图说明；旧版本仍保留于 Git 历史。
- [x] 按当前已实现功能写明安装步骤、数据备份、已知限制和贡献入口；README 与 CONTRIBUTING 保持一致。
- [x] OSS-06：贡献指南、Issue/PR 模板、安全报告、行为与维护约定进入默认分支；私密漏洞报告已启用，旧草稿 PR 已收口。
- [x] OSS-07：在 `develop` 保存模块导览，发布并核对可认领 Issues #39～43；任务本身仍待实施。
- [x] OSS-08 维护基础：准备更新记录、版本/数据/API 约定、完整备份恢复与有限验证记录。
- [x] 选择 `0.0.1-preview.1` 准备版本并统一包/lockfile 元数据，不改变依赖或数据格式。
- [ ] 将 OSS-07～08 集中同步到最终发行的 `main`；核对精确提交的 CI、归档清单与未验收记录，整理对应版本的 changelog/release notes。
- [ ] 在已核对的提交上创建 tag，填写 release notes 并标记 prerelease，核对归档内容后发布。

准备版本和默认分支同步不会自动满足正式发布条件。维护基础已建立；后续按最后两项完成最终集成和预览发布，不把当前包版本视为已经发行。

## 候选预览发布说明

以下内容可在发布条件满足后作为 release notes 的基础，发布时需补充最终提交、版本、检查链接与仍待处理的限制。

Living Memory 是一个在桌面浏览器中使用的本地知识与记忆管理原型。它把 Markdown 概念呈现为动态图谱，以明确重温时间提供颜色提示，并记录独立回忆、场景调用、信心、应用总结和知识修正。时间提示采用可解释的全局参数，不代表已测出的个人记忆能力。

这个预览包含图谱与阅读、个人学习记录与少量复习、本地账号隔离、CLI 和可选 KG 刷新 hook、合成示例与 MIT 许可。默认服务仅监听本机；在线部署、知识共享、语音与 Obsidian 宿主仍在后续路线。使用和反馈入口见 [README](../../README.md)、[运行说明](../development/p0-running.md)与[贡献指南](../../CONTRIBUTING.md)。
