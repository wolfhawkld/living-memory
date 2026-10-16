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

当前离线检查依赖 Linux／WSL 的 `/proc` 与同一操作系统用户的数据库文件描述符信息。若无法确认离线状态，会拒绝操作；端口空闲不能代替数据库离线核验。CLI 不提供替代 `/proc` 或绕过检查的参数。Windows 原生完整迁移仍待验证，macOS 不在本期支持范围内。

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

对于本仓库已知、尚无活动账本的旧学习 schema，恢复可初始化四张独立活动表；这不是通用的全版本数据库迁移机制。具体处理结果保留在私有恢复报告中。

## 明确恢复连接器

隔离模式用于先检查数据，不会因恢复成功就启动飞书。确认旧设备已停止同一机器人的消费，再停止恢复后的服务，明确确认绑定后执行：

```bash
node --import tsx scripts/instance-backup.ts activate-connectors \
  --data-dir /private/restored/living-memory/data \
  --confirm-bindings
```

该命令只解除恢复隔离标记，不连接飞书、不发送消息，也不修改学习表现。之后仍需由服务启动过程读取有效的飞书启用配置。恢复或激活失败时，CLI 仅输出固定错误码；原始异常、密钥和个人内容不会打印到终端。
