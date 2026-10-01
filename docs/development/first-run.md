# 第一次运行 Living Memory

这份指南从干净源码开始，使用仓库自带的合成知识体验本地 Web，再接入自己的 Markdown。以下使用已发布的固定 tag `v0.0.1-preview.1`，发行结果见[版本说明](../releases/v0.0.1-preview.1.md)；参与开发使用长期 `develop`，见[贡献指南](../../CONTRIBUTING.md)。服务只监听本机 `127.0.0.1`。

## 1. 准备环境

安装 Git 和 Node.js **22.23.1**。仓库的 [`.nvmrc`](../../.nvmrc) 与 [CI](../../.github/workflows/check.yml) 使用同一版本；本次验证使用该版本附带的 npm **10.9.8**。`package.json` 声明的最低版本为 22.13.0，其他 Node 版本尚未逐一验证。

```bash
git clone --branch v0.0.1-preview.1 --single-branch https://github.com/wolfhawkld/living-memory.git
cd living-memory
```

已安装 nvm 的 Bash 用户可执行 `nvm install`、`nvm use`。其他环境直接安装上述 Node 版本，再用 `node --version` 和 `npm --version` 核对即可，不需要 nvm。

## 2. 安装、构建和启动

在仓库根目录执行：

```bash
npm ci
npm run build
npm start
```

保持终端运行，打开 `http://127.0.0.1:4317`。`npm ci` 按锁文件安装依赖；构建生成 `dist/`，`npm start` 提供页面与 API。修改前端源码后需重新构建；开发时改用 `npm run dev`，页面地址为 `http://127.0.0.1:5173`，API 仍在 4317。

首次使用无需设置环境变量，也无需外部 progressive-kg。Node 22 的 `node:sqlite` 实验性提示不代表服务启动失败。按 Ctrl+C 停止服务；启动另一种运行方式前，先停止旧实例。

## 3. 创建自己的账号并体验示例

首次打开页面显示“创建第一个账户”，**没有默认用户名或密码**。自行设置用户名（3～32 位 ASCII 英文字母、数字、点、下划线或连字符，须以字母或数字开头，保存为小写）和密码（12～256 个字符）。第一个账户是管理员；以后启动应登录这个账户。管理员可在“账号管理”创建成员。

默认知识源为 [`fixtures/demo-kg`](../../fixtures/demo-kg/README.md)，包含 Math、Model 两个目录的 16 个合成概念及关系。它不包含个人知识库或真实学习历史。

首次图谱的“示例状态”使用虚构日期展示时间颜色；点击“查看真实记录”后，新概念没有确认重温日期时应显示“未知”。可选择节点查看资料，或先回答再核对。实际完成重温后才确认时间；查询、阅读和刷新不会自动重置起点。时间颜色是模型提示，不是个人记忆正确率。

## 4. 数据保存在哪里

默认路径以仓库根目录为起点：

| 路径 | 内容 |
| --- | --- |
| `fixtures/demo-kg/` | 只读的合成知识源 |
| `data/local/accounts.sqlite` | 账号、密码哈希与登录会话 |
| `data/local/living-memory.sqlite` | 各知识空间的学习记录、配置与布局 |
| `data/local/cli-session.json` | 首次建号后生成的管理员 CLI 设备凭据 |
| `data/local/users/<账号 ID>/knowledge/` | 成员各自的 Markdown 知识目录 |

`data/local/` 已被 Git 忽略，其中的账号库、设备凭据和私人知识不要提交。浏览器中的待同步操作、复习草稿和界面偏好另存于浏览器；它们不等同于服务端记录。换浏览器不会自动带走这些本机内容。

需要整体备份时，停止服务后复制整个数据目录，并单独备份外部知识源；不要只复制运行中的单个 SQLite 文件。页面“导出学习数据”生成的 JSON 可按[导入恢复说明](learning-data-import.md)恢复支持的学习内容，但不含账号、密码、知识正文或浏览器草稿，不是完整应用备份。

完整升级、目录外 CLI 状态、原路径恢复及回退步骤见[升级与恢复](../releases/upgrade-and-recovery.md)；[版本兼容约定](../releases/versioning-and-compatibility.md)说明当前格式与迁移范围。

## 5. 接入自己的 Markdown 知识库

管理员在启动前设置 `LM_KG_ROOT`。不要求安装 progressive-kg，但笔记须符合下述概念格式。建议把知识库放在独立目录，例如：

```text
projects/
  living-memory/
  knowledge-vault/
    Math/
      向量.md
      内积.md
```

`Math/向量.md`：

```markdown
---
type: concept
title: 向量
aliases: [Vector]
summary: 用有序分量表示方向、大小或特征。
---

# 向量

这是我对向量的解释。

## 关系网络

- 相关：[[内积]] — 用于理解两个向量的关系。
```

`Math/内积.md`：

```markdown
---
type: concept
title: 内积
---

# 内积

把两个向量映射为标量。
```

`type: concept` 用于识别概念；标题、别名、摘要和正文供阅读与搜索。建议在 `## 关系网络` 中按上述结构注明关系类型，目标须能对应已加载的概念；普通正文的双链也会生成默认“相关”边。Web 按相对父目录划分领域，本例属于 `Math`；嵌套目录保留完整路径，根目录概念属于 `__root__`。两份笔记即可形成两个节点和一条边。

停止服务，再从 Living Memory 根目录启动。Bash：

```bash
LM_KG_ROOT="../knowledge-vault" npm start
```

PowerShell：

```powershell
$env:LM_KG_ROOT = "C:\projects\knowledge-vault"
npm start
```

刷新页面并登录。已有账号继续保留，但知识根目录的规范化路径决定管理员的学习空间：从示例切换到自有知识源会进入另一份状态，原示例记录仍保存在数据库中。先选好长期使用的根目录；不要通过改路径来搬迁历史。改名/移动单篇笔记的衔接见[概念身份说明](concept-identity.md)。

在同一根目录添加或修改笔记后，点击顶部“刷新”按钮重新扫描。当前页面只读取知识，不提供上传或编辑 Markdown 的功能。

成员不使用管理员的 `LM_KG_ROOT`：管理员创建成员后，从账号管理复制其账号 ID，将合规 Markdown 放入 `data/local/users/<账号 ID>/knowledge/`（使用 `LM_DATA_DIR` 时替换 `data/local`），由成员登录并点击“刷新”。具体隔离与认证规则见[私人账号与知识域](private-accounts.md)。

## 6. 可选运行参数与 CLI

| 环境变量 | 默认值 | 使用场景 |
| --- | --- | --- |
| `LM_KG_ROOT` | `fixtures/demo-kg` | 管理员的只读知识根目录 |
| `LM_DATA_DIR` | `data/local` | 账号与学习数据目录；首次启动前选定，后续沿用 |
| `LM_PORT` | `4317` | 更换本地服务端口 |
| `LM_KG_LIMIT` | `20` | 每个领域的主节点显示上限，最大 300；全库仍可搜索 |
| `LM_KG_INCLUDE` | 不限定 | Web 初始领域提示及旧范围 API 的目录前缀 |

环境变量由启动终端提供，项目不自动读取 `.env`。管理员知识源、数据目录和网页 `dist/` 必须彼此独立，不能相互包含；不要把仓库根目录作为知识源，也不要把私人数据放进 `dist/`。修改根目录、数据目录或端口后需重启服务。

设置 `LM_PORT` 后，`npm start` 的页面地址也改为 `http://127.0.0.1:<端口>`。使用 `npm run dev` 时，页面仍在 5173，API 代理则跟随 `LM_PORT`；该变量不能解决 5173 被占用的问题。

在首次建号后、服务运行期间，另开终端进入同一仓库：

```bash
npm run --silent lm -- query "向量"
```

CLI 自动读取管理员的设备凭据。若服务使用自定义 `LM_DATA_DIR`，CLI 终端也要设置相同值；若换了端口，需通过 `--url http://127.0.0.1:<端口>` 指定服务地址。CLI 查询会刷新知识索引，但不确认重温。CLI 设备身份目前对应管理员，不能用来读取成员的私人空间。其他操作见[CLI 与 KG 触发](cli-and-kg-triggers.md)。

CLI 重温回执默认另存于仓库 `data/local/cli`，不会随 `LM_DATA_DIR` 改变；`LM_CLI_STATE_DIR` / `--state-dir` 可另设。设备文件默认跟随数据目录，`LM_CLI_SESSION_FILE` 可另设。备份自定义数据目录时同时核对这些路径。

## 常见启动问题

| 现象 | 检查与处理 |
| --- | --- |
| 安装或启动提示版本不兼容 | 核对 Node 22.23.1，并在该版本下重新执行 `npm ci` |
| 服务端口 4317 被占用 | 停止自己的旧实例，或设置另一个 `LM_PORT` 并使用对应页面/CLI 地址 |
| 开发页面端口 5173 被占用 | 停止占用该端口的旧实例；修改 `LM_PORT` 只改变 API 端口 |
| 没有页面、API 能访问 | 确认在仓库根目录完成 `npm run build`，然后重启 |
| 知识源错误或图谱为空 | 核对服务所在系统可访问的路径、`type: concept` 和领域选择；错误路径不会回退到示例 |
| 重启后仍要求登录 | 这是正常账号流程；只有全新数据目录才显示首次建号 |
| CLI 返回 `AUTH_REQUIRED` | 先在页面完成首次建号，核对 CLI 的数据目录、设备凭据与服务地址 |

2026-10-01 已在 WSL2/Linux x86_64、Node 22.23.1、npm 10.9.8 的独立源码副本验证干净安装、构建和 HTTP 首次运行流程。Windows 原生、macOS 与目标设备 GPU 性能仍待验证；浏览器视觉体验由用户验收。具体检查结果保存在[OSS-03 记录](../planning/open-source-readiness-2026-09-27.md#oss-03-实施记录2026-10-01)。
