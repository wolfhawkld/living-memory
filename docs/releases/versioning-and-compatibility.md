# 版本与兼容约定

更新：2026-10-01。适用于本地 Web 预览与后续维护；现有实现入口见[开发导览](../development/codebase-guide.md)。本页区分已实现的兼容行为和今后改动应遵守的约定，不把文档约定当成自动迁移功能。

## 四种版本分别维护

| 对象 | 当前值 / 实现 | 用途 |
| --- | --- | --- |
| 软件版本 | `package.json` 与 lockfile 为 `0.0.1-preview.1` | 首个预览已发布；固定 tag 为 `v0.0.1-preview.1`，精确目标与结果见 [GitHub release](https://github.com/wolfhawkld/living-memory/releases/tag/v0.0.1-preview.1) |
| 学习 JSON 格式 | `schemaVersion: 1` | 导出/导入结构，与软件版本独立 |
| 记忆模型 | `time-only-v0` | 标识时间投影语义；配置 revision 标识本人修改 H 的历史，不是软件或格式版本 |
| SQLite 结构 | 没有统一 schema version | 启动时创建缺失表，已知旧观察表补 `learning_json` 列；没有通用升级/降级框架 |

包版本必须在 `package.json`、lockfile 顶层和 `packages[""]` 三处一致。只改项目版本时不重新解析依赖，不改变 JSON schema、模型版本或既有学习事件。`private: true` 用来防止误发 npm，不妨碍源码开源。

## 发行规则

- 预览按 `0.0.1-preview.1`、`0.0.1-preview.2` 等序号推进；正式版本另按实际范围选择。完整 v0.1 的设计路线不等于已经发行 `0.1.0`。
- 日常改动进入 `develop`，累计变化写入根目录[更新记录](../../CHANGELOG.md)的 `Unreleased`。阶段集成到 `main` 后，在精确发行提交上核对 CI、数据说明和未验收范围，再固定 tag 与 release。
- 发行时把本次 `Unreleased` 内容整理为版本/日期条目，并保留新的 `Unreleased`；预览 release 标记 prerelease。未发行的准备版本不补造发布日期。
- 已发行 tag 不移动、不覆盖。修正以新版本与新说明发布，支持范围以该版本实际验证记录为准。
- 0.x 阶段也必须记录破坏性变化。兼容修复、功能增加和不兼容变更分别说明；不兼容变更应选择新的版本范围，而不是只靠预览序号隐藏。

首轮分发源码与安装说明；不附带数据库、私人知识、`node_modules` 或 `dist`。未来附带构建包/运行时之前，按[第三方许可检查](third-party-licenses.md)生成实际分发内容的许可材料。

## JSON v1：当前能恢复什么

定义在 [ExportData](../../src/shared/types.ts)，校验和映射见 [import-plan.ts](../../src/server/import-plan.ts)。仅接受 `schemaVersion: 1`；其他值返回 `UNSUPPORTED_SCHEMA`，不会自动转换为 v1。

| 字段/情况 | 当前兼容行为 |
| --- | --- |
| 基本结构 | 必须有导出时间、来源、概念清单、当前配置/配置历史、重温、观察和布局；完整字段校验以实现为准 |
| 可选后续字段 | `retentions`、`applications`、`corrections` 缺失时视为无此类事件；`reviewPlan` 缺失不改当前计划 |
| `restoreMetadata` | 旧 v1 可缺失，会提示 `LEGACY_RESTORE_METADATA`；配置时间用导出时间补齐，无法保证旧“省略发生时间”请求恢复后仍可原样重试 |
| `identityBindings` | 仅审计，非空时提示 `IDENTITY_BINDINGS_UNTRUSTED`；上传的绑定不创建本机授权关系 |
| 概念对应 | 先核对相同 ID 与已登记路径；无 ID 对应时只接受唯一的相对路径＋资料 revision，不靠标题猜测 |
| 重复/冲突 | 完全相同事件可去重；同 ID 换类型或内容、配置历史矛盾、处理链分叉等阻止整批恢复 |
| 布局/复习安排 | 默认不恢复；明确勾选后按现有合并规则处理，不把缺失数据当作删除命令 |

当前模型历史只接受 `time-only-v0`，配置 revision 连续且当前配置与末项一致，H 范围为大于 0、最多 3650 天。观察中的 H、间隔、衰减和起点按历史校验并保留，不用今天的配置覆盖。

导入限 20 MiB、50,000 条事件、10,000 项概念元数据与布局。导入到当前账号的空间；JSON 不能指定另一用户或磁盘路径。[readme-demo.json](../assets/readme-demo.json) 是素材数据，不属于学习导入格式。具体预览、备份、去重与确认流程见[学习数据导入恢复](../development/learning-data-import.md)。

JSON 不包含知识正文、关系、附件、账号密码或浏览器草稿，也不能完整重建本机身份绑定登记。它是学习数据交换，不是应用整体备份。

## SQLite：当前迁移范围

[Store.initialize](../../src/server/store.ts)使用 `CREATE TABLE IF NOT EXISTS` 补缺失表，并为已知旧 `observations` 表增加可空 `learning_json` 列；已有观察保留，缺失学习证据保持缺失。[Accounts](../../src/server/accounts.ts)只创建账号/会话表和索引，没有账号库迁移版本。

2026-10-02 的场景卡更新为两张练习表增加可空 `scenario_json`。从之前只允许 `detail / comparison` 的已知练习卡表升级时，在单一事务中重建卡片及其来源引用表，保留各 namespace、原 rowid 顺序、版本链、来源及精确请求载荷；回答表增加列。失败回滚并恢复外键检查，原概念观察 / 重温 / 参数记录不因此改写。备份与回退仍按[完整恢复步骤](upgrade-and-recovery.md)执行；新 JSON 内的阶段提示与两项自评需要本轮或更新版本恢复，不用旧程序直接打开迁移后的数据库。

目前没有 `PRAGMA user_version`、迁移登记或全表结构核验，也没有自动降级。启动不会为任意旧列结构或模型记录提供统一拒绝/转换；JSON 导入中的版本校验不能替代数据库兼容检查。因此，不承诺任意旧版本数据库或新版数据库可由旧程序直接打开。

未来涉及表、列、含义、密码格式或模型的改动，须说明起始版本、目标版本、迁移事务与失败行为，使用旧库 fixture 验证记录保留，并提供升级前备份和回退办法。不以“服务能启动”代替旧事件、时间、身份与账号隔离的核对。

## API 与本机客户端

当前路由是 `/api/...`，没有 API 版本协商、软件版本握手或 `/api/v1/...` 稳定接口。早期设计中的版本化路由是提案；实际契约以 [app.ts](../../src/server/app.ts)和 `src/shared` 为准。Web、CLI 与服务端应来自同一软件版本；这是运行约定，不是已实现的版本隔离检查，当前不承诺任意新旧客户端混用。

- 账号模式下要先取得有效身份和 `/api/session`；写请求携带本机 token，并核对来源。用户、namespace、资料版本和概念 ID 的边界不能由客户端过滤替代。
- 学习事件重试保留 event ID、发生/观察时间和 payload；首次保存与完全相同重放有不同回执，换内容可能返回 `EVENT_CONFLICT`。观察、长期保持、配置、导入和身份衔接还各有版本/前序校验，不可重建一个新请求来掩盖冲突。
- 配置使用精确历史 revision 的相邻转换；导入 `importId`、身份 `operationId` 的回执持久化。响应丢失后先原样重试或核对结果，不重置 H、时间或资料版本。
- SSE 仅通知本机当前空间的数据失效，需要重新读取；它不是增量合并或跨设备同步协议。CLI 只通过本机回环 HTTP 工作。

## 浏览器与 CLI 状态

| 状态 | 当前版本/范围 | 升级注意事项 |
| --- | --- | --- |
| 待同步 | `living-memory.pending-writes.v1.<编码后的 sourceId>` | 当前仍沿用 v1 数组；旧页面不参与新锁协议，更新时先同步并关闭旧页面，之后统一刷新 |
| 布局/修正恢复材料 | 独立 `.v1` 本机键 | 不属于服务器 JSON；未知/损坏内容不能默默按空值覆盖 |
| 少量复习续做 | `version: 1`，绑定来源 | 仅复习草稿持久化；应用/场景/修正输入主要在内存中，更新前保存需要保留的内容 |
| CLI review 回执 | `version: 1`，按来源＋事件保存 | 默认固定在仓库 `data/local/cli`，不会随 `LM_DATA_DIR` 改变；`LM_CLI_STATE_DIR` / `--state-dir` 可另设，重试使用冻结请求 |
| CLI 设备会话 | `version: 1`，本机 URL/管理员身份 | 默认跟随 `LM_DATA_DIR/cli-session.json`，`LM_CLI_SESSION_FILE` 可另设；服务重启轮换凭据，不能靠恢复旧 token 保持访问 |

这里的 `version: 1` 标识本机文件格式，不是软件版本。未知待同步条目会保留在原存储数组中，但有效列表和同步会过滤它们；“0 条待同步”不证明原存储无未知条目。出现损坏或存储警告时保留原数据并核查，不以清空浏览器存储处理。

浏览器来源地址、账号与知识根路径变化不会自动迁移这些状态。完整步骤见[升级与恢复](upgrade-and-recovery.md)，现有多页面行为见[待同步说明](../development/pending-sync.md)。

## 每次兼容变化的交付

在 Issue/PR 和更新记录中写清改了什么格式/语义、受影响的旧版本、迁移/回退步骤、实际运行的检查与未覆盖范围。至少保留本人明确重温、冻结回忆证据、手工长期保持及账号隔离；模型变化另需研究依据，不用软件版本号替代模型证据。
