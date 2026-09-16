# Living Memory

一个由记忆与遗忘机制驱动的个人知识与学习项目：通过动态知识图谱和学习任务，连接知识的外化、整合、回忆、使用与认知修正。目前 P0 时间驱动原型已可运行并进入小范围试用，完整 v0.1 仍在逐步拆解和扩展。

希望最终帮助人回答：**我学到了什么，它与已有知识有什么关系，我现在能否回忆和使用它，以及下一步值得重新思考什么。**

已整理记忆与遗忘研究结论，并形成个人记忆强化流程 v0.1：围绕内容保持和场景调用，将少量训练融入阅读、查询与工作。核心闭环是 **记忆目标 → 提取与使用证据 → 状态与遗忘估计 → 巩固行动 → 延迟检验**；图谱呈现并帮助操作这个闭环。

用户已确认 **先做独立 Web 原型，再接 Obsidian**，图谱采用 **`3d-force-graph` + Three.js**。本次建议以 TypeScript/React、本地服务和独立学习库实现统一的 Web、CLI 与原生语音通道。初期再访规则可解释、可配置；具体参数、接入路径与性能仍需实测。

首批材料使用用户自建的 **progressive-kg**。当前先做 **P0 时间驱动原型**：少量真实概念、最近确认学习/重温的时间、一个统一衰减参数、动态图谱与可选回忆观察，先体验再扩展。完整 v0.1 再分别管理核心解释、细节、场景提取和适用判断；原有多维设计保留，但不再全部作为首轮实现条件。

视觉目标已明确：**桌面优先，整体深色，突出空间纵深、较明显的发光与镜头运动；每个概念或实体用清晰颜色对应记忆/遗忘相关状态。** 当前已确认直接采用上述 3D 技术方向。颜色背后的阶段估计仍需验证；日常以融入阅读、查询和工作为主，附带少量复习。

## 本地运行

使用 Node.js 22.13 或更新版本：

```bash
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:4317`，默认使用 16 个合成概念。接入自己的知识库、数据位置与试用方式见[运行说明](docs/development/p0-running.md)，检查范围见[验证记录](docs/development/p0-validation.md)。

## 从这里开始

- [当前优先：时间驱动原型](docs/design/time-first-prototype.md)：LM-003 收敛方案、单参数曲线、最小交互、五步开发与试用条件。
- [初始模拟数值与连线说明](docs/development/time-colors-and-links.md)：可复现的示例颜色、数值记录及局部图谱连线解释。
- [P0 运行与联调](docs/development/p0-running.md)：启动方式、progressive-kg 接入、时间模拟、观察记录和当前检查边界。
- [首版需求分析](docs/requirements/v0.1.md)：用户确认、记忆理论到产品行为的映射、首版范围与边界。
- [首版技术设计](docs/design/technical-design-v0.1.md)：记忆属性、遗忘/再访规则、知识与事件契约、Web/CLI/语音共用架构。
- [18 项开发任务](docs/planning/development-tasks-v0.1.md)：四个里程碑、依赖、责任线、交付物与完成条件。
- [23 项验收用例](docs/requirements/acceptance-v0.1.md)：记忆语义、数据恢复、真实 3D 与原生语音的可检查标准，尚未执行。
- [阶段进展总结](docs/progress-summary.md)：已确认方向、研究与流程、实际产物、未决事项和下一阶段建议。
- [事件触发与语音设计](docs/design/event-triggers-and-voice.md)：复用 progressive-kg 生成/查询隐式刷新状态，增加 CLI 之外的 ChatGPT 语音入口。
- [离线视觉预览](prototypes/visual-direction.html)：在浏览器中打开，比较空间光效、克制星图与信息阅读；所有关系和状态均为演示。
- [可视化体验 v0.1](docs/design/visualization-spec.md)：空间、颜色、中文标签、镜头、布局与阅读模式。
- [图谱渲染与布局选型](docs/research/visualization-options.md)：已确认的技术方向、官方 Demo、候选比较与验证条件。
- [共研结果总结](docs/research/consolidated-findings.md)：痛点、记忆与遗忘结论、可训练方向、证据边界及未决问题。
- [个人记忆强化系统流程 v0.1](docs/design/personal-memory-workflow.md)：日常入口、两条训练流程、反馈、少量复习、状态维护和图谱展示。
- [项目愿景与待澄清问题](docs/vision-and-questions.md)：用户愿景、待验证的任务闭环、视觉探索与产品假设。
- [progressive-kg 使用场景](docs/research/progressive-kg-context.md)：首批材料的本地结构、字段边界与任务候选。
- [记忆科学研究笔记](docs/research/memory-science.md)：证据、适用边界与可验证的设计启发。
- [理论共研 01](docs/research/memory-theory-foundations.md)：记忆系统、遗忘机制、双强度理论与曲线的测量含义。
- [理论共研 02](docs/research/knowledge-retrieval-and-transfer.md)：从概念细节模糊、工作时难以想起相关知识的体验出发，研究提取与迁移。
- [理论共研 03](docs/research/memory-trainability.md)：记忆相关能力的可训练性，以及内容保持、策略学习和广泛迁移的区别。
- [技术载体研究](docs/research/platform-options.md)：Obsidian 与独立应用的选择条件，以及开源和扩展边界。
- [研究与验证计划](docs/research/validation-plan.md)：如何把文献结论转化为可以检验的体验。

## 研究约定

1. 明确区分论文证据、产品推论、用户偏好与已经做出的决定。
2. 图谱表现的是知识结构、使用记录和学习状态估计；系统无法直接观测人脑中的记忆。
3. 浏览、查询、闭卷回忆、实际应用与总结分别记录，不能仅凭活跃度宣称掌握。
4. 以延迟回忆、解释、迁移应用和维护成本检验价值；节点数与连续打卡天数只反映使用行为。
5. 为开源与可迁移性研究数据边界，具体架构通过原型和真实使用来决定。

## 参与协作

先阅读[首版需求](docs/requirements/v0.1.md)、[任务拆分](docs/planning/development-tasks-v0.1.md)与[协作说明](CONTRIBUTING.md)，再认领任务。开发通过任务分支与 Pull Request 推进。

本仓库包含设计文档和可分享的示例预览。progressive-kg 作为外部知识资源接入；个人会话日志、Agent 本机配置和私有学习记录保留在本地。项目许可证将在未来开源前确定。

状态：2026-09-16，P0 时间驱动原型已[可运行并进入小范围试用](docs/development/p0-validation.md)；完整 v0.1 的 18 项任务与 23 项验收仍保留为后续路线。当前 38 项模型/模拟数据/KG/服务/镜头测试和 8 条真实 Chromium 交互检查已通过；实际 GPU 性能与真实延迟试用尚待完成，语音链路及 Obsidian 宿主属于后续范围。附一个离线 HTML/SVG 风格预览。
