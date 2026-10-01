# 开源协作与维护实施记录（OSS-06）

日期：2026-10-01。日常维护继续沿用长期 `develop`，已验证的一组改动集中同步到 `main`；本轮整理贡献入口和维护约定，不修改应用或记忆模型。

## 协作入口

- [贡献指南](../../CONTRIBUTING.md)：新人开发、Issue 认领、外部 fork/PR 到 `develop`、按范围验证、合成数据与研究约定。
- [PR 模板](../../.github/pull_request_template.md)：问题、变化、实际验证、未覆盖内容。
- [问题表单](../../.github/ISSUE_TEMPLATE/bug_report.yml)与[功能建议](../../.github/ISSUE_TEMPLATE/feature_request.yml)：收集版本/环境、复现和需求，避免要求报告者先完成完整测试；保留空白 Issue。
- [安全报告](../../SECURITY.md)：登录 GitHub，通过私密漏洞报告提交项目漏洞，不公开敏感细节。
- [行为准则](../../CODE_OF_CONDUCT.md)与[维护者说明](../../MAINTAINERS.md)：交流边界、处理方式、当前维护责任、评审、分支和发布约定。

行为准则为项目原创文案。GitHub 官方滥用举报由平台受理；当前没有独立的私密社区联系邮箱，不把漏洞表单作为一般纠纷处理入口。

## 仓库配置核对

GitHub 私密漏洞报告由未启用改为启用，PUT 返回 204，再次 GET 返回 `enabled: true`。未提交测试漏洞，入口需要 GitHub 登录。此功能与 secret scanning 不同，后者仍为 disabled；此前[公开内容检查](../releases/public-content-review-2026-10-01.md)的扫描范围不因此扩大。

核对时 `main` 的 `protected` 为 false，仓库规则集为空。本文和维护指南中的评审要求是协作约定，尚未转成 GitHub 强制保护；后续配置需匹配实际审阅人员和检查名称。

GitHub Issue 表单及配置需进入默认分支 `main` 后才对外显示，本轮采用一次集中阶段 PR 同步 OSS-03～06，不为每个文档建立独立分支。依据见 [GitHub 模板配置说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。

## 旧 PR 与分支核对

核对基线：`origin/main = 8e1692ae6e2df911e8e02dd3b05297a497265380`，`origin/develop = 609c5add0564e1580a9739009bb83f967dd18d85`。已刷新远端引用，并逐项使用 `git merge-base --is-ancestor` 验证提交包含关系。

- 21 个旧分支的头提交均为 `main`、`develop` 的祖先；本地与远端同名分支头一致，没有旧分支被其他 worktree 占用。
- 其中 PR #1 已合并；其余 20 个均为 `wolfhawkld` 创建的 OPEN 草稿，PR 头与分支头一致，工作已被 [PR #37](https://github.com/wolfhawkld/living-memory/pull/37) 的阶段集成覆盖。
- 已关闭这 20 个已集成草稿；操作前再次核对了全部 PR 状态、作者、草稿标记和远端头。没有发表评论。旧分支不再承接日常迭代，本轮保留引用；未删除分支或重写 Git 历史。

下表记录可复核的完整 SHA 与处理后的状态。

| 退役分支 | 完整头提交 | 关联 PR |
| --- | --- | --- |
| `docs/iteration-todo-20260922` | `54a48eece9a9f0f429afa3011c86e777f3c97fe5` | [#13](https://github.com/wolfhawkld/living-memory/pull/13)：已集成，草稿已关闭 |
| `docs/light-theme-todo` | `28367e7e5eede46e35c1055431d8a16bb36d7432` | [#28](https://github.com/wolfhawkld/living-memory/pull/28)：已集成，草稿已关闭 |
| `docs/v0.1-memory-design` | `fe3f3fc1e78330ac2e762eba102fe4343a50fa6d` | [#1](https://github.com/wolfhawkld/living-memory/pull/1)：已合并 |
| `feat/concept-history` | `a93de16475dea95dd1976c775d155cf70e5d1903` | [#15](https://github.com/wolfhawkld/living-memory/pull/15)：已集成，草稿已关闭 |
| `feat/domain-views` | `be5eb184f254f53d8bec3cc9ffe87f873ac1b0b6` | [#6](https://github.com/wolfhawkld/living-memory/pull/6)：已集成，草稿已关闭 |
| `feat/idle-graph-rotation` | `258dcc06b3af23e60e76f8d138bf61dadc584892` | [#8](https://github.com/wolfhawkld/living-memory/pull/8)：已集成，草稿已关闭 |
| `feat/kg-cli-triggers` | `cbeaab634dfa1e13a5a44cb0b361c45a70363171` | [#4](https://github.com/wolfhawkld/living-memory/pull/4)：已集成，草稿已关闭 |
| `feat/markdown-reader` | `4e38a349db8c771a57cb53363ee25b3f12ccd2e2` | [#17](https://github.com/wolfhawkld/living-memory/pull/17)：已集成，草稿已关闭 |
| `feat/p0-time-prototype` | `cf9f53dd32e505773576d1fb1fcedb870e65727a` | [#2](https://github.com/wolfhawkld/living-memory/pull/2)：已集成，草稿已关闭 |
| `feat/reader-media` | `dd56c0d4dcf033b29e4f591787760b694e6a5d12` | [#19](https://github.com/wolfhawkld/living-memory/pull/19)：已集成，草稿已关闭 |
| `feat/scenario-confidence-retention` | `9866a9b94bc4d16b92ec6c0df91fe755770d7d5b` | [#23](https://github.com/wolfhawkld/living-memory/pull/23)：已集成，草稿已关闭 |
| `feat/theme-graph` | `985edb11afe6018f295bf75ca708614636075eda` | [#36](https://github.com/wolfhawkld/living-memory/pull/36)：已集成，草稿已关闭 |
| `feat/theme-palette` | `1e668ec0e534204ddaae6007b6b84f68946fa540` | [#30](https://github.com/wolfhawkld/living-memory/pull/30)：已集成，草稿已关闭 |
| `feat/theme-preferences` | `872e73ea3b398282942afb7d997f4bc08922591b` | [#32](https://github.com/wolfhawkld/living-memory/pull/32)：已集成，草稿已关闭 |
| `feat/theme-workspace` | `edc3a521c89ce1b2f0021689323d77faf25c38ef` | [#34](https://github.com/wolfhawkld/living-memory/pull/34)：已集成，草稿已关闭 |
| `feat/user-domain-access` | `29160b2838f8fbe0d642a69a850b890b6452aeb2` | [#25](https://github.com/wolfhawkld/living-memory/pull/25)：已集成，草稿已关闭 |
| `fix/2d-graph-view` | `3bea3936535fb8a08c447c8fd5e278b681885090` | [#12](https://github.com/wolfhawkld/living-memory/pull/12)：已集成，草稿已关闭 |
| `fix/isolated-node-layout` | `72b7abde8272b2ba3cf10a383a0319bf98dba6bc` | [#27](https://github.com/wolfhawkld/living-memory/pull/27)：已集成，草稿已关闭 |
| `fix/knowledge-reference-links` | `9e261a6bd75aea387d8da7ca084399d904fa58bf` | [#21](https://github.com/wolfhawkld/living-memory/pull/21)：已集成，草稿已关闭 |
| `fix/pending-sync-feedback` | `398e763993a5a4cedb3932d2e5077b1331174a50` | [#10](https://github.com/wolfhawkld/living-memory/pull/10)：已集成，草稿已关闭 |
| `fix/view-mode-controls` | `1693ee4184972e22220b0a7e0b37ea5fb1e3c21e` | [#11](https://github.com/wolfhawkld/living-memory/pull/11)：已集成，草稿已关闭 |

## 验证与阶段集成

本地验证：9 份变更 Markdown 的 117 个相对链接目标均存在，差异格式检查通过；三个 YAML 可解析，问题表单 8 个字段、功能建议 7 个字段的 ID 唯一，必填和联系入口配置符合表单结构。保留空白 Issue，不依赖尚未创建的标签。未重复运行应用测试或启动本地浏览器。

已重新查询开放 PR，旧草稿全部关闭。阶段集成与对应 CI 状态在完成后补充；此前提交 `609c5ad` 的 [CI 运行 36839138806](https://github.com/wolfhawkld/living-memory/actions/runs/36839138806) 全部通过，不把此前检查冒充新提交的结果。

贡献指南明确查询、阅读、生成和刷新不重置重温；回忆与曝光分开，表现不自动拟合 H，长期保持只本人手工解除，账号状态保持隔离。记忆模型变化仍需研究依据和数据兼容说明。

下一项为 **OSS-07：开发导览与首批协作任务**。本轮不创建正式预览 tag 或 release，仍按[发布清单](../releases/local-web-preview.md)接续。
