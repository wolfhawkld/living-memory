# 飞书接入：官方协议核实与离线探针

日期：2026-10-02。对应 NEXT-06 / FEISHU-01。本文记录 FEISHU-01 首轮合成离线协议验证。后续 FEISHU-01B 已实现[默认关闭的官方 SDK 连接器基础](feishu-connector.md)，FEISHU-01C 已实现[Web 发码与本人私聊确认的账号绑定](feishu-account-binding.md)，FEISHU-02A 已补齐[私聊文本列表与阅读](feishu-knowledge-reading.md)。真实飞书应用与往返仍待验证，点击式浏览、待复习视图及复习写回尚未实现。

## 运行离线探针

完成项目依赖安装后运行：

```bash
npm run feishu:probe:offline
```

命令构造一张明显标为离线测试的 V2 卡片，检查固定的合成按钮事件、身份范围与错误上下文；重复同一事件时复用本进程的离线协议回执。输出 JSON 包含合成卡片和用例结果，可查看协议形状，但不是一张已投递到飞书、可在真实聊天窗操作的卡片。

输出明确标识 `mode: offline`、`platformVerified: false`、`authentication: not-performed`、`knowledgeAccessed: false`、`learningWrites: 0`。这是程序的离线执行边界声明，不是飞书平台实测报告。离线探针的执行路径没有网络、SDK、私人文件或学习服务调用；不读取 Hermes 任务、凭证或个人知识。命令仅支持无参数运行和 `--help`，拒绝发送、联网、文件或凭证参数，也不回显参数值。

定向检查：

```bash
npx --no-install tsx --test tests/feishu-protocol.test.ts tests/feishu-probe-offline.test.ts
```

## 选定的后续接入架构

首选：自建应用机器人私聊、V2 交互卡片、与项目服务同机运行的官方 Node SDK 长连接。自建应用是项目首版范围选择，不写成平台仅支持此类型。首轮离线交付未新增 SDK 依赖或启动真实连接器；后续 FEISHU-01B 已固定 SDK 1.74.0 并实现默认关闭的 transport，发布包证据及接线边界见[连接器说明](feishu-connector.md)。真实目标应用尚未连接验收。

既有 Hermes 学术英文任务提供 REST 文本投递的参考。卡片按钮属于另一条事件路径，需要验证实际订阅 / 回调接线，不能由“已有文本推送”推断按钮可以写回。长连接方案用于评估本机向外连接接收事件，现有 HTTP 服务继续只监听回环地址；实际应用配置与飞书客户端往返仍须验证。

后续连接器复用项目内部按用户授权的知识与记录服务，不用管理员 owner 设备凭据代替成员授权，不复制学习数据库。正式绑定按 `(appId, tenantKey, openId)` 对应既有账号 UUID；应由当前 Web 已认证账号发起短期一次性绑定，再由飞书本人确认。合成映射不是生产账号绑定。

正式启用前确认同一应用的事件接收方。官方 SDK 长连接对同一应用的多个客户端随机选择单一消费者，需避免与既有 OpenClaw / Hermes 接收器竞争；可以单独使用 Living Memory 应用，也可以在确认既有接收器职责后整合。不要擅自改变原应用回调模式或订阅。

## 协议模块的边界

| 接口 | 本轮行为 |
| --- | --- |
| `buildOfflineProbeCard` | 构造 schema `2.0` 的合成卡片，按钮使用 `behaviors: [{ type: callback, value: ... }]`；值只包含探针类型和探针 ID，没有知识答案或账号权限 |
| `normalizeFeishuCardAction` | 校验原始 schema envelope 的事件类型、应用、租户、操作者、消息 / 聊天上下文与按钮值，返回必要字段；畸形输入固定拒绝，不输出原始载荷 |
| `resolveSyntheticBinding` | 仅从测试用合成绑定按应用 / 租户 / 操作者三元组查找启用账号；不接受按钮值中的账号或知识空间声明 |
| `evaluateOfflineProbeAction` | 核对预期探针、操作者、聊天与消息，返回离线协议确认和 toast 形状；不展示知识或保存学习事件 |

结构校验不是鉴权。这个模块不能直接接到公开 HTTP 请求上；未来必须由经过认证的官方 transport 提供事件。官方 SDK handler 会平铺 `header` 与 `event`，离线模块仅接受原始 schema envelope；FEISHU-01B 另设适配器接收 SDK 平铺输入，两者不能混用。不能直接注册这个纯函数并宣称已经安全接入。

重复回调示例只是进程内协议回执复用：没有生产持久会话、投递 outbox 或学习事件写入。正式生产的回执 / 幂等 / 并发边界仍待设计实施。本轮只产生 toast 确认形状；重工作与卡片更新的异步处理留给真实连接器。

## 官方证据与文档差异

核对固定官方源码，避免只引用会变动的默认分支。相关代码作为研究参考，没有复制 SDK 源码到项目：

- [V2 卡片按钮示例](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/docs/channel.zh.md#L272)：V2 按钮使用 `behaviors` 回调值。
- [卡片事件归一化字段](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/channel/normalize/card-action.ts#L3)与 [SDK handler 平铺转换](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/dispatcher/request-handle.ts#L49)：确认所需身份 / 上下文字段以及原始事件与 handler 输入的区别。
- [官方 Channel 长连接接线](https://github.com/larksuite/channel-sdk-node/blob/ecdec28389a96b2cf668766b6d110fb24c8610f5/src/channel.ts#L372)与 [卡片事件响应路径](https://github.com/larksuite/channel-sdk-node/blob/ecdec28389a96b2cf668766b6d110fb24c8610f5/src/channel.ts#L1201)：新官方实现包含 WSClient / EventDispatcher / `card.action.trigger`。
- [即时响应与异步任务说明](https://github.com/larksuite/channel-sdk-node/blob/ecdec28389a96b2cf668766b6d110fb24c8610f5/README.zh.md#L172)：先快速返回卡片回调响应，重任务异步处理。

旧 Node SDK README 的长连接段仍有“不支持 callback”的说明，与新官方模块及 Channel 示例不一致。本项目依据新实现选择长连接作为后续首选，但固定源码和离线测试不能代替目标应用的真实按钮往返；启用前必须核对所选 SDK 版本及实际应用配置。

## 真正接入前的最小待验清单

- [ ] 确定复用或新建的飞书应用及事件接收方，确认配置 / 发布权限；应用凭据只保留服务端。
- [x] FEISHU-01B 固定 SDK 1.74.0 并核对发布包契约，建立默认关闭的 transport；见[连接器说明](feishu-connector.md)。
- [ ] 开启所需机器人消息与卡片交互能力，核对真实应用权限、订阅、发布及应用可用范围。
- [x] FEISHU-01C 实现账号的一次性绑定软件链；未绑定 / 停用 / 撤销后不能解析为有效账号，不能复用 owner 身份跨账号读取。真实私聊确认仍待验，见[说明](feishu-account-binding.md)。
- [ ] 使用明确授权的合成内容，真实点击后在平台要求的时限内收到回执；记录断线、重复与错误上下文行为。未完成此项，不标为真实飞书接入可用。
- [ ] 继续 FEISHU-02 的排序列表 / 阅读，再做 FEISHU-03 的卡片回忆、独立确认重温、会话持久化及失败恢复。

本机需在线才能处理聊天卡片交互。复杂阅读页在 HTTPS 可达性落实前，不承诺手机可打开桌面本机 Web 地址。真实客户端视觉、手机体验与记忆效果由本人验证；本轮不运行本地浏览器或向真实聊天窗发测试消息。

## 检查记录

2026-10-02：两个定向测试文件直接执行，分别 7 / 7 与 3 / 3 通过；`npm run feishu:probe:offline` 的 11 / 11 合成用例通过；`npm test` 的 584 / 584 完整 Node / HTTP 测试通过，`npm run build` 通过。构建仍有既有图谱 / 阅读包大小及 Vite 配置加载提示，本轮没有改这些模块。

使用同一项目包边界、同一 `tsx --test` 入口的隔离合成失败样例，确认真实断言失败返回退出码 1 和命名的 `ERR_ASSERTION`，避免把仅文件级成功输出误当完整验证；样例执行后移除，未修改测试基础设施。

最终架构审查通过，未发现必须修复的问题。通过范围仅为 FEISHU-01 首轮离线交付；后续 FEISHU-01B 已新增默认关闭的 SDK 连接器基础，FEISHU-01C 已实现一次性账号绑定，FEISHU-02A 已补齐[文本知识阅读的软件链](feishu-knowledge-reading.md)。应用权限 / 发布、真实消息或按钮往返与客户端体验待实际验证。FEISHU-02B / 03 / 04 仍待开发，不用软件检查替代真实飞书验收。
