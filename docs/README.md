# Living Memory 文档导航

更新：2026-10-01。当前使用从[新人运行指南](development/first-run.md)开始，项目概览见[仓库首页](../README.md)。这里保留功能、设计、研究和历史入口；有日期的测试数量与待实现描述只反映对应阶段，不代表今天的完整状态。

## 快速开始

- [新人运行指南](development/first-run.md)：固定 Node 版本、安装建号、数据位置和自有 Markdown 接入。
- [合成示意图与生成说明](assets/README.md)：用于解释知识结构与时间提示，不是实际界面截图或学习备份。
- [P0 验证记录](development/p0-validation.md)：早期交互检查与后续验证记录；近期 CI 和隔离运行结果见开源准备记录。
- [协作说明](../CONTRIBUTING.md)与 [GitHub Issues](https://github.com/wolfhawkld/living-memory/issues)：反馈问题、确认任务范围和提交贡献。
- [模块与数据流导览](development/codebase-guide.md)：定位代码、数据存储、跨端请求和对应测试。
- [首批可认领任务](planning/first-contribution-tasks.md)：限定范围的文档、合成媒体、空状态、HTTP 回归和平台运行验证。
- [安全报告](../SECURITY.md)、[行为准则](../CODE_OF_CONDUCT.md)与[维护者说明](../MAINTAINERS.md)：私密漏洞入口、交流边界和维护责任。

## 运行与知识浏览

- [P0 运行与联调](development/p0-running.md)：启动方式、progressive-kg 接入、时间模拟、观察记录和当前检查边界。
- [原生 Windows 首次运行验证（2026-10-01）](development/platform-validation/windows-2026-10-01.md)：固定 `develop` 提交的安装、构建、合成账号、HTTP/CLI 重温与重启保留；浏览器/GPU 未测，macOS 暂缓。
- [私人账号与知识域](development/private-accounts.md)：登录、创建成员、私人知识源隔离、旧记录保留、CLI 设备身份及未来共享边界。
- [知识域视图](development/domain-views.md)：完整索引、目录领域切换、跨域展开、CLI/Web 范围和布局保存。
- [Markdown 与大窗阅读](development/markdown-reader.md)：渲染知识正文、表格与公式，打开大窗口阅读和调整字号。
- [初始模拟数值与连线说明](development/time-colors-and-links.md)：可复现的示例颜色、数值记录及局部图谱连线解释。

## 记忆练习与知识跟进

- [少量复习入口](development/brief-review.md)：从当前领域按时间状态推荐 3/5 个概念，复用回忆、核对与信心记录；可跳过、结束，单独确认重温才更新时间起点。
- [复习安排与中断续做](development/review-arrangements.md)：节点重点/暂缓、跨领域每日预算、当前浏览器自动保存作答与暂停续做；恢复时重新核对资料和时间起点。
- [场景调用、信心校准与长期保持](development/scenario-confidence-retention.md)：场景调用与事前信心记录、核对结果比较、本人固定保持和手动恢复衰减。
- [逐概念学习历史](development/concept-history.md)：查看重温、补记与回忆观察，区分当前起点、旧版本、冻结观察值和待同步记录。
- [实际应用与总结记录](development/application-records.md)：从节点保存使用场景、结果、局限与 insight，在学习历史中回看；预览复制选定的 KG 整理材料，保存不改记忆时间或回忆评分。
- [知识薄弱点总览](development/learning-overview.md)：跨概念查看最近回忆困难、场景待核对线索和信心对照，按领域筛选并跳转节点；明确当前版本、样本数及缺少证据，不生成记忆能力分数。
- [时间提示与回忆表现对照](development/time-recall-comparison.md)：在知识薄弱点总览中查看冻结的历史时间指标与自评，分开估计日期和提示条件，定位近期仍模糊、较久仍清晰的概念。
- [节点回忆变化追踪](development/learning-progress.md)：分别对照同一资料版本最近两次概念解释与场景练习，展示真实作答间隔、提示条件、信心和核对结果。
- [知识修正建议的人工跟进](development/knowledge-corrections.md)：在原应用/总结下记录已纳入当前版本、暂不采用或重新打开，保留处理历史并支持导出恢复；决定不改变记忆时间。
- [知识修正待办总览](development/correction-overview.md)：集中查看各领域待处理和版本待复核的建议，筛选状态并直接定位较早的原记录，保留正文折叠与人工决定。

## 数据、历史衔接与日常通道

- [学习数据导入恢复](development/learning-data-import.md)：JSON 预览、来源/版本对应、重复与冲突检查、事务恢复及导入前备份。
- [概念改名与移动后的历史衔接](development/concept-identity.md)：人工预览确认路径对应，保留原学习时间与稳定身份，支持连续移动、冲突诊断和绑定前备份。
- [待同步协调与超时恢复](development/pending-sync.md)：按知识空间协调多个页面的队列；参数请求可按历史版本重复确认；请求超时保留原记录并释放同步锁。更新后需刷新所有项目页面。
- [CLI 与 KG 日常触发](development/cli-and-kg-triggers.md)：查询、明确确认重温、重试、Agent 收尾钩子与页面变化通知。

## 路线、主题与验证进度

- [开源协作准备与 TODO（2026-09-27）](planning/open-source-readiness-2026-09-27.md)：开源任务、已完成的运行/CI/文档/内容检查与后续协作准备。
- [本地 Web 预览发布清单](releases/local-web-preview.md)：本轮集成范围、验证边界、数据备份与已完成的发布清单。
- [0.0.1-preview.1 版本说明](releases/v0.0.1-preview.1.md)：固定 tag 的安装、当前功能、兼容与验证边界。
- [首个预览实际发布记录](releases/preview-publication-2026-10-01.md)：精确提交、tag、CI、源码归档和实际发布状态。
- [更新记录](../CHANGELOG.md)与[版本/兼容约定](releases/versioning-and-compatibility.md)：发行版本、学习格式、模型、数据库和客户端的独立边界。
- [完整备份、升级与恢复](releases/upgrade-and-recovery.md)：收拢待写入、停止完整复制、原路径恢复及跨根迁移限制。
- [版本准备与合成恢复验证](releases/upgrade-validation-2026-10-01.md)：38 项兼容专项、构建、两账号恢复演练与平台证据范围。
- [公开内容检查记录](releases/public-content-review-2026-10-01.md)：可达历史、图片、合成材料与 CI 日志的检查范围、修正与限制。
- [第三方许可检查](releases/third-party-licenses.md)：依赖与 KaTeX 字体许可，源码及未来构建包的分发边界。
- [开源协作实施记录](development/collaboration-maintenance.md)：贡献模板、仓库配置及旧 PR/分支收口的实际结果。
- [演示后的迭代 TODO（2026-09-22）](planning/iteration-todo-2026-09-22.md)：当前完成范围、原有待办入口，以及学习历史、少量复习和场景调用的后续顺序。
- [浅色主题 TODO](planning/light-theme-todo.md)：主题选择/本机偏好、工作区与阅读层、[3D/2D 图谱](development/theme-graph.md)、[Mermaid 与图片容器](development/theme-media.md)均已接入；THEME-06 自动检查完成，待用户按[试用清单](development/theme-validation.md#用户试用清单)进行浏览器验收。
- [阶段进展总结](progress-summary.md)：保留早期共研与阶段检查，当前功能以首页和专项开发说明为准。

## 需求、设计与验收规格

- [首版需求分析](requirements/v0.1.md)：用户确认、记忆理论到产品行为的映射、首版范围与边界。
- [首版技术设计](design/technical-design-v0.1.md)：记忆属性、遗忘/再访规则、知识与事件契约、Web/CLI/语音共用架构。
- [18 项开发任务](planning/development-tasks-v0.1.md)：四个里程碑、依赖、责任线、交付物与完成条件。
- [23 项验收用例](requirements/acceptance-v0.1.md)：完整 v0.1 的记忆语义、数据恢复、真实 3D 与语音规格，尚未整体验收；已有 P0 检查另有记录。
- [P0 时间驱动方案](design/time-first-prototype.md)：LM-003 收敛方案、单参数曲线、最小交互、五步开发与试用条件。
- [个人记忆强化系统流程 v0.1](design/personal-memory-workflow.md)：日常入口、两条训练流程、反馈、少量复习、状态维护和图谱展示。
- [事件触发与语音设计](design/event-triggers-and-voice.md)：复用 progressive-kg 生成/查询隐式刷新状态，增加 CLI 之外的 ChatGPT 语音入口。
- [可视化体验 v0.1](design/visualization-spec.md)：空间、颜色、中文标签、镜头、布局与阅读模式。
- [项目愿景与待澄清问题](vision-and-questions.md)：用户愿景、待验证的任务闭环、视觉探索与产品假设。
- [离线视觉预览](../prototypes/visual-direction.html)：在浏览器中打开，比较空间光效、克制星图与信息阅读；所有关系和状态均为演示。

## 研究依据

- [共研结果总结](research/consolidated-findings.md)：痛点、记忆与遗忘结论、可训练方向、证据边界及未决问题。
- [记忆科学研究笔记](research/memory-science.md)：证据、适用边界与可验证的设计启发。
- [理论共研 01](research/memory-theory-foundations.md)：记忆系统、遗忘机制、双强度理论与曲线的测量含义。
- [理论共研 02](research/knowledge-retrieval-and-transfer.md)：从概念细节模糊、工作时难以想起相关知识的体验出发，研究提取与迁移。
- [理论共研 03](research/memory-trainability.md)：记忆相关能力的可训练性，以及内容保持、策略学习和广泛迁移的区别。
- [图谱渲染与布局选型](research/visualization-options.md)：已确认的技术方向、官方 Demo、候选比较与验证条件。
- [技术载体研究](research/platform-options.md)：Obsidian 与独立应用的选择条件，以及开源和扩展边界。
- [progressive-kg 使用场景](research/progressive-kg-context.md)：泛化后的知识源结构、字段边界与任务候选，不分发原始考察库存。
- [研究与验证计划](research/validation-plan.md)：如何把文献结论转化为可以检验的体验。
