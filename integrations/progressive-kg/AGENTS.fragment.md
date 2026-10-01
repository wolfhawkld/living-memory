<!-- living-memory:begin -->
## Living Memory 日常触发（本机可选集成）

若存在 `_system/living-memory.local.json`，在下列流程成功后调用收尾钩子：

- **Query**：已检索、阅读所需层级并合成有来源的回答；无匹配也可以结束查询。
- **Ingest / Consolidate**：实际修改完成，且已通过本库要求的 lint。仅提出建议或操作失败时不调用。

```bash
python3 _system/living_memory_hook.py query --operation-id <本次操作ID>
python3 _system/living_memory_hook.py ingest --operation-id <本次操作ID>
python3 _system/living_memory_hook.py consolidate --operation-id <本次操作ID>
```

只执行与本次流程相符的一条命令。每次新操作生成新 ID；同一次操作重试复用 ID。钩子从本地配置定位 Living Memory，核对知识根目录，并刷新当前加载范围内的节点、关系和时间状态。未配置的协作者可跳过。

查询、生成、资料呈现和系统读取都**不代表用户已经重温或掌握**。此钩子不得调用 `review`；用户明确确认重温时，另用 Living Memory CLI 或 Web 的确认入口。不得修改笔记的学习时间，或借此更新 `verified`、`maturity` 等内容字段。

刷新失败时保留已完成的知识操作和查询答案，说明“图谱刷新待恢复”，不要宣称已同步；服务恢复后重试同一命令。此集成依赖 Agent 遵循流程，不是自动监视所有文件修改的后台服务。
<!-- living-memory:end -->
