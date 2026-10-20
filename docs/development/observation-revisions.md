# 已保存回忆的自评修订

日期：2026-10-20。OR-05 整理已有自评修订流程的集成证据与集中验收步骤，不新增记忆模型。适用于概念解释、场景调用及飞书脑中回忆已保存的观察。设计及原十二条验收要求见[自评更正与撤销设计](../design/observation-revisions.md)。私人数据升级、部署、本人评分与视觉验收仍待完成。

## 何时使用

选中节点，在「概念学习历史」找到已保存的回忆观察，点击「修订这条观察」。窗口分别显示最初判断、当前采用判断和本次拟提交判断。原答与场景默认折叠；需要核对当时原回答时再明确展开，展开仍属于资料曝光。

| 操作 | 使用情形 | 保存后 |
| --- | --- | --- |
| 更正自评 | 当时误点，或重新核对原回答后判断确有变化 | 有效统计使用新的清晰程度及已有的核对结果／依据；原答与原始自评保留 |
| 暂不计入统计 | 这条证据不可靠 | 从有效统计排除，原历史、真实完成数和复习消耗保留 |
| 恢复采用 | 决定重新采用此前排除的证据 | 恢复该旧样本最后采用的判断，不新增一次练习 |

选择原因，核对本次判断后明确确认。暂不计入统计不是删除个人内容。若想撤回一次更正，可以另作一次更正回原值，审计链仍保留。

修订只更改对当时原回答的判断，不能修改答案、事前信心、提示／曝光条件、作答时间、版本、H、时间起点或手工长期保持。无 learning 的旧记录只改清晰程度，不补造学习结果。脑中回忆与已曝光记录即使更正为成功，也不会成为独立校准样本。后来重新学会或成功应用，应通过对应的新学习／应用入口记录。

当前任务作答期间入口受限，避免历史原答泄露。尚未同步成功的原观察不能修订。首版入口在 Web 节点历史；飞书继续保存原自评，没有新增编辑命令。旧飞书卡片不会被改成新的自评回执。

## 等待、未知与冲突

只有服务确认后才刷新为已保存。确认时的事件 ID、前驱、动作、时间和评分先保存为独立的本机请求；左侧「自评修订待同步」可查看处理状态。

| 状态 | 处理 |
| --- | --- |
| 待确认、断网或保存结果未知 | 保留原请求，手动原样重试；不能据此认定从未保存，不能自动新建事件或改前驱 |
| 服务已确认、本机副本未清理 | 已保存；保留副本可通过 duplicate 重试确认，不重复练习或计数 |
| 已确定拒绝／前驱冲突 | 点击「重新核对当前状态」，成功重读并核对原请求后才归档旧拒绝副本，然后重新选择原因、判断并确认新的决定 |
| 已归档 | 可显式清除本机归档副本；服务上的原观察和审计不删除 |

未知结果不能归档或改前驱，只能保留原请求原样重试、核实回执。切换账号、来源或实例后不能重放旧空间请求；同时打开多个页面也不会替另一个页面自动重试。队列无法安全读取时应先解决存储问题，不能覆盖旧副本。详见[独立队列设计](../design/observation-revisions.md#or-04-网页修订与独立待同步)。

## 十二条轨迹的证据对应

以下编号严格对应[原十二条轨迹](../design/observation-revisions.md#必须覆盖的验收轨迹)。表中名称是实际测试标题，可在链接文件中定位。纯逻辑、临时 SQLite、合成 HTTP 与远端浏览器分别说明验证层次；组合证据不等于每一边界均跑过真实私人实例。

| 轨迹 | 可定位的断言 | 证据层次与边界 |
| --- | --- | --- |
| 1：80% 信心 success → failure | [acceptance](../../tests/observation-revision-acceptance.test.ts)：`cross-midnight reassessment changes calibration without moving original practice, frozen time state or nonempty daily consumption` | 真实临时 Store：两样本成功率 100 → 50、Brier .04 → .34；history／overview 一致。真实起点、H=11.5、长期保持及原始行含请求字节保持。 |
| 2：撤销与恢复是同一旧样本 | 同上；[网页](../../tests/e2e/observation-revisions.spec.ts)：`saved observation revise, withdraw and reinstate refresh adopted summaries without rewriting memory evidence` | Store 三动作、原 total／完成数不减，恢复不是新练习；网页同时覆盖窗口、汇总、深浅主题及作答遮蔽。 |
| 3：不升级原证据条件 | [acceptance](../../tests/observation-revision-acceptance.test.ts)：`persisted mental, exposed and legacy reassessments cannot manufacture independent calibration or missing learning` | 持久化 mental／已曝光从 failure 改 success，仍零校准；旧记录 learning 保持缺失，原请求仍 duplicate。 |
| 4：清晰程度与核对结果独立 | [恢复](../../tests/instance-backup-compat.test.ts)：`legacy restoration preserves legal independent rating and outcome pairs, exact original retries and JSON2 evidence` | 合成旧结构完整备份 → 新目录恢复 → Store → JSON2，保留合法不对应组合、两命名空间原行及原请求幂等；不改固定 b16 样本。 |
| 5：重复、并发、丢回执 | [账本](../../tests/observation-revision-store.test.ts)：`duplicate receipt wins over advanced tail and invalid new clock, conflicts never change persisted requests`；[并发](../../tests/observation-revision-store-integration.test.ts)：`two processes racing from the same parent tail produce exactly one persisted successor`；[网页](../../tests/e2e/observation-revisions.spec.ts)：`lost accepted response survives closing and retries the exact durable request as a duplicate`、`concurrent predecessor conflict needs fresh inspection, archival and a separately confirmed new decision` | 真实双进程 SQLite；网页接受后丢响应、固定请求重试与新前驱再次明确确认。 |
| 6：接收时间与原自然日 | [acceptance](../../tests/observation-revision-acceptance.test.ts)：`cross-midnight reassessment changes calibration without moving original practice, frozen time state or nonempty daily consumption` | 上海午夜前后均有非空完成集合；接收前 asOf 仍用原判断，修订不改观察间隔 7 天、排序或所属自然日。 |
| 7：存档来源与版本隔离 | [HTTP](../../tests/learning-protocol-api.test.ts)：`revision routes keep archived parents private, validate path/body and preserve receipts, original evidence and anchors`；[投影](../../tests/observation-revision-evidence.test.ts)：`historical source reassessment stays with its original version and before-receipt projections use the old judgment` | HTTP 实测删除来源文件后仍能修订存档，另账号不可访问；纯投影验证 v1 不搬入 v2。未声称执行过真实改版部署。 |
| 8：导入全链与事务 | [Store](../../tests/observation-revision-product-store.test.ts)：`V2 import commits parent and full chain atomically with original receipts, V2 backup and exact retries; V1 leaves existing revisions intact`、`late revision insert failure rolls back parent/config/catalog/layout/receipt and leaves a retryable import`；[坏链](../../tests/observation-revision-import.test.ts)：`parent attribution, cycles, forks, missing predecessors and illegal state changes fail without reverting to raw scores`；[acceptance](../../tests/observation-revision-acceptance.test.ts)：`a revision alone invalidates an import preview before backup or any import mutation and a fresh preview can commit` | Store 往返与事务失败；坏链为导入逻辑验证；追加修订单独使旧 token 失效，提交零备份、所有表零变更，重预览可提交。 |
| 9：旧格式拒绝与新目录恢复 | [b16 入口](../../tests/legacy-format-rejection-compat.test.ts)：`actual b16 JSON parsing entry rejects a current JSON2 export before timestamps or downstream import work`、`actual b16 restore entry rejects an unmodified new-tool bundle2 before inventory or creation of any target stage`；[恢复](../../tests/instance-backup-compat.test.ts)：`actual b16 v1 bundle verifies and restores to v2 only in a new quarantined instance without changing source bytes`、`explicit legacy preservation uses the real v1 bundle but still changes instance and revokes active sessions` | 固定原始解析入口及合成完整恢复，不冒充完整旧二进制启动演练；真实私人备份、旧程序回退仍待本人执行。 |
| 10：协议 2 门禁 | [HTTP](../../tests/learning-protocol-api.test.ts)：`authenticated data requires exactly protocol 2, before writes, with only explicit handshake/auth/health exceptions`、`only GET attachment bytes bypass header; SSE requires a single explicit query and retains source checks`、`protocol rejection follows authentication and never initializes a lazy member knowledge store`；[客户端](../../tests/learning-protocol-client.test.ts)：`Web coalesces handshake, sends protocol on JSON/blob, and never renews or replays 426 writes`、`CLI requires declared protocol 2 before refresh or local receipts and sends it on successful writes` | 缺失／旧协议真实 HTTP 426 且零写；新客户端握手及不自动重放。没有执行旧 Web 二进制。 |
| 11：旧分页、SSE 与任务遮蔽 | [分页](../../tests/concept-history-loader.test.ts)：`revision watermarks invalidate all loaded pages even when raw totals do not change`；[网页](../../tests/e2e/observation-revisions.spec.ts)：`real changes stream invalidates loaded later history pages after another tab revises their observation`；同文件的三动作用例检查任务遮蔽 | 远端浏览器轨迹：载入两页，另一标签通过正常 UI 修订，真实 SSE 自动重读首屏、丢弃旧分页并可加载新版第二页。隐藏页面按现有可见性规则延迟刷新。编写时仅做静态核查／枚举，执行结果见本提交 CI。 |
| 12：飞书旧操作与独立重温 | [飞书合成能力](../../tests/feishu-review-capability.test.ts)：`batch assessment revisions and old grade or rewarm replays preserve the frozen queue, receipts and independently saved rewarm` | 先创建批次、自评并单独确认重温，再三动作和旧 grade／rewarm 重放；非空完成集合、批次、操作回执、起点与预算不变。未发送真实飞书消息。 |

## 升级前提

按[完整实例离线备份与迁移](instance-migration.md)先处理旧实例停机证明、备份校验、新目录恢复及学习 schema 升级。遇到 `/proc` 权限边界时，按既有说明在本人终端执行所需 sudo；本轮不替本人运行。学习 JSON 不能代替完整实例备份。

新版学习 JSON／bundle 为 v2，升级后的学习数据库为 schema 2；完整 bundle 备份已识别旧库时可声明 schema 1 并保持源库不变。恢复更换实例标识、撤销旧会话并隔离连接器；重新登录、核对数据后再按说明显式启用连接器。旧队列不跨实例自动重放。升级目录不能原地降级；回退需要升级前备份、另一个新目录及配套旧程序。完整边界见[版本兼容约定](../releases/versioning-and-compatibility.md)。

## 本人集中验收记录

可以在几个功能准备好后集中验收，不需要日常维护手工题库。以下均为待验，不要求为测试篡改真实评分或模拟真实断网；失败路径由上述合成测试覆盖。有真实误点需要纠正时再体验对应动作。

每次记录软件提交／版本、日期、账号及来源（不记密码）、入口、预期、实际和备注。私人备份位置与个人回答留在本机，不提交仓库。

| 项目与入口 | 预期 | 实际／备注 |
| --- | --- | --- |
| 终端：升级前完整备份、新目录恢复 | 校验通过，旧目录与备份保留；新实例重新登录，连接器隔离 | 待本人执行／记录版本与日期 |
| Web 登录与来源选择 | 账号、领域、节点数量和原记忆状态对应当前本人数据；来源／实例正确 | 待验 |
| 节点 → 概念学习历史 → 修订窗口 | 最初／当前／拟提交三列可读，原答默认折叠；深浅主题控件与焦点清晰 | 待验 |
| 真实需要纠正的原观察 → 更正自评 | 更正后历史与汇总一致，原答、事前信心、H、起点和长期保持不被改动；修订不重置曲线，时间流逝仍可自然衰减、变色 | 待验；无真实更正需求可暂留 |
| 真实需要排除的证据 → 暂不计入／恢复 | 排除后历史保留、复习消耗不退；恢复同一旧样本，不新增练习 | 待验；不为验收造假评分 |
| 本机已有待同步／冲突（如自然发生） | 未知仅原样重试；确定冲突先重读和归档，再明确确认新决定 | 待验／无此情形可跳过本人故障体验，合成证据保留 |
| 旧版本观察与旧飞书卡片（如已有） | 仍归原版本，旧卡片保留原自评回执；重放不重复消耗或撤销独立重温 | 待验；恢复隔离时旧卡作废，不能跨实例重试 |
| 后续真实使用 | 另记纠错是否方便、统计是否有帮助；记忆收益需要持续观察 | 待验，自动测试不证明学习效果 |

## 检查记录

OR-04 基线提交 `f4f1570` 的 [CI 39380625199](https://github.com/wolfhawkld/living-memory/actions/runs/39380625199) 已通过 1,420 项 Node／HTTP、构建、8 项主题场景与 32 项远端浏览器用例。本轮另补 5 项 Node 组合用例与 1 项浏览器用例。

OR-05 提交前统一检查：1,425 项 Node／合成 HTTP 全部通过，无失败、取消或跳过；含类型检查的隔离构建及 8 项主题检查通过，产物仅写入 `/tmp/lm-or05-20261020-build`。本机只枚举 33 项浏览器用例，不执行浏览器或截图验证。文档核对保留原 23 行验收矩阵及原 12 条轨迹，275 处本地链接、42 处锚点及 27 个精确测试标题检查通过。

提交后的浏览器实际执行结果以该提交的远端 CI checks 为准，不能用 OR-04 的 32 项旧结果代替本轮 33 项。此说明记录提交前事实，个人数据与部署不进入 CI。

首轮 OR-05 提交 `a84bb60` 的 [CI 39399383833](https://github.com/wolfhawkld/living-memory/actions/runs/39399383833) 中，1,425 项 Node／HTTP、构建与主题通过，浏览器 29 项通过后触及 600 秒全套限时，4 项未完成，不能记作全套通过。新增 SSE 用例已通过；按日志中相邻开始时间比较，28 个共同旧用例整体耗时约为 OR-04 的 1.58 倍，这包含 hooks／切换，不能据此确定具体环境根因。经架构复核，仅将 CI job 上限从 15 调到 20 分钟、浏览器总限时从 600 调到 900 秒；33 项、单项 60 秒、断言、单 worker 和首错停止均保留。后续完整结果以新提交的 CI 为准；若仍超时，应重新诊断，不继续递增预算。

软件集成和验收材料完成，不等于私人升级、真实评分正确性、设备视觉或完整 AC-12／AC-23、v0.1 已验收。模型仍为 `time-only-v0`，没有自动调参、多目标独立间隔或自动巩固。
