# 清除指定回忆的原回答

更新：2026-10-22。对应 FR-11／LM-006：主动保存的回答片段应能查看与清除。**ACLEAR-01 的纯契约、ACLEAR-02A 的 SQLite 清除内核，以及 ACLEAR-02B1 的完整实例离线迁移与备份往返已实现；删除 API 和界面尚未开放。** 当前产品仍使用学习 schema 2、HTTP 协议 2、学习 JSON v2；显式生成的 schema 3 只是隔离候选，当前服务不能启动它。本轮不升级或操作运行中的私人实例。

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

新类型仅定义在 [answer-clearing.ts](../../src/shared/answer-clearing.ts)，尚不替换现行 `Observation`：

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

## 后续统计适配

目前没有改变任何现行统计。接通时应在自评修订投影之外增加隐私门槛，不把清除伪装成 `withdraw`：

| 读取用途 | 接通后的约定 |
| --- | --- |
| 原发生事实、原评分与修订审计、预算和批次完成数 | 保留，清除不产生补做义务，不重开飞书会话 |
| 依赖原答的当前自评表现、独立成功、信心校准、进步、时间与表现对照 | 排除已清除记录，并显示排除数量；仍应用原有条件，隐私门槛为 true 不能直接认定合格 |
| 当前时间曲线、H、anchor、手工长期保持 | 保持原规则 |
| 自评 `reinstate` | 只恢复评分采用状态，不能恢复正文或原答资格 |
| 重新核对原答的修订理由 | 原答已经不可用时关闭该理由，或要求其他明确依据；不能暗示材料仍在 |

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
| `clear(request)` | 自己持有 `BEGIN IMMEDIATE`，查父观察、准备首次清除、单条 UPDATE 同时清空两副本并保存首次时刻；重复返回原标记且不依赖当前时钟 |
| `assertReplayAllowed(id)` | 要求调用方已在同连接开启事务；已清除时固定拒绝 `ANSWER_CLEARED`，不接收或比较重放正文，不保留哈希作凭证 |

清除失败只回滚本方法成功开始的事务；嵌套调用或竞争锁使 BEGIN 失败时，不提交或回滚外层调用方事务。错误消息仅为固定码，不包含 SQL、原答或底层异常。清除不修改原评分、说明、修订链、anchor、配置及其他行；原事件仍占位。空答或脑中回忆没有已存原文，拒绝为它创建标记。

`assertReplayAllowed` 仅是未来写入方必须在同事务使用的门槛，不负责未清除请求的全文精确重试、跨表事件 ID 冲突或导入合并。**现有产品 Store、HTTP、JSON、统计和客户端尚未接通清除语义，不能声称现有 API 或旧 JSON 导入已经具备防恢复能力。** 现行 v2 schema 检查和产品 Store 继续拒绝 v3；完整实例离线工具在下述 ACLEAR-02B1 中显式支持 v3 备份与候选。禁止把清除对象改成 `answer: ''` 塞回 v2，它会丢失标记。

### ACLEAR-02B1：完整实例离线迁移与备份往返

[迁移模块](../../src/server/answer-clearing-migration.ts)把严格验证的 v2 连接复制到全新的规范 v3 库，不在原库重建表。按已知表白名单逐行复制 rowid 和命名列，以 BigInt 保留 SQLite 整数和原请求字节；列顺序不同的已知 v2 也能保持原值。observations 只增加 `answer_cleared_at: NULL`，schema metadata 是明确例外：改为版本 3／最低读取 3 及本次规范时间。修订链的父观察和前驱外键在同一目标事务中延迟核对。

模块要求不同连接、初始均不在事务内且启用外键；源为已知完整 v2、目标真正为空。源只读快照保持到目标提交，源和目标均核对完整性与外键。提交前失败回滚目标 DDL 和已复制行；目标已经提交后的源事务收尾若失败，目标可能已是完整 v3，但函数仍报固定错误。**调用方在任意错误后都必须丢弃未发布目标**，不能将其当作成功候选。模块不打开／关闭连接，也不自行备份。

[完整实例工具](../../src/server/instance-backup.ts)已经接入此模块。只有 `restore --learning-schema 3` 才迁移候选；v1 先在未发布暂存副本完成既有 v1→v2，再复制到规范 v3。复制成功并关闭连接后，清理暂存旧库的 sidecar 并替换主文件；任一步失败删除整个 stage、不发布目标，源库和归档不变。

bundle 外层继续为 `version: 2`，内部 `learningSchemaVersion` 可为 1、2 或 3，并与真实 schema 严格匹配。schema 3 的完整备份／核验／显式恢复保留首次标记和两个 NULL，不降格为空答；从 v3 归档恢复必须再次显式选 3，默认或要求 2 均返回 `INSTANCE_SCHEMA_TARGET_REQUIRED`。未知版本、伪造声明、legacy 与显式目标并用均拒绝。默认 v1／v2 恢复仍输出 v2，不自动升级现有实例。

新目录仍生成新实例身份、撤销旧会话并隔离连接器。v3 报告和 CLI 仅额外标注 `learningSchemaCandidate: { schemaVersion: 3, runtimeReady: false }`，不暗示可启动；当前 `activate-connectors` 对 v3 返回 `INSTANCE_RUNTIME_UNSUPPORTED` 并保留隔离。[操作说明](../development/instance-migration.md#学习结构-v3-的隔离候选)包含明确命令与边界。本轮只在合成目录验证，未给私人实例生成或启用 v3 候选。

下一阶段 ACLEAR-02B2 处理学习 JSON v3、导入预览与合并，包含旧原文不得覆盖清除标记、外部清除标记不能代替本机确认。随后接通产品 Store 的读取与统计隐私门槛、排除计数和协议 v3；这些启用条件齐备后再开放 API／Web。当前 v2 私人实例与已有启动候选不变。

## ACLEAR-03：界面与可控副本

入口位于当前账号的已保存观察历史，一次明确确认列出 answer 与机械副本范围，说明其他场景和记录保留。示例／预测、未保存观察和作答期间不提供此入口。删除请求不带正文、不自动加入离线队列；失败或超时显示结果未知，按同一父观察查询状态，不能乐观声称已清除。

增加独立隐私水位，纳入历史、修订历史、分页和缓存版本。现有 history loader 的“事件不可变、保留旧 entries”分支必须失效；SSE 仅提示重读，不保证离线页面已收到。迟到 HTTP、跨标签页旧内存和加载更多不能把原文填回界面；认证、来源或实例变化时旧请求丢弃。

服务器确认清除后，清理当前可控同 scope／event 的原观察待同步和 brief-review checkpoint，包括 `answer` 和 `submittedPayload`；也应处理已打开修订窗口及资料草稿中由该操作直接持有的副本。跨页面协调失败须明确提示，不能为了方便清空整个来源的其他待同步。其他离线设备无法远程擦除，服务端持续拒绝旧正文重放。

## 开发顺序与验收门槛

| 阶段 | 本轮状态／完成门槛 |
| --- | --- |
| ACLEAR-01 设计、纯契约与投影 | 已实现；由独立 SQLite 内核及合成测试使用，尚未接通产品运行链 |
| ACLEAR-02A SQLite 内核 | 已实现：完整独立 schema 3、双副本原子清除、首次标记、跨 namespace、竞争／回滚及要求事务的重放 guard；现产品未接入 |
| ACLEAR-02B1 完整实例迁移 | 已实现：显式离线 v1／v2 到新目录 v3 候选，bundle 内层版本、清除后完整往返及失败 stage 清理；当前服务仍不支持候选启动 |
| ACLEAR-02B2 JSON 与合并兼容 | 待开发：学习 JSON v3、导入预览／快照／事务合并，既有清除阻断旧原文，导入清除需本机确认 |
| ACLEAR-02C 产品存储与协议 | 待开发：现有 Store 的所有读取／写入／全局占位检查、统计隐私门槛与排除计数、HTTP 协议 3 及客户端握手 |
| ACLEAR-03 API／Web 与缓存 | 待开发：权限、明确确认、结果未知恢复、水位、迟到响应、跨页队列与 checkpoint |
| ACLEAR-04 集成与交付 | 待开发：非空 JSON／bundle 往返、跨页／多标签、已有修订链与飞书计数、远端浏览器回归；私人升级和真实删除单独安排 |

ACLEAR-01 的[合成测试](../../tests/answer-clearing.test.ts)覆盖严格解析、不泄露原答／哈希、原字段保留、深拷贝、首次与重复清除、错误父目标／时间／状态、空答与脑中回忆，以及隐私门槛。测试中的序列化往返只证明纯对象语义，不等于已实现学习 JSON 导入、API 历史时间查询或旧队列防恢复。本轮未调用真实清除接口、修改私人数据、重启服务或执行本机浏览器。

ACLEAR-02A 的 [schema 验证](../../tests/answer-clearing-schema.test.ts)与 [SQLite 清除测试](../../tests/answer-clearing-store.test.ts)使用临时合成库，核对真实持久化、首次事实、失败回滚、事务所有权、namespace 隔离与版本拒绝；并发和重开连接的证据不等于真人已确认删除或私人实例已迁移。完整集成与个人数据操作仍按后续阶段分别验收。

ACLEAR-02B1 的[迁移测试](../../tests/answer-clearing-migration.test.ts)核对命名列、历史列顺序、原 rowid／整数／请求字节、外键、失败回滚及提交收尾边界；[完整往返测试](../../tests/answer-clearing-bundle.test.ts)核对非空多用户修订链、真实旧 fixture、显式候选清除后的完整备份恢复、身份与会话隔离。它们不证明当前 JSON 导入已经阻断原文恢复，也不表示软件已经可以作为 v3 私人服务运行。

完整逻辑清除只保证当前应用记录及之后的受控导出；SQLite WAL、释放页、系统快照、旧归档和外部副本不是本功能已擦除的对象。软件正确性与记忆收益分别验收。
