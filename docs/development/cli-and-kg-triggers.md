# CLI 与 progressive-kg 日常触发

日期：2026-09-17。对应 LM-009 的先行子集：通过同一本地服务查询知识、明确确认重温，在成功的 KG 操作后刷新图谱。逐概念历史时间线留到下一轮。

## 启动与查询

先按 [运行说明](p0-running.md)启动本地服务。CLI 与服务应在能使用同一知识根目录的环境中运行，例如均在 WSL 中。CLI 不直接打开 SQLite。

```bash
npm run --silent lm -- help
npm run --silent lm -- status
npm run --silent lm -- query "概念关键词"
npm run --silent lm -- show "概念选择器"
```

`query` 先刷新来源，再按标题、别名和摘要搜索；返回匹配概念、来源版本和当前时间状态。它是确定性的本地查询，不负责生成自然语言答案。`show` 可使用概念 ID、相对文件路径、完整标题或别名；有歧义时返回候选，不随意选第一个。CLI 的 query、show、status 和 review 都读取 `/api/snapshot?scope=all`，可以访问完整索引；`LM_KG_INCLUDE` 和 `LM_KG_LIMIT` 主要影响兼容的缺省 snapshot 与 Web 的初始领域/每域显示上限，不把 CLI 搜索截断为单一领域。

可用 `--url` 或 `LM_SERVER_URL` 指定另一本机端口。通过 `--source-root` 或 `LM_KG_ROOT` 指定预期知识根目录时，CLI 会核对服务的来源身份；不一致时拒绝操作。跨机器或公网连接不在此版本范围内。Web 的领域切换、跨域展开和布局行为见[知识域视图](domain-views.md)。

CLI 输出 JSON，错误写入 stderr 并返回非零退出码；不会输出本地会话令牌。

## 明确确认重温与重试

只有实际完成重温、且用户明确确认时执行：

```bash
npm run --silent lm -- review "概念选择器" --confirm --event-id review-example-001
```

每次新的真实重温使用新事件 ID；省略 `--event-id` 时由 CLI 生成并返回。重试同一次操作必须复用原 ID。可用 `--at` 提供实际发生的带时区时间，或用 `--revision` 指定本次所读的内容版本；时间和版本仍由服务校验。CLI 不提供批量点亮全图的入口。

在首次提交前，CLI 将来源身份、事件 ID、概念 ID、版本和发生时间固定到本地重试档案。网络失败后执行：

```bash
npm run --silent lm -- retry review-example-001
```

重试使用原请求与新会话令牌；已入账的请求返回 duplicate，不产生新的重温起点。相同 ID 配上不同概念、版本或时间会报冲突。服务暂时不可达且尚未取得概念身份时，命令明确失败，不猜测概念或版本。

档案默认保存在 Living Memory 项目的 `data/local/cli`，可用 `LM_CLI_STATE_DIR` 指定目录；它包含私人学习信息，不应提交 Git。查询、生成、刷新和单纯查看不会创建重温事件，也不会改动 H。

## 安装到 progressive-kg 的 Agent 流程

progressive-kg 当前通过 `AGENTS.md` 和 `_system/OPERATIONS.md` 约定 Ingest / Query / Consolidate，并没有这些操作的专用可执行管线。这里安装的是供 Agent 在成功收尾时调用的钩子，不是假设存在文件监听器或内置回调。

```bash
npm run install:kg-hook -- --root ../progressive-kg --check
npm run install:kg-hook -- --root ../progressive-kg
```

安装内容：

- 在 `AGENTS.md` 追加一段有明确标记的收尾约定，保留原有内容。
- 安装 `_system/living_memory_hook.py`，仅调用本项目 CLI。
- 写入 `_system/living-memory.local.json` 保存本机项目位置与服务地址，并添加对应 Git 忽略项；不保存令牌。

重复安装不会追加重复指令；遇到与模板不同的脚本、被手工编辑的集成段落，或准备后被改动的文件会拒绝覆盖。写入以单个文件为原子单位；中途中断可重新运行安装命令完成剩余部分。协作者各自安装本机配置；没配置时可跳过集成。安装不修改概念正文、来源元数据或 `raw/`。

Agent 在 Query 已生成带来源的回答，或 Ingest / Consolidate 已完成实际修改并通过原有 lint 后，调用相应命令：

```bash
python3 _system/living_memory_hook.py query --operation-id query-example-001
python3 _system/living_memory_hook.py ingest --operation-id ingest-example-001
python3 _system/living_memory_hook.py consolidate --operation-id consolidate-example-001
```

只运行当前流程对应的一条。钩子会核对所连接服务的知识根目录，并重新加载服务配置范围内的概念和关系。重复刷新是安全的；操作 ID 用于返回回执和重试关联，本轮不建立持久化查询日志，也不推断用户阅读或学习成功。

服务离线时保留原始查询答案与知识生成结果，报告刷新失败；恢复后重试同一钩子命令。手工编辑文件、绕过此约定的 Agent 或未配置的机器仍需手动刷新，不宣称所有编辑已被自动捕获。

## Web 更新与验收

Web 切换到“查看真实记录”后，服务通过 `/api/changes` 发送轻量变化通知。页面重新读取同一份状态；断线重连也重新读取，通知本身不作为学习事件保存。正在回忆作答或编辑时延后刷新，避免覆盖输入；示例状态和未来时间预览保留其独立语义。

如果服务重启后换成了另一个知识根目录，当前页面会保留输入、停止写入并持续提示重新加载；不会把旧页面的学习记录发到新知识源。

同一知识库的服务重启会更新会话令牌。Web 写入遇到过期令牌时会重新获取会话，核对来源后原样重试一次；重温时间、事件 ID 和回答内容不会重建。布局保存、参数保存、刷新和待同步记录共用此机制。会话响应不缓存，并发恢复合并为一次请求。更新前已打开的旧页面需要先用浏览器刷新一次加载新版代码。

本轮通过 CLI / HTTP / SSE 和临时知识库验证查询不重置起点、真实重温可持久化、失败重试、来源隔离、内容修改与通知恢复。85 项自动测试与构建通过；浏览器视觉验收由用户进行。

2026-09-17 验证记录：

- `npm test`：85 项通过；覆盖 CLI、安装器、服务变化通知、订阅/延后处理、会话恢复、领域视图和既有逻辑检查。
- `npm run build`：通过。Three.js 图谱的主 bundle 体积提示仍存在，不代表已完成性能验收。
- 本机 progressive-kg：安装完成且原库 lint 无问题；CLI 查询与已安装钩子刷新成功。实际知识内容和本机计数不写入公共文档。
- 对比刷新前后学习导出，除导出时间外完全一致；H 保持当前配置。真实数据上未创建测试重温事件。
- 本轮未启动浏览器，尚未做新接入行为的浏览器验收；既有 P0 浏览器检查记录仍保留。

同日会话恢复修复的验证覆盖同库重启换令牌、重温请求原样重放且只入账一次、布局自动保存恢复、并发恢复、不同知识源拒绝写入和第二次鉴权失败停止重试；构建与类型检查通过，未运行浏览器。

实际体验可按以下顺序：切到真实记录 → CLI 查询一个概念 → 实际重温后明确确认 → 查看 Web 的时间起点和颜色 → 用同一事件 ID 重试，确认不会新增一次重温。不要把流程演示命令当作真实学习记录批量执行。
