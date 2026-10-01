# 维护者与协作约定

当前确认的维护者为 **Damon Long / [@wolfhawkld](https://github.com/wolfhawkld)**，负责范围与记忆语义决策、评审、集成和发布。提交过代码或得到仓库写权限，不自动意味着加入维护者名单；新增维护者时更新本文并明确责任。普通反馈使用 [Issues](https://github.com/wolfhawkld/living-memory/issues)，漏洞走 [SECURITY.md](SECURITY.md) 的私密通道。

## 分支与集成

- `develop` 是长期开发分支。日常迭代继续沿用，不为每个小任务新建分支和 PR。
- `main` 是默认分支，保留已经验证的一组改动。阶段集成使用 `develop → main` 的集中 PR，保留 `develop`。
- 外部贡献通过 fork 和短期分支向 `develop` 提交 PR。多人并行或实验确实需要隔离时才建立额外分支，完成后收口。
- 先核对 PR 的具体问题、范围、数据兼容和相关验证，再合入；未完成的视觉、平台或学习效果验收单独记录。

GitHub Issue 表单从默认分支读取，因此贡献入口变更需随阶段集成进入 `main`。模板生效方式见 [GitHub 官方说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。

## 评审责任

维护者按改动范围核对 Node/HTTP 测试、构建、主题检查与 CI 浏览器回归，文档改动检查链接和格式即可。CI 软件渲染通过不代表目标 GPU 性能通过；人工视觉验收和真实记忆收益分别记录。当前仓库检查与分支保护配置以[实施记录](docs/development/collaboration-maintenance.md)为准，不把书面的评审要求当作已经启用的 GitHub 强制规则。

记忆规则、数据结构和账号边界变化需要说明研究依据、证据范围及历史记录兼容。浏览、查询、生成和刷新不自动确认重温；资料曝光与独立回忆分开；长期保持只有本人手动解除。详情见[贡献指南](CONTRIBUTING.md)。

维护者定期查看仓库的私密漏洞报告，并核对自己的 GitHub 安全通知偏好；启用入口和处理报告是分别需要完成的维护工作。

有争议的范围先在相关 Issue/PR 记录理由，维护者结合证据作出决定。行为处理遵守[行为准则](CODE_OF_CONDUCT.md)，不公开私人证据；漏洞修复按[安全报告](SECURITY.md)协调。

## 旧 PR 与分支收口

只有确认旧 PR 的头提交已被 `main` 和 `develop` 包含、对应分支没有新提交时，才关闭被阶段集成覆盖的旧 PR。关闭不是丢弃尚未合入的工作，也不需要重复合并同一批提交。

删除旧分支前应记录分支名与完整 SHA，确认没有其他 PR、工作树或协作者依赖，并复核远端 tip 未变化；不使用强推或强制本地删除来替代检查。长期 `main`、`develop` 始终保留，已合入的 Git 历史不重写。本次核对结果及实际处理见[协作实施记录](docs/development/collaboration-maintenance.md)。

## 发布与维护文档

正式预览仍按[发布清单](docs/releases/local-web-preview.md)完成版本、检查和数据备份说明，再创建 tag/release；阶段合并本身不等于发布。仅分发源码时遵守项目 MIT，未来附带构建产物或运行时需按[第三方许可检查](docs/releases/third-party-licenses.md)保存上游许可。

任务完成或范围变化时更新相应 TODO、使用说明和验证记录。公开材料使用合成内容，不将个人知识库、账号、会话或学习数据库加入仓库。
