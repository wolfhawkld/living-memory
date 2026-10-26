# 清除指定回忆的原回答

更新：2026-10-26。对应 FR-11／LM-006：主动保存的回答片段应能查看与清除。**ACLEAR-02C4B2 已接通显式 v3 启动、配套网页构建检查及恢复／激活／重接配置；默认仍为 v2，清除 HTTP 接口和操作界面尚未开放。** v3 必须显式选择并使用已有完整数据库，不自动迁移现有实例。新恢复报告的 `runtimeReady: true` 仅表示软件具备显式运行能力，不等于已启动、已核验网页或已解除连接器隔离；历史 false 报告不改写。私人实例和实际服务未操作。

本项只处理一条已保存概念解释或场景调用 `Observation` 的 `answer`，包括数据库原字段、请求载荷中的机械副本以及当前可控的同条浏览器副本。它与[自评更正、暂不采用和恢复采用](observation-revisions.md)分开；清除原答不等于把当时的回答改成空白、不等于脑中回忆，也不撤销练习发生的事实。

## 清除范围

| 内容 | 完整接通后的处理 |
| --- | --- |
| 指定 `answer` 及其 `request_payload` 中的副本 | 在同一事务清除；不保存原文、摘要或正文哈希充当重放凭证 |
| 首次清除标记与父观察身份 | 保留，同命名空间内不可被旧请求或导入覆盖；没有恢复原答动作 |
| 原评分、后续评分修订、提示／曝光、信心和时间 | 保留原值，历史标明原答已清除 |
| 原场景题面、`applicability` 核对说明、修订 note | 本操作不清除；确认界面须明确范围，不能把“原答”说成整条文字记录 |
| 应用／总结、练习卡及作答、已复制的 KG 材料 | 独立记录，不连带删除，也不做相似文字搜索替换 |
| 旧下载、离线备份、其他设备已保存或已显示的内容 | 不承诺远程清除；当前应用的逻辑删除不叫物理安全擦除 |

长期保持、H、重温起点和曲线不变；一次已提交练习仍计入预算和批次完成数。飞书脑中自报本来没有书面原答，不为它凭空创建清除标记。清空全部学习数据、清除场景／应用文本和私人练习卡不包含在本子项中，FR-11／LM-006 也不因此整体完成。

## ACLEAR-01 的独立契约

清除类型定义在 [answer-clearing.ts](../../src/shared/answer-clearing.ts)。原 `Observation` 保持字符串原答，显式 v3 Store、历史及修订读取使用 `PrivacyObservation`；默认 v2 类型和运行行为保持：

```ts
interface AnswerClearingRequest { observationEventId: string }
interface AnswerClearingMarker { observationEventId: string; clearedAt: string }
interface AnswerClearingReceipt extends AnswerClearingMarker {
  status: 'accepted' | 'duplicate';
}
type ClearedObservation = Omit<Observation, 'answer'> & {
  answer: null;
  answerClearing: AnswerClearingMarker;
};
type PrivacyObservation = Observation | ClearedObservation;
```

请求不带正文、摘要、哈希、自由备注、评分或客户端归属。父观察 ID 是幂等边界，不新造可重用的学习 eventId。后续服务层从认证、来源和实例上下文确定命名空间，查询同空间的父观察；旧版本或已移除概念的已存观察仍可定位，不要求当前 KG 正文存在。

三个解析器严格接受普通数据对象或 null prototype 对象，拒绝未知字段、符号键、非枚举字段、访问器和 class 实例。ID 采用现有 1–128 位 ASCII 规则并去除首尾空格；带时区的有效时间规范化为 UTC。返回值为新建冻结对象，错误只包含固定码，不回显输入。

`null + answerClearing` 明确表达原答被移除；原始 `''` 继续表达当时没有保存文本。不能使用字符串“已删除”替代原文，也不能把已清除观察的 `evidenceMode` 改成 `mental`。新联合类型不能直接传给要求 `answer: string` 的现行统计或持久化接口。

## 纯规划与隐私投影

[纯模块](../../src/core/answer-clearing.ts)不读数据库、文件、环境或系统时钟，也不导入 Store、HTTP、SDK 或现有运行入口：

| 函数 | 行为 |
| --- | --- |
| `planAnswerClearing(observation, request, clearedAt)` | 非空原答返回 `answer: null`、首次标记及 accepted 回执；已清除则返回原标记和 duplicate |
| `applyAnswerClearing(observation, marker)` | 应用明确标记；已清除状态只接受与首次标记相同的 ID 和时刻，拒绝改写清除时间 |
| `isAnswerCleared(observation)` | 验证状态一致后判断是否已清除；非法状态抛固定错误，不退回“原答仍完整” |
| `isAnswerPrivacyEligible(observation)` | 仅回答隐私状态是否允许采用；已清除为 false，合法未清除为 true，不代表满足评分／独立性／校准条件 |

首次清除时刻由未来服务层提供，不能早于原 `recordedAt`。重复规划仍校验新时间的格式，但不把重试时刻写成新的事实，保留首次标记。纯空白字符串也有实际保存的字符，允许清除；原本 `''` 或合法 `mental` 没有可清内容，返回 `NO_SAVED_ANSWER`。`mental` 带文字本身是非法原观察。

输出按现有 Observation 和 LearningEvidence 字段逐项选择、复制并冻结，不携带输入对象上的 SQL `request_payload`、任意扩展或哈希。非目标字段保留，不把后来的理解改写回当时条件。原输入及嵌套 learning 不变。标记、回执不保存原文；其他保留的场景和说明仍可能含本人写入的文字，因此不承诺输出完全没有私人文本。

隐私清除是当前不可逆状态，函数没有 `asOf` 参数，也不返回清除前原答。后续任何历史投影都须先应用当前清除状态，不能因为查询过去日期而再次回显原文或绕过隐私排除。

固定错误包括 `INVALID_REQUEST`、`INVALID_MARKER`、`INVALID_RECEIPT`、`INVALID_OBSERVATION`、`TARGET_MISMATCH`、`INVALID_CLEARED_AT`、`NO_SAVED_ANSWER`、`INCONSISTENT_CLEARING`。外部请求／标记指错父观察为 `TARGET_MISMATCH`；已经清除的对象内部标记指错父观察、缺标记、仍带字符串原答或企图替换首次标记，属于不一致状态。

## 统计适配与默认运行边界

ACLEAR-02C3 已为显式 v3 Store 接入独立隐私门槛：先计算完整自评修订投影，再过滤当前已清除原答；不把清除伪装成 `withdraw`。默认 v2 服务继续使用原统计链，四套既有表现算法复用而不复制：

| 读取用途 | 接通后的约定 |
| --- | --- |
| 原发生事实、原评分与修订审计、预算和批次完成数 | 保留，清除不产生补做义务，不重开飞书会话 |
| 依赖原答的当前自评表现、独立成功、信心校准、进步、时间与表现对照 | 排除已清除记录，并显示排除数量；仍应用原有条件，隐私门槛为 true 不能直接认定合格 |
| 当前时间曲线、H、anchor、手工长期保持 | 保持原规则 |
| 自评 `reinstate` | 只恢复评分采用状态，不能恢复正文或原答资格 |
| 重新核对原答的修订理由 | 已清除时拒绝新的 `rechecked-original`；已保存请求的精确重试保留原回执，其他理由仍须满足原有修订条件 |

## ACLEAR-02：持久化、重放与兼容

清除状态以 `(namespace, observationEventId)` 唯一定位。事务内查验父记录、已有首次标记和权限，同时移除 `answer` 与原请求载荷中的机械副本；父观察及清除标记继续占位。竞争清除仅保留一个首次时刻，事务失败不可只删其中一个副本。清除本身不自动生成一份仍含原答的新备份。

清除后收到携带旧原文的 POST／离线队列，固定返回 `ANSWER_CLEARED` 并要求重新读取状态；没有保存原全文或摘要时，不能冒称已精确比较旧载荷并返回原观察 duplicate。同 ID 的其他学习事件也不能占用该父身份。清除规划的 duplicate 与原观察写入的精确重放是不同操作。

需要学习 schema 3／minimum-reader 3、HTTP 协议 3、学习 JSON v3 一起表达此状态；bundle 外层是否变版应按其 manifest 契约另审，不能只因内部版本变化就改所有数字。已知 v1／v2 沿用完整离线备份和新目录恢复升级，服务启动不后台原地迁移。当前 v2 私人实例和已有启动候选继续使用原运行链；真正接通 schema 3 前先保留固定 v2 源码和构建，另准备 v3 迁移候选，不能让常用启动入口意外打开不兼容目录。

新 JSON 导出须携带清除状态，导入预览、快照 token、事务、幂等及完整 bundle 往返均须覆盖它。同命名空间已有标记时，旧原文导入阻断，不由合并策略恢复；导入带清除标记的文件到已有未清除记录，也不能代替本机的明确清除确认。恢复到新空实例且携带新标记时应保留其缺失语义；用户另建空实例恢复旧的未清除备份，没有全局删除账本，不能承诺旧原文永远无法恢复。改用新 eventId 手工另存文本也不等于重放同一记录。

### ACLEAR-02A：独立 SQLite 内核

[schema 模块](../../src/server/answer-clearing-schema.ts)提供显式 `initializeAnswerClearingSchemaV3(db, { recordedAt })` 和只读 `inspectAnswerClearingSchemaV3(db)`。它使用完整的 v2 表与索引基线，只改变 observations 的清除表示及版本标记：`user_version`、schema 和最低读取版本均为 3。初始化只接受空库，要求调用方已开启事务并启用外键；不自行提交、回滚、打开或关闭连接。已知完整 v3 重复初始化只读返回，v1／v2、未知或不完整结构拒绝，不在本阶段迁移旧库。

原 observations 行增加 `answer_cleared_at`，原主键继续作为父身份和首次标记，不另建可复用的删除事件 ID。数据库 CHECK 保证未清除时 `answer` 与 `request_payload` 都为文本且清除时刻为 NULL；已清除时两者同时为 NULL、清除时刻为非 NULL 文本。整个 `request_payload` 都移除，而非解析后只删某个 answer 键，避免保留其中未经验证的机械副本。时间合法性、UTC 规范形式、首次时刻不早于 recordedAt 等规则由检查器与纯模块严格验证。

[存储内核](../../src/server/answer-clearing-store.ts)接收调用方已有的 `{ db, namespace, now? }`，构造器核对完整 v3 结构及外键，不创建 schema。它只直接读取同连接、同命名空间的原行，不接收可能指向其他数据库的父观察回调：

| 方法 | 本阶段实际行为 |
| --- | --- |
| `readObservation(id)` | 单次 SQL 一致读取原答与标记；逐字段校验、复制和冻结，返回 `PrivacyObservation` 或不存在，不输出 request_payload；没有历史时间回显分支 |
| `clear(request)` | 自己持有 `BEGIN IMMEDIATE`，清空两副本并保存首次时刻；02C1 起还原子退休同 namespace 的两类重放凭证，重复清除也修复遗留凭证，保留原标记且不读当前时钟 |
| `assertReplayAllowed(id)` | 要求调用方已在同连接开启事务；已清除时固定拒绝 `ANSWER_CLEARED`，不接收或比较重放正文，不保留哈希作凭证 |

清除失败只回滚本方法成功开始的事务；嵌套调用或竞争锁使 BEGIN 失败时，不提交或回滚外层调用方事务。错误消息仅为固定码，不包含 SQL、原答或底层异常。原评分、说明、修订链、anchor、配置及其他学习事实不改，原事件仍占位；02C1 增加下述两类凭证的定向退休例外。空答或脑中回忆没有已存原文，拒绝为它创建标记。

`assertReplayAllowed` 是写入方必须在同事务使用的门槛，不独自负责未清除请求的全文精确重试、跨表事件 ID 冲突或导入合并。ACLEAR-02A 交付时 Store、HTTP、JSON、统计和客户端均未接通；后续 C2B／C3 已接通显式 v3 Store 及其 JSON 导入与统计，**默认 v2 服务及现有 HTTP 客户端仍未开放清除语义**。默认 schema 检查和 Store 继续拒绝 v3；完整实例离线工具在下述 ACLEAR-02B1 中显式支持 v3 备份与候选。禁止把清除对象改成 `answer: ''` 塞回 v2，它会丢失标记。

### ACLEAR-02B1：完整实例离线迁移与备份往返

[迁移模块](../../src/server/answer-clearing-migration.ts)把严格验证的 v2 连接复制到全新的规范 v3 库，不在原库重建表。按已知表白名单逐行复制 rowid 和命名列，以 BigInt 保留 SQLite 整数和原请求字节；列顺序不同的已知 v2 也能保持原值。observations 只增加 `answer_cleared_at: NULL`，schema metadata 是明确例外：改为版本 3／最低读取 3 及本次规范时间。修订链的父观察和前驱外键在同一目标事务中延迟核对。

模块要求不同连接、初始均不在事务内且启用外键；源为已知完整 v2、目标真正为空。源只读快照保持到目标提交，源和目标均核对完整性与外键。提交前失败回滚目标 DDL 和已复制行；目标已经提交后的源事务收尾若失败，目标可能已是完整 v3，但函数仍报固定错误。**调用方在任意错误后都必须丢弃未发布目标**，不能将其当作成功候选。模块不打开／关闭连接，也不自行备份。

[完整实例工具](../../src/server/instance-backup.ts)已经接入此模块。只有 `restore --learning-schema 3` 才迁移候选；v1 先在未发布暂存副本完成既有 v1→v2，再复制到规范 v3。复制成功并关闭连接后，清理暂存旧库的 sidecar 并替换主文件；任一步失败删除整个 stage、不发布目标，源库和归档不变。

bundle 外层继续为 `version: 2`，内部 `learningSchemaVersion` 可为 1、2 或 3，并与真实 schema 严格匹配。schema 3 的完整备份／核验／显式恢复保留首次标记和两个 NULL，不降格为空答；从 v3 归档恢复必须再次显式选 3，默认或要求 2 均返回 `INSTANCE_SCHEMA_TARGET_REQUIRED`。未知版本、伪造声明、legacy 与显式目标并用均拒绝。默认 v1／v2 恢复仍输出 v2，不自动升级现有实例。

新目录仍生成新实例身份、撤销旧会话并隔离连接器。v3 报告和 CLI 仅额外标注 `learningSchemaCandidate: { schemaVersion: 3, runtimeReady: false }`，不暗示可启动；当前 `activate-connectors` 对 v3 返回 `INSTANCE_RUNTIME_UNSUPPORTED` 并保留隔离。[操作说明](../development/instance-migration.md#学习结构-v3-的隔离候选)包含明确命令与边界。本轮只在合成目录验证，未给私人实例生成或启用 v3 候选。

### ACLEAR-02B2：独立学习 JSON v3 与纯合并

[独立模块](../../src/server/answer-clearing-import.ts)复用共用导入引擎校验事件、身份映射、配置、修订链与全局 ID 占位；现行 `ExportData`、v2 导入入口及产品调用保持兼容。它只处理传入快照，不打开数据库、调用 Store 或写入回执：

| 入口 | 行为 |
| --- | --- |
| `parseAnswerClearingExport`／`serializeAnswerClearingExport` | 独立严格校验并往返完整 v3；不依赖实时 KG、不映射身份，也不生成摘要 |
| `buildAnswerClearingImportPlan` | 独立校验当前 v3，再按显式映射预览输入 v1／v2／v3；旧格式不能夹带清除标记 |
| `mergeAnswerClearingImport` | 用新提供的快照重算预览 token，仅在 token 一致且可导入时返回完整 v3；不接收调用方预制计划 |

同一观察身份按以下规则处理；隐私拒绝先于摘要计算，错误只带固定码，不返回旧原答：

| 当前快照 | 输入记录 | 结果 |
| --- | --- | --- |
| 未清除 | 未清除 | 沿用事件身份比较、重复与冲突规则 |
| 已清除 | 未清除，包括原答 `''` | `ANSWER_CLEARED`，不能通过空答或旧文件覆盖标记 |
| 未清除 | 已清除 | `LOCAL_CLEARING_REQUIRED`，先在本机明确清除，导入不能替代确认 |
| 已清除 | 已清除 | 首次标记和非原答事件身份均一致才算重复；标记不同为 `CLEARING_CONFLICT`，保留本地 `recordedAt` 与首次标记 |

空目标可以接收合法的已清除记录。`answer: null` 必须与严格首标记同时出现，标记指向父观察，清除时刻不早于父 `recordedAt`，且不晚于导出时间或本次 `now`；脑中回忆不能成为已清除记录。普通事件沿用原导入时间规则，本轮未统一新增 `exportedAt` 截止限制。当前快照和修订链先独立校验，不能依赖输入补齐损坏链；父观察及其他事件的 ID 继续占位。历史 `rechecked-original` 修订保留当时事实，泛型评分投影保留 `null + marker`，不因此取得当前信心校准资格。

输出按字段白名单重建，不透传未知 SQL 字段、请求副本或 `answerHash` 等扩展。完整合并保留当前原始事件、评分、修订链及各自 `recordedAt`，只追加新事件，覆盖 anchors、observations、revisions、长期保持、应用、关系更正与核对、练习卡及作答等集合；不把有效投影写回原始记录。配置历史只追加新版本，布局与复习计划采用预览结果；概念元数据保留本地与必要映射信息，并采用已确认的实时身份。

`restoreMetadata` 使用本地 sourceId，保留既有 anchor 请求中省略 `occurredAt` 的语义和配置接收时间，仅补新 anchor／配置的元数据。当前 `identityBindings` 只作为审计保留，外部绑定不替代本机身份确认。合并保留本地 source，导出时间设为本次 `now`，再校验完整结果；重复合并不保证整份文件字节相同。

token 覆盖标记、当前修订和事件占位、映射、概念、选项及来源等输入；合法无序集合排序后比较，配置历史仍须连续有序。它只检查调用方新提供的快照，**不保证数据库并发隔离、事务提交或持久幂等**。成功预览的 token 只可临时留在内存，不得保存为可长期核对原答的凭证。原定本阶段的 SQL 事务合并与 receipt 写入移至 ACLEAR-02C。

### ACLEAR-02C 的启用门槛

#### ACLEAR-02C1：已有凭证退休与事务内 guard

`import_receipts.request_hash` 摘要覆盖完整导入请求，`Store.identityToken`／`identity_bindings.request_hash` 还可能从全导出或预览 token 派生，因此含原答的摘要不能作为清除后的精确重放凭证。02C1 在独立 v3 内核中将同 namespace 的这两列统一替换为固定非哈希哨兵 `answer-clearing:credential-retired:v1`；哨兵不编码正文或原摘要。缺少可信依赖索引时保守退休整个 namespace，不推测哪些操作一定未受影响。

首次清除在同一事务中更新 answer、request_payload、首次标记及两表凭证，任一表失败均整体回滚。对已有标记的重复清除也执行退休，用于修复旧标记与旧摘要并存的状态；不读时钟、不改首次事实。操作 ID、占位、身份绑定、`receipt_json`、backupId、原时间及所有学习事实保留。现有代码规范生成的 receipt 不含原答或 token；本轮不搜索或清理任意手改 `receipt_json` 中的私人字段，也不擦除旧备份、WAL 或外部副本。

| 方法 | 行为 |
| --- | --- |
| `getReplayPrivacyStatus()` | 单条 SQL 快照返回 `ready`／`repair-required`、已清除观察数、两类凭证各自 active／retired 数量及独立 `safeImportCredentials`／`safeIdentityCredentials`；只读，不返回摘要或正文 |
| `prepareReplayPrivacy()` | 自持事务，仅当存在清除标记时退休同 namespace 的遗留凭证；返回本次退休计数，无标记不改凭证，可重复，不读取时钟 |
| `assertOperationReplayAllowed(kind, id)` | 要求调用方事务，先检查准备状态，未准备抛 409 `ANSWER_CLEARING_REPLAY_PREPARATION_REQUIRED`；再检查指定操作哨兵，已退休抛 409 `ANSWER_CLEARING_OPERATION_RETIRED`；不接收 hash／正文，也不比较 duplicate |

存在清除标记且仍有 active 凭证时为 `repair-required`；没有清除标记时不因正常 active 凭证要求退休。C2B 的固定安全导入标记与 C3 的固定安全身份标记分别计数，不算可能含原答的 active 摘要。本机首次／重复清除与显式遗留修复仍保守退休同空间全部操作，包括两类安全回执；导入此前不存在的清除标记时只退休遗留不安全凭证。这里的 `ready` 仅指这两类凭证的准备状态，**不是产品 `runtimeReady`**。写入方须先取得 `BEGIN IMMEDIATE` 再调用 guard；`isTransaction` 只判断有无事务，不能辨别锁模式。schema DDL、迁移、私人实例和启动候选不变。

#### ACLEAR-02C2A：现行 v2 导入 SQL 共用仓库

[LearningImportRepository](../../src/server/learning-import-repository.ts)承接原 Store 的全部导入 SQL，包括两项练习导入；`Store.commitImport` 已实际委托此实现，原 writer 主体移除。九类事件的 `findEvent` 占位查询及少量 writer 前置／链尾查询也共用同一实现，Store 只作薄委托；两个公开练习导入方法继续保留，但写入要求调用方事务。此阶段复用现产品 v2 路径，不是另外复制一套未来导入器。

此阶段默认仓库只读核验已经初始化的 `current-v2`，拒绝空库、legacy 或 schema 3；C2B 随后增加显式版本 3 分支。仓库不创建 schema、namespace、连接或事务。`applyPreparedImport` 要求已有调用方事务，缺少时抛 503 `IMPORT_TRANSACTION_REQUIRED`；计划必须匹配版本和 namespace、允许导入；默认 v2 仍要求字符串原答且没有清除标记。调用方须先取得 `BEGIN IMMEDIATE` 并在锁内重新规划；仓库不验证预览 token，也不负责备份、receipt、提交或回滚。

[共用纯编解码](../../src/server/store-codecs.ts)保留 v2 规范载荷、日期与练习读取容错；[独立 StoreError](../../src/server/store-error.ts)由原 Store 路径重新导出，既有错误类身份不变。C2A 交付时主读取、`readSnapshot`、统计、协议和 JSON 格式均未改，产品仍运行 v2，v3 候选仍为 `runtimeReady: false`；私人实例、服务和启动候选未操作。

#### ACLEAR-02C2B：v3 事务导入与安全重试

[共用快照仓库](../../src/server/learning-snapshot-repository.ts)从同一连接的 SAVEPOINT 中读取九类学习事件、配置、概念元数据、身份绑定审计、原重温请求、布局和复习安排。现行 Store 已实际委托，原 assembler 和叶子查询移除；v2 的排序、元数据优先级、可选旧记录容错及省略时间语义保持。v3 必须显式选择，原答与请求副本的两个 NULL、首次标记和占位完整保留；不创建连接、namespace 或迁移。

[事务协调器](../../src/server/answer-clearing-import-coordinator.ts)只接受已初始化的 v3 连接。预览和提交均使用当前完整快照及本地身份路径；提交取得 `BEGIN IMMEDIATE` 后先检查操作隐私状态，再重新规划、确认 token、调用备份、应用共用 SQL 并保存回执。上传的绑定仍只是审计资料，不能授权身份映射。它不构造第二个 Store，不接通产品服务或 API。

[安全回执契约](../../src/server/answer-clearing-replay-contract.ts)把 `request_hash` 写为固定格式标记 `answer-clearing:safe-import-replay:v1`，不是摘要。`receipt_json` 是严格白名单 envelope：原回执加 namespace、选项、输入导出时间、映射概念、配置、输入布局／安排、恢复元数据，以及全部九类输入事件的类型／ID／记录时间清单。包含首次导入时已存在的重复事件；不保存任何事件正文、原答、preview token、请求副本、上传绑定或来源诊断。

| 情形 | 行为 |
| --- | --- |
| 首次操作 | 锁内核对新鲜 token，先取得备份标识，再原子写入学习记录和回执；外部备份文件不随 SQLite 回滚 |
| 安全操作重试 | 先 guard，再用当前行重新规划；全部输入事件与配置必须已存在且匹配，非正文描述也一致，返回原回执；不再次备份或写入 |
| 仅 preview token 不同 | 首次提交拒绝；已经成功且语义相同的重试不再比较过期 token |
| 同 ID 改原答／正文／事件集／记录时间／选项或元数据 | 拒绝，不覆盖已有操作；图谱映射变化也可保守拒绝，需重新预览并用新 ID |
| 旧摘要操作／已退休操作 | 分别返回固定 `IMPORT_LEGACY_OPERATION`／`ANSWER_CLEARING_OPERATION_RETIRED`，不读取原摘要进行重算 |

事件正文的重试核对直接使用仍存在的原始行；不另存正文的可验证摘要。共用 writer 在任何写入和 duplicate 快捷分支前检查全部观察，旧原文不能覆盖清除标记，外部标记不能代替本机清除；同为已清除必须保留首次标记和原领域身份。导入此前不存在的已清除观察时，在同一事务中退休本空间的遗留不安全凭证，再写记录和新的安全回执；已有安全回执保留。已有标记与遗留摘要并存时，先拒绝导入，需显式 `prepareReplayPrivacy()` 修复。任一后续写入失败都回滚本次退休、学习记录和回执。

C2B 交付时尚未接通其他 Store v3 读写与统计；下述 C3 已接续这些内部路径。下一轮评审产品 v3 协议与启动接线，之后开放清除 HTTP 接口／Web。当前私人实例与启动候选不变，不将完整 FR-11／LM-006 标为完成。

#### ACLEAR-02C3：显式 v3 Store 与统计闭环

[Store](../../src/server/store.ts)使用同一实现支持默认 `Store<2>` 和显式 `Store<3>`。显式版本 3 只接受已存在、结构完整且目标 namespace／配置已经初始化的数据库；缺路径、空库、版本 2、未知结构或缺少目标行均拒绝，不创建目录、namespace、schema 或配置，也不执行隐式迁移。默认构造器、服务启动门禁、HTTP 协议常量、客户端握手和离线候选的 `runtimeReady: false` 保持原边界，内部可读写不等于可以启动 v3 产品服务。

v3 普通事件写入在自身成功取得 `BEGIN IMMEDIATE` 后核对全局占位和精确重试；已清除观察的 NULL 载荷仍占用原事件 ID。原观察重放先检查清除状态，再比较 duplicate 或核对 anchor／时钟，固定拒绝 `ANSWER_CLEARED`，不能把 NULL 当作无记录或空字符串。其他事件类型不能复用它的身份。所有写入失败只回滚自身成功开始的事务，嵌套 BEGIN 失败保留调用方事务。

内部 `clearObservationAnswer` 薄委托原清除内核，只供显式 v3 Store 使用；本轮没有 HTTP 路由或页面按钮。原答和请求副本保持同事务清除，保留首次标记、原评分、原修订、冻结时间条件、H、anchor、长期保持及原消耗事实，不生成一份仍含原答的清除前备份。历史、修订历史和学习 JSON v3 导出保留 `answer: null` 与首次标记；查询早于清除时刻的 `asOf` 也不会恢复原答。`observationAssessmentVersion` 纳入清除标记，修订历史的 v3 专用游标版本 2 带清除水位，水位变化要求重新读取；默认 v2 游标格式保持。原答已经清除后，新 `rechecked-original` 修订拒绝，旧精确请求仍可取得历史回执。

[共用表现投影](../../src/core/observation-performance.ts)先对完整授权空间的 raw 观察及修订做原有投影，再按当前隐私状态提供 `Observation[]` 给概念／场景汇总、信心校准、进步与时间表现对照。`getEffectiveObservations` 使用相同门槛；raw 历史、计数、身份占位、预算完成数和记忆曲线仍沿原事实读取。`reinstate` 可以恢复评分采用状态，但不能恢复原答或表现资格。按概念选择时只依据不可变父观察所属概念过滤完整投影，损坏修订声称的其他概念不能让原评分复活。

[隐私计数](../../src/shared/observation-privacy.ts)与原评分采用计数分开：`cleared` 统计 `asOf` 时已发生且已记录的 raw 已清除观察，包含 withdrawn／unresolved；`excludedFromPerformance` 统计修订 active 集合中被当前隐私门槛排除的数量。它们不声明记录满足下游独立性或校准条件。overview 顶层覆盖完整 namespace，各 item 与概念 history 覆盖该概念全部资料版本；默认 v2 不输出这些新字段。原 `observationAssessments.effective` 仍表示评分采用状态，不静默改成隐私过滤后的数。

v3 身份绑定使用[严格安全回执](../../src/server/answer-clearing-identity-replay-contract.ts)：`request_hash` 为固定格式标记 `answer-clearing:safe-identity-replay:v1`，envelope 仅含版本、namespace、operationId、from／to 概念 ID 与原回执，不保存 preview token、原答、全导出或派生摘要。锁内先 guard，再读取已有操作；旧摘要操作固定拒绝 `IDENTITY_LEGACY_OPERATION`，已退休操作在解析 receipt 前拒绝。首次提交仍核对新鲜 token；已成功操作只比较规范化 from／to 并逐项核对不可变绑定与回执，同语义的新 token 可返回原 duplicate，改用其他 from／to 则冲突，不重新运行首提后已变化的预览条件。

显式 v3 Store 的 JSON 导入直接委托 C2B 的[事务协调器](../../src/server/answer-clearing-import-coordinator.ts)，导出使用同一[快照仓库](../../src/server/learning-snapshot-repository.ts)，不再复制一套 writer。导入前回调收到真实 v3 备份，清除后旧文件和旧回执的拒绝顺序保留；外部备份文件仍不随 SQLite 回滚。私人实例、已有候选和运行服务未操作。

#### ACLEAR-02C4A：双版本客户端与隐私读取兼容准备

新 Web／CLI 显式接受会话声明的数字协议 2 或 3。未完成握手的受保护请求和 SSE 不连接，JSON、Blob、账号管理与 SSE 使用实际确认版本；bootstrap／认证不自称默认版本。缺失、字符串、数组或未知版本拒绝，426 不续会话或重放写入。Web 将协议纳入 scope generation，并固定 token 首次确认的版本；同一来源／实例的协议变化使旧请求失效，401 恢复不能跨版本重发。成功或错误正文解析后的身份复核阻止迟到响应影响新空间。

[隐私响应验证](../../src/web/privacy-response.ts)以确认协议为输入，复用已有核心观察校验。协议 2 不接收 null 或任何 `answerClearing` 属性；协议 3 保留并核验完整 null／首次标记、父事件、清除时间与证据方式，不把 null 转为空答。新版概念历史必须带有效评分／隐私水位和范围计数。导入仍原样提交 unknown JSON，导出仍下载 Blob；不增加另一套浏览器导入规则。现行 v1／v2 导入显式拒绝夹带清除标记的观察，避免静默丢弃隐私状态。

历史与修订窗口区分“原答已清除”和原本空白。历史水位变化丢弃旧分页；同一 loader 已见的首次标记不能被后续响应撤回或改写。新版读取失败隐藏旧原答，修订窗口使用新读到的父观察，新 `rechecked-original` 决定禁用；原有精确待同步请求仍可原样重试。概念和全库分别显示对应范围的隐私计数，原评分采用计数和记忆曲线含义不变。本轮只有只读提示，没有清除按钮或本机副本清理。

实际服务门禁仍精确要求协议 2；Store 默认、运行入口、恢复候选 `runtimeReady: false` 与连接器隔离保持。客户端能力通过合成 v3 HTTP 响应和隔离测试验证，不是私人实例已经升级。本轮完整 1647 项 Node／HTTP 回归通过（失败、取消、跳过均为 0），含类型检查的独立构建、8 项主题与 261 个相关文档链接／锚点检查通过；提交 `f4a597e28d05cb11d5cf1634c06e9c4c795685be` 已推送 develop；[CI 39925499250](https://github.com/wolfhawkld/living-memory/actions/runs/39925499250) 第二次运行全部通过：1647 项 Node／HTTP（失败、取消、跳过均为 0）、含类型检查的构建、8 项主题与 33 项远端浏览器检查。浏览器约 9.0 分钟，33 条唯一进度，无用例重试或 flaky；最终架构交付审查通过。首次运行因依赖下载耗时 9 分 10 秒挤占作业时限而中断，保持代码与工作流不变，仅重跑一次。

#### ACLEAR-02C4B1：显式 App 与多用户内部接线

[App](../../src/server/app.ts) 仅通过数字参数 `learningSchemaVersion: 3` 开启新版；省略参数仍为 2，null、字符串和未知版本拒绝，不从数据库或环境变量推断。v3 在来源、实例及账号准备之前执行只读结构门禁，缺库、空库、旧库和损坏结构都不创建或迁移。会话、受保护 JSON 与 SSE 使用该 App 精确选择的协议；旧协议的受保护请求在成员目录或知识空间初始化前拒绝。授权会话握手沿用协议豁免，可准备成员空间并返回该 App 的协议。

[知识空间初始化](../../src/server/learning-namespace-v3.ts)在已存在的完整 v3 库中，以自有连接和事务创建全新的 namespace 与首条配置，沿用共享默认 H=7。已有 namespace 必须具有有效历史配置，保留不连续 revision、原时间字节和 H，不读取当前时钟；孤立数据和损坏配置拒绝，不自动修补。两进程同时准备同一空间只产生一对初始记录；Store v3 构造器仍要求目标空间事先准备完成。

已有成员在首次授权会话握手或合法协议的受保护读取时准备私有空间，新账号通过 [Accounts](../../src/server/accounts.ts) 的同步提交前回调完成准备。回调只接收冻结的公开账号字段；准备失败回滚账号，晚 COMMIT 失败也关闭未发布的 Store，成功提交后才缓存新上下文。账号库与学习库是两份数据库，**不保证跨库原子回滚**：失败可能留下空目录及无授权 namespace／配置，保留它们，不误删可能已有的学习记录；失败账号不能登录或取得这些空间。

已存在 observation ID 的 HTTP 重试先进入 Store 的隐私／占位检查；原答已清除时，时钟回退、知识文件移动或删除都不能绕过 `ANSWER_CLEARED`。新事件仍核对当前知识来源与时间。历史、修订、导出和真实写前备份保留 null 与首次标记，隐私错误映射为固定状态／错误码，不返回底层 SQL 或原答。身份绑定和导入沿用既有事务与备份接口。

飞书通过窄接口复用同一 Store 的计划、预算、观察与复习能力；脑中回忆的空答仍是原有语义。`ANSWER_CLEARED` 成为不可继续提交的冲突，待写恢复及学习写入成功后的回执补交仍可精确重试。验证使用隔离合成账号和内部处理器，不发送真实消息。

B1 交付时只开放编程 App，不修改 `server/index.ts`、`npm start`、`npm run instance`、运行 profile／env、恢复报告、activate／reconnect 或静态构建部署；`runtimeReady: false` 保持。实际服务和私人数据仍为 v2，没有清除 HTTP 路由或按钮。

#### ACLEAR-02C4B2：运行入口与恢复契约

[原始入口](../../src/server/index.ts)通过[严格版本解析](../../src/server/learning-runtime-version.ts)仅接受未设置（2）、精确字符串 `2`／`3`；空串、带空白、其他值拒绝，不从库推断。[私有 profile](../../src/server/instance-runtime.ts)的可选数字 `learningSchemaVersion` 只接受 2／3，省略仍为 2；准备环境时明确写入所选值并清除继承设置。显式 3 在租约、来源登记、账号／设备凭据准备和连接器创建之前核对完整已有 v3 与静态构建，默认 App／Store 和默认原始启动仍保留 2。

[生产构建标记](../../src/shared/static-build-compatibility.ts)由 Vite 自动生成，声明支持协议 2／3，记录最终 `index.html` 的 SHA-256；[服务核验](../../src/server/static-build-compatibility.ts)拒绝缺失、损坏、未知／重复协议、非普通文件、符号链接、超限或哈希不匹配。只在显式 3 强制，v2 旧网页保持兼容；dev 不伪造标记。这是构建匹配声明，不是所有资源完整性或供应链签名。profile check 仍不打开数据库、不读取凭据、不探测端口，只多检查显式 v3 的标记并报告所选版本，不能据此宣称数据库就绪。

v3 新恢复报告仍为 v1，额外写 `startup.learningSchemaVersion: 3` 与 candidate `runtimeReady: true`。后者只表示当前软件能力，历史 false 报告不改写；默认恢复仍为 2，v3 归档必须显式选 3，不降级。解除 v3 连接器隔离须再次明确 `--learning-schema 3`；默认／2 拒绝实际 3，明确 3 拒绝非 3，确认、持锁、两次离线扫描和文件身份核对保持。此操作不连接飞书、不修改学习库或恢复报告，默认 legacy／v2 激活兼容保留。

[重接预览](../../src/integrations/source-reconnect-preview.ts)继续只读元数据。无 candidate 的普通报告仅接受空迁移链或 v2，输出环境版本 2；严格 v3 candidate 只接受空链、v3、先 v2 后 v3，新 true 报告必须声明 startup 3，旧 false 可以省略并由当前软件提议 3。矛盾／重复／逆序／未知组合拒绝，预览明确未核验网页，不读取数据库、凭据或改写隔离标记。

改动前已保留 `62101a01f35141405cae485e680fa09c1592017f` 源码归档、对应完整 v2 网页及 lockfile／文件 SHA-256 清单，位于本机忽略目录 `local/runtime-baselines/v2-62101a0/`；168 个文件哈希独立核对通过。仅保存软件材料，不包含私人数据，不覆盖现用 `dist`，未执行真实切换或回退。完整使用与限制见[日常启动](../development/instance-runtime.md#显式启动-v3)和[离线迁移](../development/instance-migration.md#学习结构-v3-的隔离候选)。

实际清除操作及跨页可控副本仍属于下一项 ACLEAR-03。本轮不迁移私人实例、不重启现有服务、不发送真实飞书消息，也不执行本机浏览器验证。

## ACLEAR-03：界面与可控副本

入口位于当前账号的已保存观察历史，一次明确确认列出 answer 与机械副本范围，说明其他场景和记录保留。示例／预测、未保存观察和作答期间不提供此入口。删除请求不带正文、不自动加入离线队列；失败或超时显示结果未知，按同一父观察查询状态，不能乐观声称已清除。

增加独立隐私水位，纳入历史、修订历史、分页和缓存版本。现有 history loader 的“事件不可变、保留旧 entries”分支必须失效；SSE 仅提示重读，不保证离线页面已收到。迟到 HTTP、跨标签页旧内存和加载更多不能把原文填回界面；认证、来源或实例变化时旧请求丢弃。

服务器确认清除后，清理当前可控同 scope／event 的原观察待同步和 brief-review checkpoint，包括 `answer` 和 `submittedPayload`；也应处理已打开修订窗口及资料草稿中由该操作直接持有的副本。跨页面协调失败须明确提示，不能为了方便清空整个来源的其他待同步。其他离线设备无法远程擦除，服务端持续拒绝旧正文重放。

## 开发顺序与验收门槛

下表保留各阶段交付时的范围；当前运行能力以 C4B2 为准，私人实例状态与软件能力分别记录。

| 阶段 | 本轮状态／完成门槛 |
| --- | --- |
| ACLEAR-01 设计、纯契约与投影 | 已实现；由独立 SQLite 内核及合成测试使用，尚未接通产品运行链 |
| ACLEAR-02A SQLite 内核 | 已实现：完整独立 schema 3、双副本原子清除、首次标记、跨 namespace、竞争／回滚及要求事务的重放 guard；现产品未接入 |
| ACLEAR-02B1 完整实例迁移 | 已实现：显式离线 v1／v2 到新目录 v3 候选，bundle 内层版本、清除后完整往返及失败 stage 清理；该阶段只支持离线候选，显式启动由 C4B2 接续 |
| ACLEAR-02B2 JSON 与纯合并 | 已实现独立 v3 解析／序列化、共用预览、重算 token 后的完整 JSON 合并及四向隐私检查；未接产品，SQL 事务与回执移至 02C |
| ACLEAR-02C1 凭证退休与准备 | 已实现独立 v3 内核的原子退休、遗留准备、只读状态与调用方事务 guard；未接产品写入方 |
| ACLEAR-02C2A v2 导入仓库提取 | 已实现：Store 真实委托共用导入 SQL、占位与必要前置查询，要求调用方事务；该阶段提取 v2，C2B 随后扩展显式 v3 |
| ACLEAR-02C2B v3 事务导入 | 已实现显式 v3 快照、同仓库写入、事务协调及安全语义重试；验证证据见阶段记录，产品运行由后续 C3／C4 接续 |
| ACLEAR-02C3 显式 v3 Store 与统计闭环 | 已实现同一 Store 的显式 v3 读写、历史／修订、隐私表现门槛及安全身份重试；默认服务仍为 v2；提交 9992929 的完整本地及远端验证通过，最终架构交付审查通过 |
| ACLEAR-02C4A 客户端兼容准备 | 已实现双版本握手、隐私读取、历史／修订只读展示与动态 SSE；提交 f4a597e 的 1647 项本地及远端回归、构建、8 项主题与 33 项远端浏览器全部通过，最终交付审查通过；该阶段交付时服务仍为 2，显式启动由 B2 接续 |
| ACLEAR-02C4B1 内部运行接线 | 已交付：显式 App v3、多用户初始化、HTTP 与飞书内部链路；62101a0 的 1679 项回归、构建、8 项主题和 33 项远端浏览器通过 |
| ACLEAR-02C4B2 启动与恢复契约 | 已实现显式启动、profile／env、构建匹配和恢复／激活／重接契约；集中验证中；默认 2，私人升级未执行 |
| ACLEAR-03 API／Web 与缓存 | 待开发：权限、明确确认、结果未知恢复、水位、迟到响应、跨页队列与 checkpoint |
| ACLEAR-04 集成与交付 | 待开发：非空 JSON／bundle 往返、跨页／多标签、已有修订链与飞书计数、远端浏览器回归；私人升级和真实删除单独安排 |

ACLEAR-01 的[合成测试](../../tests/answer-clearing.test.ts)覆盖严格解析、不泄露原答／哈希、原字段保留、深拷贝、首次与重复清除、错误父目标／时间／状态、空答与脑中回忆，以及隐私门槛。测试中的序列化往返只证明纯对象语义，不等于已实现学习 JSON 导入、API 历史时间查询或旧队列防恢复。本轮未调用真实清除接口、修改私人数据、重启服务或执行本机浏览器。

ACLEAR-02A 的 [schema 验证](../../tests/answer-clearing-schema.test.ts)与 [SQLite 清除测试](../../tests/answer-clearing-store.test.ts)使用临时合成库，核对真实持久化、首次事实、失败回滚、事务所有权、namespace 隔离与版本拒绝；并发和重开连接的证据不等于真人已确认删除或私人实例已迁移。完整集成与个人数据操作仍按后续阶段分别验收。

ACLEAR-02B1 的[迁移测试](../../tests/answer-clearing-migration.test.ts)核对命名列、历史列顺序、原 rowid／整数／请求字节、外键、失败回滚及提交收尾边界；[完整往返测试](../../tests/answer-clearing-bundle.test.ts)核对非空多用户修订链、真实旧 fixture、显式候选清除后的完整备份恢复、身份与会话隔离。这些离线证据本身不证明 JSON 导入防恢复，也不表示软件已经可以作为 v3 私人服务运行；导入阻断的后续实现与证据分别记录于 C2B／C3。

ACLEAR-02B1 的提交 `4267099`／[CI 39728639421](https://github.com/wolfhawkld/living-memory/actions/runs/39728639421) 已通过 1511 项 Node／HTTP、33 项远端浏览器、8 项主题与构建。ACLEAR-02B2 的[JSON 测试](../../tests/answer-clearing-json.test.ts)及[修订类型测试](../../tests/answer-clearing-revision-types.test.ts)覆盖独立纯模块；最终提交 `1e7d270`／[CI 39734361444](https://github.com/wolfhawkld/living-memory/actions/runs/39734361444) 的 1535 项 Node／HTTP、33 项远端浏览器、8 项主题与构建全部通过。

ACLEAR-02C1 的[凭证测试](../../tests/answer-clearing-replay.test.ts)核对双 namespace、真实原答派生摘要、首次／重复退休、遗留准备、动态状态、固定错误、失败回滚和调用方事务保护；已有清除测试补齐非空凭证的双进程竞争，bundle 测试验证真实旧凭证的迁移与退休后完整往返。提交 `a046000`／[CI 39739507446](https://github.com/wolfhawkld/living-memory/actions/runs/39739507446) 的 1545 项 Node／HTTP、33 项远端浏览器、8 项主题与构建全部通过。

ACLEAR-02C2A 的[仓库测试](../../tests/learning-import-repository.test.ts)新增 8 项定向检查；提交 `df9ada07cd1182bdd08261fdaf30f12a65bcc765` 已推送 develop；[CI 39800046284](https://github.com/wolfhawkld/living-memory/actions/runs/39800046284) 全部通过：1553 项 Node／HTTP（失败、取消、跳过均为 0）、含类型检查的构建、8 项主题与 33 项远端浏览器检查。浏览器约 11.4 分钟，33 条唯一进度，无重试或 flaky；最终架构交付审查通过。本项已完成收尾，C2B 接续实现见上文；私人实例、服务和启动候选未操作。

ACLEAR-02C2B 的[快照测试](../../tests/learning-snapshot-repository.test.ts)、[v3 写入测试](../../tests/learning-import-repository-v3.test.ts)、[回执契约测试](../../tests/answer-clearing-replay-contract.test.ts)与[事务集成测试](../../tests/answer-clearing-import-coordinator.test.ts)使用合成隔离库，验证现行 v2 复用、新版完整 SQL、同连接快照、语义重试、清除保护和失败回滚。本轮完整 Node／HTTP 回归 1586 项全部通过（失败、取消、跳过均为 0），类型检查、独立构建、8 项主题检查及 18 个相关文档链接／锚点检查通过；提交 `a55e78a783895d67e1c9c44066ad50c61a46820a` 已推送 develop；[CI 39808159962](https://github.com/wolfhawkld/living-memory/actions/runs/39808159962) 全部通过：1586 项 Node／HTTP（失败、取消、跳过均为 0）、含类型检查的构建、8 项主题与 33 项远端浏览器检查。浏览器约 9.6 分钟，33 条唯一进度，无重试或 flaky；最终架构交付审查通过。私人升级与实际删除仍未执行。

ACLEAR-02C3 的[表现投影测试](../../tests/observation-performance.test.ts)、[真实 Store 测试](../../tests/store-v3.test.ts)、[Store 导入与身份测试](../../tests/store-v3-import-identity.test.ts)、[身份回执契约测试](../../tests/answer-clearing-identity-replay-contract.test.ts)和[v3 修订账本测试](../../tests/observation-revision-store-v3.test.ts)使用隔离合成库。新增 33 项检查覆盖真实 Store 清除与旧请求的双进程竞争、九类占位与精确重试、14 种写入的事务所有权、隐私统计、修订分页及安全身份回执的多字节兼容边界。本轮完整 Node／HTTP 回归 1619 项全部通过（失败、取消、跳过均为 0），类型检查、独立生产构建、8 项主题检查、230 个相关文档链接／锚点及 diff 检查通过；提交 `99929299b1d0eaf89ca46f4138df36e5c3f2cdd4` 已推送 develop；[CI 39912885874](https://github.com/wolfhawkld/living-memory/actions/runs/39912885874) 全部通过：1619 项 Node／HTTP（失败、取消、跳过均为 0）、含类型检查的构建、8 项主题及 33 项远端浏览器检查。浏览器约 11.4 分钟，33 条唯一进度，无重试或 flaky；最终架构交付审查通过。本轮没有启动产品 v3、升级私人实例、发送真实飞书消息或执行本机浏览器验证。

完整逻辑清除只保证当前应用记录及之后的受控导出；SQLite WAL、释放页、系统快照、旧归档和外部副本不是本功能已擦除的对象。软件正确性与记忆收益分别验收。

ACLEAR-02C4A 的[客户端握手](../../tests/learning-protocol-client.test.ts)、[CLI](../../tests/learning-protocol-cli.test.ts)、[SSE](../../tests/change-sync.test.ts)、[隐私响应与分页](../../tests/privacy-response.test.ts)、[真实 API 包装边界](../../tests/learning-protocol-privacy-api.test.ts)和[旧格式拒绝](../../tests/import-answer-clearing-rejection.test.ts)使用合成数据，不接私人实例。本轮完整 1647 项 Node／HTTP 回归通过（失败、取消、跳过均为 0），含类型检查的独立构建、8 项主题与 261 个相关文档链接／锚点检查通过；提交 `f4a597e28d05cb11d5cf1634c06e9c4c795685be` 已推送 develop；[CI 39925499250](https://github.com/wolfhawkld/living-memory/actions/runs/39925499250) 第二次运行全部通过：1647 项 Node／HTTP（失败、取消、跳过均为 0）、含类型检查的构建、8 项主题与 33 项远端浏览器检查。浏览器约 9.0 分钟，33 条唯一进度，无用例重试或 flaky；最终架构交付审查通过。首次运行因依赖下载耗时 9 分 10 秒挤占作业时限而中断，保持代码与工作流不变，仅重跑一次。未执行本机浏览器视觉验证、启动 v3 服务、迁移私人库或发送真实飞书消息。


ACLEAR-02C4B1 新增 32 项合成测试：[namespace 门禁与竞争](../../tests/learning-namespace-v3.test.ts)、[同步账号准备](../../tests/accounts-provisioning.test.ts)、[真实 v3 HTTP](../../tests/app-v3.test.ts)、[HTTP 多账号与失败资源清理](../../tests/app-v3-accounts.test.ts)、[飞书内部能力与待写恢复](../../tests/feishu-review-v3-capability.test.ts)、[真实 v3 写前备份](../../tests/import-backup-v3.test.ts)。32 项定向测试与完整 1679 项 Node／HTTP 回归通过（失败、取消、跳过均为 0），含类型检查的独立构建及 8 项主题检查通过；最终交付及引用点击收尾证据见下文。该阶段不启动私人 v3 服务、不发送飞书消息、不运行本地浏览器。


C4B1 提交 `094918c133b5adec216ea0878aaadf310ad74f6f` 的 [CI 39935365730](https://github.com/wolfhawkld/living-memory/actions/runs/39935365730) 通过 1679 项 Node／HTTP、构建与 8 项主题；浏览器在第 9 项章节引用用例停止（8 通过、1 失败、24 未运行），不算完成交付。远端 trace 与源码确认既有阅读器滚动更新当前章节时，内联导航回调变化会重建 Markdown 引用按钮，使点击可能丢失。收口修复将导航回调稳定为 `useCallback`，保留身份／版本依赖及原有 pending／epoch 行为；原用例增加滚动前后按钮 DOM 身份不变断言，再执行单次点击和原五种失败提示检查。没有增加 sleep／自动重试、放宽断言或修改超时，也未重跑旧失败 SHA。修复后 25 项相关定向与 1679 项完整 Node／HTTP 回归全部通过（失败、取消、跳过均为 0），含类型检查的独立构建、8 项主题和 252 个本地文档链接／锚点检查通过；最终修复提交 `62101a01f35141405cae485e680fa09c1592017f` 已推送 develop；[CI 39937456266](https://github.com/wolfhawkld/living-memory/actions/runs/39937456266) 首次运行全部通过：1679 项 Node／HTTP（失败、取消、跳过均为 0）、构建、8 项主题及 33 项远端浏览器检查。浏览器约 10.8 分钟，33 条唯一进度，无用例重试或 flaky；原第 9 项引用用例通过，最终架构交付审查通过。此修复交付时未展开 C4B2。


C4B2 验证使用[静态构建](../../tests/static-build-compatibility.test.ts)、[profile 元数据](../../tests/instance-runtime.test.ts)、[既有 CLI](../../tests/instance-runtime-cli.test.ts)、[真实 v3 子进程启动](../../tests/instance-runtime-v3.test.ts)、[完整实例往返](../../tests/answer-clearing-bundle.test.ts)、[备份 CLI](../../tests/instance-backup-cli.test.ts)、[重接预览](../../tests/source-reconnect-preview.test.ts)、[离线扫描](../../tests/instance-backup.test.ts)及[真实旧版兼容](../../tests/instance-backup-compat.test.ts)。定向共 90 项及完整 1697 项 Node／HTTP 回归全部通过（失败、取消、跳过均为 0），含类型检查的独立生产构建、实际标记／入口哈希和 8 项主题检查通过；精确提交远端 CI 待核对。首次新启动夹具漏传 Store 的 anchor 参数，按架构诊断补齐 `null` 后 5 项真实子进程检查通过，未修改产品规则或放宽断言。
