# 已有实例的日常启动

`develop` 新增 `npm run instance`，用于重复启动已有目录中的账号实例，数据库须与当前程序兼容。一次整理私有 JSON 中的路径和身份，之后复用同一命令；它在前台运行，终端按 Ctrl+C 正常停止。原 `npm start` 和固定 `v0.0.1-preview.1` 的首次运行步骤保持原用法。

此入口要求目录和数据库文件已经存在，不代替初始化或迁移流程，不改知识源或钩子、不安装后台服务。预检不证明数据库已经初始化；现有空文件仍由原服务器处理。旧学习库先按[完整实例迁移](instance-migration.md)恢复至新目录并升级；恢复隔离的连接器仍须按原流程单独激活。

## 准备私有配置

需要现有的账号与学习数据库、知识源、CLI 收据目录，以及与当前代码配套的网页构建。目录必须已经存在，数据目录中须有 `accounts.sqlite` 和 `living-memory.sqlite`，静态目录中须有 `index.html`。在开发仓库先运行 `npm ci` 和 `npm run build`；下例 `staticDir` 使用仓库 `dist` 的绝对路径，也可指向独立的持久构建目录。

将配置保存在 Git 忽略的私人目录，例如 `data/private/runtime.local.json`，Linux／WSL 目录权限用 700、文件用 600。不要把配置放进知识源或静态目录。示例字段必须换成实际路径与身份：

```json
{
  "format": "living-memory-instance-runtime",
  "version": 1,
  "dataDir": "/private/living-memory/data",
  "kgRoot": "/private/knowledge",
  "cliStateDir": "/private/living-memory/cli",
  "staticDir": "/private/living-memory/web",
  "port": 4317,
  "expectedInstanceId": "12345678-1234-4234-8234-123456789abc",
  "expectedSourceIdentityHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "expectedSourceRootFingerprint": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

路径字段须为规范化的绝对路径；端口为 1–65535 的整数。未知字段拒绝。数据、知识源、静态目录不能互相包含；CLI 目录可以是数据目录的严格子目录或独立目录，不能等于数据目录、包含数据目录，或与知识源／静态目录重叠。静态目录不能等于或包含安装仓库根；仓库中的 `dist` 可用。检查按真实路径处理父级符号链接，数据库、配置与 `index.html` 本身不能是符号链接。

身份字段是防止误启动其他目录的固定预期，不是每次自动跟随变化的设置。`expectedInstanceId` 来自该数据目录的 `instance-identity.json`；只有确实没有该文件的旧实例才用 `legacy`，损坏的文件不会按旧实例放行。知识源身份使用 `resolveSourceIdentity`：恢复后的 registry 可以保留旧身份，因此 `identityHash` 和实际根目录的 `sourceRootFingerprint` 可能不同。可在项目根目录运行以下只读命令，将输出保存到私人配置，不提交到仓库：

```bash
node --import tsx --input-type=module -e '
import { readInstanceId } from "./src/server/instance-state.ts";
import { resolveSourceIdentity } from "./src/server/source-identities.ts";
const [data, root] = process.argv.slice(1);
const source = resolveSourceIdentity(data, root);
console.log(JSON.stringify({ expectedInstanceId: readInstanceId(data),
  expectedSourceIdentityHash: source.identityHash,
  expectedSourceRootFingerprint: source.sourceRootFingerprint }, null, 2));
' /private/living-memory/data /private/knowledge
```

可选 `kgLimit` 为 1–300 的整数，默认 20；可选 `kgInclude` 为目录前缀，默认空串即不限定。它们对应原 `LM_KG_LIMIT`／`LM_KG_INCLUDE`，需要保留原显示范围时应明确填写。其余未声明的 `LM_*` 设置不会继承。此入口固定启用账号模式；CLI 设备文件固定为数据目录中的 `cli-session.json`，地址为配置端口的本机 URL。独立运行 CLI 时仍按[CLI 配置](cli-and-kg-triggers.md#指定实例的运行目录)选择同一实例，启动命令不会修改其他终端的环境。

## 检查、启动与停止

```bash
npm run instance -- check --profile /private/living-memory/runtime.local.json
npm run instance -- start --profile /private/living-memory/runtime.local.json
```

`check` 不打开数据库、不读设备令牌或飞书凭据、不创建文件、不加锁、不探测端口，也不启动飞书。它只验证配置、目录隔离、必需文件存在，以及实例和知识源身份；输出 `credentials: "not-read"` 和 `databaseContents: "not-checked"`。`staticEntryChecked` 仅证明 `index.html` 是普通文件，不证明构建新鲜或所有资源完整。`restoreQuarantined` 为 true 时仍可在飞书关闭状态启动本机页面。

`start` 先作同样预检，再清除当前进程继承的全部 `LM_*`，安装配置中的明确值，进入项目根目录并启动原有服务器。数据库兼容检查、运行租约及 SIGINT／SIGTERM 清理由同一套服务器负责；已被占用的数据目录拒绝第二个实例。启动成功后终端显示本机 URL；保持终端运行，Ctrl+C 正常停止。没有自动重启、自动杀进程或后台驻留功能。

启动后的数据库、端口与连接器仍可能报错，预检通过不代表这些已就绪。CLI 参数／预检失败仅输出固定错误码，不打印配置、路径或原始异常：

| 错误码 | 检查方向 |
| --- | --- |
| `INVALID_RUNTIME_ARGUMENT` | 命令、重复参数或缺少 `--profile` |
| `RUNTIME_PROFILE_INVALID` | JSON 字段、私有权限、大小或文件类型 |
| `RUNTIME_PATH_INVALID`／`RUNTIME_STORAGE_CONFLICT` | 现有目录与真实路径隔离 |
| `RUNTIME_DATABASE_MISSING`／`RUNTIME_BUILD_MISSING` | 必需数据库或网页入口缺失／类型不符 |
| `RUNTIME_INSTANCE_MISMATCH`／`RUNTIME_SOURCE_MISMATCH` | 实例身份、知识源 registry 或物理根预期不符 |
| `RUNTIME_CONNECTOR_QUARANTINED` | 恢复隔离尚未解除，不能显式启用飞书 |
| `RUNTIME_CREDENTIALS_INVALID` | 指定凭据文件或四项飞书配置无效 |
| `DATA_DIRECTORY_BUSY`／`DATA_DIRECTORY_LOCK_UNKNOWN` | 已有运行实例或无法确认租约 |
| `RUNTIME_START_FAILED` | 服务器实际启动未完成，检查代码与数据库版本是否配套 |

## 显式启用飞书

需要飞书时，在 profile 增加 `feishuEnvFile`，指向知识源和静态目录之外的私有普通文件。默认启动与 `check` 都不读取或检查该凭据文件本身。准备好已有应用及绑定后显式启动：

```bash
npm run instance -- start --profile /private/living-memory/runtime.local.json --feishu
```

文件按 Node `.env` 格式读取，只采用 `LM_FEISHU_APP_ID`、`LM_FEISHU_APP_SECRET`、`LM_FEISHU_TENANT_KEY`、`LM_FEISHU_TIME_ZONE`，时区缺省 UTC。其他键忽略，文件或继承环境中的 `LM_FEISHU_ENABLED` 不能自行授权启用。恢复隔离为 true 或损坏时，在读取凭据前拒绝；此命令不会清除隔离或创建新绑定。飞书真实连接仍需服务启动后的状态确认。

当前实现以 Linux／WSL 的合成实例验证配置只读、身份匹配、环境隔离、前台 HTTP、重复租约与双信号退出；本机运行实例只做预检，未为这项开发重启。Windows 原生的此入口尚待实测，macOS 继续暂缓。
