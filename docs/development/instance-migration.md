# 完整实例离线迁移

这条通道用于把同一个 Living Memory 实例搬到新目录或新设备。它保留多用户知识源与学习数据库，与网页中单账号学习 JSON 的导出／导入分开。当前支持的是本仓库已知数据库结构；不承诺兼容全部历史或未来版本。

## 2026-10-21 本机执行记录

已在本人授权下完成本机 Linux／WSL 的真实离线备份、`verify` 和新目录恢复，将已知旧结构的学习库升级到 schema 2；旧目录与升级前归档保留。恢复先撤销旧会话、隔离连接器，随后重新登录并核对数据。此后又对当前 v2 实例完成备份与核验，再接回日常使用的原 progressive-kg。

来源重接通过本机受控流程完成：先停指定服务、持锁修改所有者的物理根登记及两个 managed hook 文件，再以飞书关闭状态启动核对。恢复后的 namespace、实例标识、全部学习表和非会话账号历史保持；同一 `asOf` 的概念、关系及记忆投影一致，认证会话按启动规则轮换。hook 已配置该实例的数据与 CLI 目录，但没有为验收执行真实 KG 生成任务。

之后使用官方 `activate-connectors --confirm-bindings` 显式解除隔离，恢复既有绑定的飞书长连接，最新 SDK 状态为 `connected`。进程与已知管理器检查仅在**当前主机及可见范围内**确认一个消费方，不证明其他设备没有同应用消费者。离线受限句柄检查使用官方只读提权扫描器，应用仍由原账号运行。

这些是本机已知数据的运行证据，不代表 Windows 原生完整迁移、所有历史库、旧程序整套回退或本人记忆收益已验证。下文重接预览仍只读且没有 `--apply`；本次切换没有增加公共自动应用命令。私人路径与运行证据仅留本机；备份和现有凭据保持私有，交接记录不含凭据正文。飞书基础试用和待验学习写回见[实际验收补记](feishu-live-acceptance.md#2026-10-21-实际运行与基础试用补记)。

## 备份范围

恢复完成并核对身份后，可用[已有实例的日常启动入口](instance-runtime.md)保存一份私有运行配置，重复检查和前台启动；它不代替离线迁移或连接器激活，也不会接管当前运行进程。

私有目录 bundle 包含学习 SQLite、启用账号时的账号 SQLite、所有者和成员的知识正文及附件、明确指定的 CLI 收据目录，以及清单、校验信息与知识源身份登记。只有显式传入 `--env-file` 才归档该配置文件；归档内可能含密钥，必须保持私有。目录权限为 700，文件为 600。

`--cli-session-file` 仅保存受控的版本元信息，不备份可继续登录的设备令牌。运行锁、临时文件、旧设备凭据、已有备份以及知识库 Git 历史不作为可恢复凭据打包。未知文件不会假装已经完整迁移：私有 `manifest.json` 的 `excluded` 清单记录未纳入的项目，操作者需要在本机检查；CLI 的公开摘要不会打印这些名字、账号表内容、环境内容或哈希明细。

浏览器本地待同步请求、未提交原回答和草稿不在 bundle 中。迁移前应自行核对处理，保留需要人工对照的原浏览器状态；已保存的服务器记录与浏览器尚未提交的内容是不同边界。

## 离线备份与核验

先停止本地服务，使飞书长连接和数据库连接正常退出，并停止其他 CLI／数据库使用进程。工具不会自动终止进程。选择彼此隔离的源和新备份目录；后端会拒绝源、目标或静态资源目录的危险重叠，以及 bundle 和递归内容中的不安全文件、符号链接。显式传入的路径入口按 realpath 核验，合法的父级符号链接允许使用，但不能绕过路径隔离检查。

```bash
node --import tsx scripts/instance-backup.ts backup \
  --data-dir /private/current/data \
  --kg-root /private/current/knowledge \
  --cli-state-dir /private/current/cli \
  --output /private/backups/living-memory-new

node --import tsx scripts/instance-backup.ts verify \
  --bundle /private/backups/living-memory-new
```

需要归档配置时，在 `backup` 命令中显式加 `--env-file /private/current/environment.env`。CLI 收据可能由 `LM_CLI_STATE_DIR` 或原命令的 `--state-dir` 指向独立目录，请传实际位置；它不一定随 `LM_DATA_DIR` 变化。备份必须在停止写入的状态完成，核验会检查文件完整性和已知数据库结构。静态 bundle 的 `verify` 不会启动服务或飞书。

当前离线检查依赖 Linux／WSL 的 `/proc` 与同一操作系统用户的数据库文件描述符信息。若无法确认离线状态，会拒绝操作；端口空闲不能代替数据库离线核验。CLI 不提供替代 `/proc`、忽略进程或导入一次性证明的参数。Windows 原生完整迁移仍待验证，macOS 不在本期支持范围内。

### WSL 的受限文件句柄

2026-10-18 在本机确认：用户的 systemd／PAM 进程可能不允许普通账号读取其文件描述符，使默认检查返回 `OFFLINE_CHECK_UNAVAILABLE`。这属于工具与主机权限的兼容边界，不应通过终止系统进程或放宽全局 ptrace 设置处理。

需要额外读取权限时，在可信源码目录中，以原账号给 `backup` 命令加上 `--sudo-offline-scan`：

```bash
node --import tsx scripts/instance-backup.ts backup \
  --data-dir /private/current/data \
  --kg-root /private/current/knowledge \
  --cli-state-dir /private/current/cli \
  --output /private/backups/living-memory-new \
  --sudo-offline-scan
```

该选项只启动随源码提供的单用途 Python 只读辅助器。sudo 密码由 sudo 在本机终端读取，不经过应用输入、管道或聊天。备份、数据库连接、文件复制和服务仍由原账号执行，不要将整个 Node 命令改为 `sudo node`。此通道需要 `/usr/bin/sudo` 和 `/usr/bin/python3`；非交互环境只尝试已有授权，没有授权时返回 `OFFLINE_SCAN_AUTH_REQUIRED`。

辅助器只收到本轮进程身份和受控数据库文件的设备号／inode，不收到路径、知识正文或配置密钥；它扫描真实 `/proc` 的 UID 与文件句柄元数据，不打开数据库内容。每次操作使用独立的实时管道，校验请求序号和父进程身份，拒绝重复／过期／超量数据。首扫成功后才暂存备份，源连接关闭及 bundle 核验后再次扫描，辅助器正常确认关闭后才发布；任一步未知或失败均不放行，原目录锁始终由原账号持有。辅助器不作为后台服务或可复用证明保存。

FD 扫描只代表检查点的观察，不能原子阻止任意旧程序随后打开数据库。迁移期间仍须停止旧服务和 CLI；运行锁排斥遵守该协议的新服务。目录属主也不等于进程 UID，检查使用 status 的四项 UID，避免漏掉不可转储的进程；相关 Linux 行为见 [proc_pid](https://man7.org/linux/man-pages/man5/proc_pid.5.html) 与 [proc_pid_fd](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html)。

该通道的协议与失败分支使用合成进程和假子进程测试；本机真实执行结果见[2026-10-21 记录](#2026-10-21-本机执行记录)，不将合成回归或这次本机成功扩展为其他设备的验证。

## 学习结构 v2 的升级边界

新建 bundle 外层为 v2，包含 `learningSchemaVersion: 1 | 2 | 3`。离线备份如实声明源学习结构，备份不会升级源库；v1 归档仅接受已知 preview.1 的实际旧结构。默认恢复仍使用 v2，v3 使用下述显式恢复和启动流程。未知、部分损坏、声明不符的结构会拒绝，不能通过编辑 manifest 的版本数字转换。

新服务对旧学习库返回 `LEARNING_SCHEMA_UPGRADE_REQUIRED`，启动不原地升级。按本页先完成离线备份与 `verify`，再执行下面的恢复：旧结构只在新目标的暂存库内事务迁移为 schema 2，失败不发布目标；当前 v2 保留原登记。保存旧目录与源归档，回退时不要用旧程序打开升级后的目录。

仅当确实需要旧程序读取旧结构的新目录副本时，才在 `restore` 另加 `--preserve-legacy-learning-schema`。该标志只接受实际 schema 1，不提供 v2→v1 降级；新实例标识、原会话失效与飞书隔离仍生效。

## 学习结构 v3 的隔离候选

2026-10-26 的 ACLEAR-02C4B2 已接通显式 v3 启动。默认启动和恢复仍为 v2；v3 需先离线恢复到新目录，再选择运行版本 3 与匹配的网页构建。日常使用的私人实例未因此升级，原回答清除入口仍未开放。

```bash
node --import tsx scripts/instance-backup.ts restore \
  --bundle /private/backups/living-memory-new \
  --target /private/restored/living-memory-v3-candidate \
  --learning-schema 3
```

仅在全新目录暂存升级，原库和归档不变。已知 v1 先在 stage 副本正规化到 v2，再把已知完整 v2 按命名列复制到规范 v3；保留原行号、整数、原字段、请求字节及修订链，observations 的清除时间初始化为 NULL，版本 metadata 更新为 3。两个连接的复制不等于跨库原子提交：任意失败均丢弃整个未发布 stage，不能拿失败操作残留的临时文件作为成功候选。

完整备份和 `verify` 支持 v3，并在 manifest 的 `learningSchemaVersion` 如实声明 3；v3→v3 显式恢复保留已有清除标记和缺失原答，不转成普通空答。v3 归档若没有显式选 3，或要求 2，返回 `INSTANCE_SCHEMA_TARGET_REQUIRED`，创建目标之前拒绝；不提供 v3→v2／legacy 降级。`--learning-schema` 只接受 2 或 3，不能与 `--preserve-legacy-learning-schema` 并用。

新报告额外包含 `learningSchemaCandidate: { schemaVersion: 3, runtimeReady: true }` 及 `startup.learningSchemaVersion: 3`。`runtimeReady` 仅说明当前软件支持显式 v3，不表示已启动、已核验网页或已解除隔离；旧工具生成的 false 报告不会被改写。新实例身份、旧会话撤销和连接器隔离规则保持。按[日常启动说明](instance-runtime.md#显式启动-v3)选择 v3，连接器激活需再次显式选择 3。升级前保留匹配的 v2 源码／构建及旧备份，私人升级仍单独安排。

完整往返、清除标记、实际启动和失败清理使用合成目录验证，未迁移或切换当前私人实例。v3 学习 JSON／导入已有独立保护与集成测试；完整数据库备份往返和 JSON 防恢复分别验收。

## 恢复与核对

```bash
node --import tsx scripts/instance-backup.ts restore \
  --bundle /private/backups/living-memory-new \
  --target /private/restored/living-memory
```

目标必须是尚不存在的新目录。工具先校验和暂存，成功后发布新目录，不覆盖原实例。恢复结果中的 `startup` 给出新的 data、所有者知识源、CLI 收据和可选配置归档位置。默认 v2 恢复可按这些实际路径配置 `LM_DATA_DIR`、`LM_KG_ROOT`、`LM_CLI_STATE_DIR` 后启动应用；配置归档不会自动作为环境加载。显式 v3 候选须额外选择运行版本 3 并使用匹配构建，见上节边界。

源身份登记保留原 namespace 与概念 ID 的生成身份，所以物理根目录改变不会把个人历史变成新的知识库。当前物理根指纹仍单独校验。学习记录、长期保持状态和活动原始引用按原事实保留，不借迁移伪造新的学习表现。

恢复会生成新的实例标识，撤销原浏览器／设备认证会话，作废未完成绑定码、旧交互卡片和未结束复习会话；尚未应用的复习意图不会在新实例自动执行。已有飞书绑定保留，但连接器处于隔离状态。重新登录后先核对账号、各知识域、节点记忆状态及活动记录。新服务会重新生成本机 CLI 登录凭据。

旧浏览器和旧 CLI 待发队列不能跨实例自动重放。CLI 收据可以作为私有归档保留，但旧实例的学习重试会被拒绝，活动收据也按账号、服务、知识空间及实例隔离。应先人工核对原记录是否已保存，再明确开始新的操作，不能仅因待发文件仍在就视为已经迁移完成。

对于完整已知旧结构，正常恢复在同一学习迁移事务中补齐已知可空列、旧练习结构、缺失的整组活动表和新修订表。部分缺失与未知结构拒绝；具体升级结果保留在私有恢复报告中，不是通用全历史版本迁移。

## 原知识源重接的只读预览

恢复默认使用 bundle 中的知识副本。若日常 progressive-kg 仍更新原目录，先预览接回该目录需要的身份登记和运行路径：

```bash
node --import tsx scripts/source-reconnect-preview.ts \
  --instance-root /private/restored/living-memory \
  --kg-root /private/current/knowledge \
  --url http://127.0.0.1:4318
```

这是只读的准备入口，可在隔离验收服务运行时使用。它不打开数据库、不读取设备令牌或环境归档、不连接服务、不执行钩子，也不写文件；没有 `--apply`。输出仅包含身份与路径元数据、概念／关系及内容版本差异数量、钩子拟改文件名和固定冲突码，不包含知识正文、凭据或文件原文。路径和来源身份仍是本机信息，需要保存报告时放在自己的私有目录。

`proposedRegistry` 替换所有者当前的 `physicalRoot`，保留原身份种子、显示名及其他成员登记；不会给同一身份同时登记两个根。`source` 分开显示稳定 namespace 和两处实际根指纹；`knowledge` 比较两个完整索引，共同相对路径的原始概念 ID、新增／缺失概念及内容版本变化分别计数。改名会表现为缺失和新增，不自动继承历史；这个入口不读取学习库，因此也未核对人工身份绑定、回答或记忆状态。诊断数量大于零时，还需检查知识源本身的解析／引用问题。

状态 `reviewable` 只表示可以审阅这份当时快照；`blocked` 表示钩子文件或安装前提存在冲突，命令返回非零。缺少或损坏的恢复上下文、登记冲突、未隔离实例及无效目录会直接拒绝。两种状态都不表示已经接通，更不表示知识含义相同。实际切换前仍需重新预览、停止服务并核对具体修改，不能将输出直接覆盖到运行中的登记表。

`runtime` 列出新实例应使用的 `LM_DATA_DIR`、`LM_CLI_STATE_DIR`、`LM_CLI_SESSION_FILE`、`LM_SERVER_URL`、`LM_KG_ROOT` 和 `LM_LEARNING_SCHEMA_VERSION`，并保持 `LM_FEISHU_ENABLED=0`。这些是所需配置，不是已生效配置，也不会验证令牌是否有效。版本从严格验证的恢复报告推导：普通 v2 报告只能对应空迁移链或 v2；v3 candidate 只接受空链、v3 或先 v2 后 v3，历史 false candidate 可按当前软件提议 3，新 true 报告必须明确 startup 版本 3。其他组合拒绝，预览不检查数据库或网页兼容性，也不改写旧报告。`hook.runtimeDirectoriesSupported=true` 仅表示拟安装模板支持运行目录；成功计划标为 `runtimeConfiguration: "planned"`，冲突时为 `"unavailable"`，均未应用。预览把恢复实例的数据与 CLI 目录传给安装规划器，升级原样 managed v1 模板并提出 v2 本机配置，凭据路径固定派生为 `dataDir/cli-session.json`；不打印配置内容或脚本原文。

实际安装方式及旧配置兼容见[指定实例的运行目录](cli-and-kg-triggers.md#指定实例的运行目录)。只改 URL 不足以完成迁移；实际接回知识源仍须核对身份登记、服务运行参数和全部调用方。安装前暂停 KG 调用；本机文件逐个原子替换，不是跨文件事务。预览不替代这些步骤，也不会搬运或重放旧实例队列。

## 明确恢复连接器

隔离模式用于先检查数据，不会因恢复成功就启动飞书。确认旧设备已停止同一机器人的消费，再停止恢复后的服务，明确确认绑定后执行：

```bash
node --import tsx scripts/instance-backup.ts activate-connectors \
  --data-dir /private/restored/living-memory/data \
  --confirm-bindings
```

该命令只解除恢复隔离标记，不连接飞书、不发送消息，也不修改学习表现。之后仍需由服务启动过程读取有效的飞书启用配置。恢复或激活失败时，CLI 仅输出固定错误码；原始异常、密钥和个人内容不会打印到终端。

v3 实例必须在上述激活命令额外加 `--learning-schema 3`；省略或选择 2 会拒绝 v3，并保留隔离。显式选择 3 遇到非 v3 也拒绝。省略版本仍保留已知 legacy／v2 的原激活兼容行为；这只解除连接器隔离，不代表旧结构可由当前服务直接启动。激活继续要求停服、持锁、两次离线扫描及文件身份核对，不能用报告的 `runtimeReady` 代替这些检查。

若激活时也遇到同样的 `/proc` 权限限制，可在原账号执行的命令中另加 `--sudo-offline-scan`，使用新一轮只读扫描；它不会沿用备份时的授权结果。`verify` 和 `restore` 不接受此选项，也不会触发提权。
