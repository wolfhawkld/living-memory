# 完整实例离线迁移

这条通道用于把同一个 Living Memory 实例搬到新目录或新设备。它保留多用户知识源与学习数据库，与网页中单账号学习 JSON 的导出／导入分开。当前支持的是本仓库已知数据库结构；不承诺兼容全部历史或未来版本。

## 备份范围

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

该通道的协议与失败分支使用合成进程和假子进程测试；真实 sudo 权限、私人备份及本机部署尚待本人终端验收，自动回归不代替这些结果。

## 学习结构 v2 的升级边界

新建 bundle 为 v2，包含 `learningSchemaVersion: 1 | 2`。离线备份已知旧库时声明 1，备份不会升级源库；v1 归档仅接受已知 preview.1 的实际旧结构。未知、部分损坏、声明不符的结构会拒绝，不能通过编辑 manifest 的版本数字转换。

新服务对旧学习库返回 `LEARNING_SCHEMA_UPGRADE_REQUIRED`，启动不原地升级。按本页先完成离线备份与 `verify`，再执行下面的恢复：旧结构只在新目标的暂存库内事务迁移为 schema 2，失败不发布目标；当前 v2 保留原登记。保存旧目录与源归档，回退时不要用旧程序打开升级后的目录。

仅当确实需要旧程序读取旧结构的新目录副本时，才在 `restore` 另加 `--preserve-legacy-learning-schema`。该标志只接受实际 schema 1，不提供 v2→v1 降级；新实例标识、原会话失效与飞书隔离仍生效。

## 恢复与核对

```bash
node --import tsx scripts/instance-backup.ts restore \
  --bundle /private/backups/living-memory-new \
  --target /private/restored/living-memory
```

目标必须是尚不存在的新目录。工具先校验和暂存，成功后发布新目录，不覆盖原实例。恢复结果中的 `startup` 给出新的 data、所有者知识源、CLI 收据和可选配置归档位置。按这些实际路径配置 `LM_DATA_DIR`、`LM_KG_ROOT`、`LM_CLI_STATE_DIR` 后再启动应用；配置归档不会自动作为环境加载。

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

`runtime` 列出新实例应使用的 `LM_DATA_DIR`、`LM_CLI_STATE_DIR`、`LM_CLI_SESSION_FILE`、`LM_SERVER_URL`、`LM_KG_ROOT`，并保持 `LM_FEISHU_ENABLED=0`。这些是所需配置，不是已生效配置，也不会验证令牌是否有效。`hook.runtimeDirectoriesSupported=true` 仅表示拟安装模板支持运行目录；成功计划标为 `runtimeConfiguration: "planned"`，冲突时为 `"unavailable"`，均未应用。预览把恢复实例的数据与 CLI 目录传给安装规划器，升级原样 managed v1 模板并提出 v2 本机配置，凭据路径固定派生为 `dataDir/cli-session.json`；不打印配置内容或脚本原文。

实际安装方式及旧配置兼容见[指定实例的运行目录](cli-and-kg-triggers.md#指定实例的运行目录)。只改 URL 不足以完成迁移；实际接回知识源仍须核对身份登记、服务运行参数和全部调用方。安装前暂停 KG 调用；本机文件逐个原子替换，不是跨文件事务。预览不替代这些步骤，也不会搬运或重放旧实例队列。

## 明确恢复连接器

隔离模式用于先检查数据，不会因恢复成功就启动飞书。确认旧设备已停止同一机器人的消费，再停止恢复后的服务，明确确认绑定后执行：

```bash
node --import tsx scripts/instance-backup.ts activate-connectors \
  --data-dir /private/restored/living-memory/data \
  --confirm-bindings
```

该命令只解除恢复隔离标记，不连接飞书、不发送消息，也不修改学习表现。之后仍需由服务启动过程读取有效的飞书启用配置。恢复或激活失败时，CLI 仅输出固定错误码；原始异常、密钥和个人内容不会打印到终端。

若激活时也遇到同样的 `/proc` 权限限制，可在原账号执行的命令中另加 `--sudo-offline-scan`，使用新一轮只读扫描；它不会沿用备份时的授权结果。`verify` 和 `restore` 不接受此选项，也不会触发提权。
