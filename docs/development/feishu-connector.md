# 飞书连接器基础：默认关闭的官方 SDK 长连接

日期：2026-10-02。对应 NEXT-06 / FEISHU-01B。已实现官方 SDK transport、配置校验、卡片事件投影及服务生命周期接线；默认关闭。FEISHU-01C 已补齐[一次性身份绑定](feishu-account-binding.md)，FEISHU-02A 已实现[私聊文本列表与阅读](feishu-knowledge-reading.md)。FEISHU-02B 已实现[知识卡片与待复习查看](feishu-card-browsing.md)。真实应用发布、连接与私聊 / 按钮往返尚未验收；当前不保存飞书学习记录。

此前的[离线探针](feishu-offline-probe.md)继续独立运行，其执行路径不加载 SDK、不联网。任务拆分见[飞书通道 TODO](../planning/feishu-review-channel-todo-2026-10-02.md)。

## 配置与启用条件

连接器读取服务端传入的环境变量：

| 变量 | 行为 |
| --- | --- |
| `LM_FEISHU_ENABLED` | 缺省或精确字符串 `0` 关闭，并忽略其余飞书配置；只有精确字符串 `1` 启用。其他值返回 `invalid-enabled` |
| `LM_FEISHU_APP_ID` | 启用时必填，去除首尾空白后必须符合 `cli_` 加 16 位十六进制字符（`/^cli_[0-9a-fA-F]{16}$/`）；原始长度最多 256，空白、超长或格式非法返回 `invalid-app-id` |
| `LM_FEISHU_APP_SECRET` | 启用时必填，原样交给 SDK，不自动 trim；原始长度最多 4096，纯空白或非法值返回 `invalid-app-secret` |
| `LM_FEISHU_TENANT_KEY` | 启用时必填，去除首尾空白；原始长度最多 256，空白或非法值返回 `invalid-tenant-key` |
| `LM_FEISHU_TIME_ZONE` | 缺省 `UTC`；启用时校验长度最多 128 的有效时区。按此自然日读取已落库复习完成数，非法返回 `invalid-time-zone`；例如 `Asia/Shanghai` |

凭据只保留服务端，不写入卡片、前端或状态日志。配置错误仅暴露固定 code，连接器失败不阻止本机 HTTP 服务提供既有功能。缺省关闭时不加载 SDK、不启动网络连接。当前交付没有设置这些变量、启用连接器或重启个人服务。

未来真实启用前，需要具有配置 / 发布权限的应用、所需机器人和卡片交互能力，以及已核对的事件接收归属。对同一 app 的多个官方长连接客户端，事件随机交给其中一个消费者；应使用独立 Living Memory 应用，或先确认既有 consumer 的职责。不能把能发送 REST 文本消息当作已能接收按钮事件。本轮没有改变 Hermes / OpenClaw、应用订阅或发送真实消息。

## 生命周期与状态

服务完成 HTTP 监听后才启动连接器。可观察状态为 `disabled`、`starting`、`connected`、`reconnecting`、`error`、`stopped`；状态输出只包含固定状态及可选错误 code，不输出 SDK 错误对象、应用 / 用户标识或凭据。

`start()` 返回只说明 SDK 已安排启动，不代表握手或平台连接成功。只有官方 SDK 的 `onReady` 或 `onReconnected` 才把状态更新为 `connected`；握手超时固定为 15 秒，重连由 SDK 管理。连接错误、初始化失败和启动失败分别使用 `sdk-connection-error`、`sdk-init-failed`、`sdk-start-failed`。启动抛错后关闭该 driver 一次并忽略迟到回调，同一连接器实例停止后不再启动。

服务停止时关闭 WebSocket 并清理 SDK 重连定时器；停止后迟到回调不能重新标为 connected。关闭失败使用 `sdk-stop-failed`。FEISHU-02A 会等待已接纳的知识处理记录终态，随后生命周期关闭数据库；已经发出的 HTTP 请求不能撤回，详见阅读说明。

SDK dispatcher、WSClient 与文本 / 卡片发送 Client 的 `error`、`warn`、`info`、`debug`、`trace` 五个日志方法全部禁用，避免 SDK 输出 ticket、凭据、事件正文或异常对象。

## 当前卡片处理边界

注册 `card.action.trigger` 和 `im.message.receive_v1`。后者投影本人私聊绑定指令及知识查看指令，分别进入狭窄的账号确认与只读知识能力；详细身份与一次性请求约束见[账号绑定说明](feishu-account-binding.md)。卡片路径如下。内部适配函数接收经过官方 WebSocket transport 的 SDK handler 平铺输入，校验 `event_type`、`event_id`、`app_id`、`tenant_key`、`operator.open_id`、可选 `operator.tenant_key`、`context.open_message_id` / `open_chat_id` 和 `action.tag = button`。应用及租户必须与服务端配置一致，operator 租户如存在也必须一致；必要字符串为空、类型错误或长度超过 256 时拒绝。SDK 平铺输入保留的 `schema: "2.0"` 可接受，缺省 schema 也兼容接受；其他 schema 值及嵌套 header / event 拒绝。原始 schema envelope 不能直接传给此适配器。

基础身份适配成功只投影 `eventId`、`appId`、`tenantKey`、`openId`、`messageId`、`chatId` 六个字段。`token`、正文、元数据及权限声明均丢弃，该基础身份适配不读取 `action.value`；其中的 accountId、sourceId、用户名或 owner 声明不能决定账号。结构校验本身不提供平台鉴权或账号授权，此函数只能在已认证官方 WS transport 内部使用，不能挂公开 HTTP 路由。

FEISHU-02B 在基础身份适配后增加独立导航适配，只接受 `action.value` 中精确的 `kind = lm.nav.v1`、32 位小写十六进制 `cardId` 与 `a0`～`a15` 的 `actionId` 三个字段。按钮没有账号或来源权限声明，实际目标视图由服务器卡片 metadata 查找。

结构有效且通过进程接纳限制的导航先返回 info toast「已收到操作；无新卡时请发送『知识 卡片』。」；异步能力再核验当前账号 / 绑定、平台聊天及消息上下文、卡片 TTL 与资料指纹，向同一 openId 发新卡。toast 不表示授权或发送成功，旧卡 / 重复 / 过期操作可能无新卡。其他卡片事件返回固定拒绝或尚未接入提示，不进入学习写入。

FEISHU-02A 文本入口保持只读，FEISHU-02B 增加点击式列表、正文分页与待复习查看；详情见[卡片说明](feishu-card-browsing.md)。默认关闭，真实按钮往返仍待人工验收。

## 固定版本与证据

生产依赖固定为 `@larksuiteoapi/node-sdk@1.74.0`，版本、tarball URL 与完整性值记录在 [`package-lock.json`](../../package-lock.json)。本轮契约核对依据实际 npm 发布包：[固定 npm tarball](https://registry.npmjs.org/@larksuiteoapi/node-sdk/-/node-sdk-1.74.0.tgz)，包括 SDK handler 平铺转换、WSClient 生命周期回调及关闭行为；没有把未核验的 GitHub tag 当作该发布版本证据。包根 `LICENSE` 与 `package.json` 声明 MIT，分发边界见[第三方许可记录](../releases/third-party-licenses.md)。

旧 README 的 callback 限制说明与较新的卡片事件路径有差异，历史研究见[离线说明](feishu-offline-probe.md#官方证据与文档差异)。发布包核对和注入 driver 测试仍不能代替目标应用的真实握手、权限 / 发布和按钮往返验收。

## 自动检查与后续进展

FEISHU-01B 使用合成事件和注入 driver 验证配置、应用 / 租户隔离、字段投影、固定 toast、日志禁用、readiness、重连及停止边界。另以真实 SDK 的 EventDispatcher 离线验证原始 V2 envelope 转换为保留 schema 的平铺输入，随后进入连接器并返回固定 toast；该测试不构造 WSClient，`needCheck: false` 只验证解析结构，不提供鉴权证据。

FEISHU-01B 新增配置 7 个、事件 8 个、连接器 14 个、SDK adapter 7 个、服务生命周期 6 个命名测试。完整 `npm test` 的 626 个用例及 `npm run build`（类型检查与生产构建）通过。不把软件检查解释为真实飞书接入成功；提交后 CI 另行核对。

FEISHU-01B 最终架构审查通过，范围仅为 默认关闭的连接器基础。发布包事件转换、应用 ID 校验、启动失败清理和服务停机顺序均已复核；没有把真实连接或账号绑定标为完成。

FEISHU-01C 已按 `(appId, tenantKey, openId)` 关联现有账号 UUID：已认证 Web 账号发起一次性请求，飞书本人发送私聊指令确认，补齐过期、重复、停用与撤销边界；全软件链已实现，真实平台验收待进行。该轮完整软件检查与最终审查结果在[账号绑定说明](feishu-account-binding.md)补记，不沿用上一轮 626 项数字。FEISHU-02A 文本列表 / 阅读的软件链已补齐，FEISHU-02B 点击式列表 / 正文分页与待复习查看的软件链已实现，随后是 FEISHU-03 卡片复习 / 共用记录和 FEISHU-04 失败恢复与真实客户端集中验收。
