# 安全报告

Living Memory 当前是桌面优先的本地 Web 原型。安全问题请私下报告，普通缺陷和功能建议通过 [Issues](https://github.com/wolfhawkld/living-memory/issues) 提交。

## 维护范围

目前关注 `main` 最近一次阶段集成和 `develop` 当前代码中的漏洞，尚无正式发布版或长期支持版本。旧实验分支不单独维护；修复进入 `develop`，验证后集中同步到 `main`。报告请注明分支和提交，不能只凭 `package.json` 的早期版本号识别代码。

服务默认只监听 `127.0.0.1`，账号与学习数据保存在本机；当前账号隔离不代表已经适合公网或多人在线部署。`LM_AUTH_MODE=local` 会关闭账号模式，只用于可信的本机环境。请按[新人运行指南](docs/development/first-run.md)使用和备份数据。

## 私下报告漏洞

登录 GitHub 后使用本仓库的[私密漏洞报告入口](https://github.com/wolfhawkld/living-memory/security/advisories/new)。该通道用于项目漏洞，由有权限的维护者查看；不要在公开 Issue、PR、日志或截图中披露尚未修复的漏洞细节。

报告尽量包含：

- 受影响的分支、提交、系统与 Node/浏览器版本。
- 可复现的步骤或最小合成示例，以及所需权限和配置。
- 预期与实际行为、影响范围，以及相关的脱敏错误信息。
- 如有，建议的防护或修复方法。

例如账号越权、知识根目录/附件越界、注入、未授权写入或凭据暴露均适合使用此通道。复现使用临时账号和合成数据，不上传真实密码、cookie、token、数据库、个人笔记或学习记录。测试他人的部署或数据需先获得授权。

维护者先核对与复现，再按影响确定修复范围，协调修复和公开说明。普通使用错误会转到合适的公开反馈范围，但不直接公开报告中的敏感材料。若实际凭据已泄露，请先撤销或轮换；仅删除文件中的内容不能撤销凭据。

## 其他反馈

社区行为问题按[行为准则](CODE_OF_CONDUCT.md)处理，私密漏洞入口不用于一般社区纠纷。维护责任和阶段集成流程见[维护者说明](MAINTAINERS.md)。

私密漏洞报告与 GitHub 的 secret scanning 是不同功能；当前配置和检查范围见[协作实施记录](docs/development/collaboration-maintenance.md)。报告入口与配置方式参考 [GitHub 官方说明](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
