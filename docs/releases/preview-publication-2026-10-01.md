# 首个本地 Web 预览发布记录

核对日期：2026-10-01。已发布 [Living Memory 0.0.1-preview.1](https://github.com/wolfhawkld/living-memory/releases/tag/v0.0.1-preview.1)，标记为 prerelease；本页记录实际发行结果，准备流程见[预览清单](local-web-preview.md)。

## 固定发行对象

| 对象 | 实际值 |
| --- | --- |
| GitHub release | `400895422`，`draft: false`、`prerelease: true`、`isLatest: false` |
| 集中阶段 PR | [#44](https://github.com/wolfhawkld/living-memory/pull/44)，`develop → main`，2026-10-01 合并 |
| 阶段头提交 | `487c954323ec652431e1427ce894f6499b00e8cf` |
| 精确发行提交 | `1c7a639c8f5517cbb9435ed459efdf739066e4c1` |
| 附注 tag | `v0.0.1-preview.1`；tag 对象 `5f12bb73e7b67a58df74cb9332640d6491e16ca4`，解引用到上述发行提交 |
| GitHub 发布时间 | `2026-10-01T11:19:49Z`（UTC） |
| 分发 | GitHub 自动 ZIP/TAR 源码；没有另附构建包、安装器、依赖目录或运行时 |

发行前核对同名 tag/release 均不存在；先完成阶段与发行提交的 CI，再创建附注 tag，随后核对 GitHub ZIP/TAR、release 目标、正文和状态。没有移动 tag、重写历史或删除分支。发行树与阶段头提交一致；OSS-07～08 和发行准备只增加文档及项目版本元数据，依赖解析、应用、测试、CI 配置、记忆模型和数据格式未因此改变。包和 lockfile 三处版本均为 `0.0.1-preview.1`，`private: true` 与 MIT 保留。

## 精确提交的 CI

- [develop 阶段 CI](https://github.com/wolfhawkld/living-memory/actions/runs/36852223824)：通过。
- [PR #44 CI](https://github.com/wolfhawkld/living-memory/actions/runs/36852251300)：通过。
- [发行提交的 main CI](https://github.com/wolfhawkld/living-memory/actions/runs/36852873767)：通过，`headSha` 为 `1c7a639c8f5517cbb9435ed459efdf739066e4c1`。

最终 main 日志确认 496 项 Node/HTTP 测试、构建、主题构建检查和 10 项 Chromium 回归通过。本地没有启动浏览器；CI 使用 Linux 软件渲染，不代替用户视觉验收、原生平台或真实 GPU 性能检查。

已有干净运行、38 项针对性兼容检查、构建和合成两账号原路径备份恢复证据见[OSS-08 验证](upgrade-validation-2026-10-01.md)。这些证据不证明任意新旧数据库、跨根路径或跨机器迁移可用。

## 源码归档核对

本地 `git archive`、GitHub 的发行提交 ZIP、tag ZIP 和 tag TAR 去掉各自唯一包装目录后，与精确发行提交的 `git ls-tree` / blob 对象逐文件核对。每份均为 **324 个文件、4,919,824 字节文件内容**：无缺失、额外、重复、不安全路径、链接、子模块或内容差异，32 个必需入口全部存在。

归档目录名与压缩字节不是稳定校验依据。所有 Git 跟踪文件为非可执行普通文件 `100644`；ZIP 未编码 POSIX 权限，TAR 文件为 `0664`，可执行位相同，符合 [Git archive 默认 tar.umask](https://git-scm.com/docs/git-archive#_configuration)。核对没有将这两种权限表示误写成完整位值相等。

核对必需入口包含 MIT、推荐 Node 版本、包/lockfile、运行与测试源码、CI、协作文档、版本说明和合成素材。16 篇示例概念、README 素材的合成/非学习导入标记保留；SVG 没有脚本或外部资源，4 张 PNG 为已有合成演示素材且只有 IHDR/IDAT/IEND 块。

未发现发行归档中已跟踪的私人数据库、凭据目录、会话日志、真实 vault、`node_modules`、`dist` 或测试产物路径。检查仅针对发行归档与此前[公开内容检查](public-content-review-2026-10-01.md)所述范围，不是完整安全审计；本轮没有读取个人数据目录、外部知识库或本机私有配置。

## 文档、分支与后续边界

使用者按[版本说明](v0.0.1-preview.1.md)运行固定 tag；贡献者继续使用长期 `develop`。tag 内的 README/changelog 保留发布前准备快照，实际发布时间与结果以 release 和本页为准；发布后的状态文档同步到 `main`/`develop`，不会改写已发行源码。

时间模型仍为 `time-only-v0`，D 不是记忆正确率，观察与应用暂不拟合 H；浏览、查询、生成和刷新不自动确认重温，固定长期保持仅本人解除。平台、媒体、复习安排、导入/身份和外部 KG 的剩余人工验收按[迭代 TODO](../planning/iteration-todo-2026-09-22.md)保留，软件通过不代表已证明学习收益。

首批 [#39～43 协作任务](../planning/first-contribution-tasks.md)仍待认领实施，发布不自动关闭旧功能 Issue。在线协作、共享融合、语音、Obsidian 和移动端继续属于后续路线；发布后的日常开发沿用现有分支。
