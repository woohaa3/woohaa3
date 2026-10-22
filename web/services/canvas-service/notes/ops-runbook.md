# 协作同步运维 Runbook（任务 8.7）

适用 capability：`canvas-sync`（change: add-yjs-canvas-sync）。

## 0. 前置与不变量（读这节再动手）

- **前置 change 必须已归档**：`add-canvas-backend-storage`（画布存储、COS 边界、归档工具）。
- **同一 canvas 任意时刻只有一个 writer 模式**：`remote-cas` 或 `yjs`。绝不允许两者并行写。
- **首版只支持单应用实例**：协作 writer lock 是硬约束，抢不到锁的实例 readiness 失败。
- **COS 仍是唯一二进制持久层**：checkpoint/update/cache/archive 都不含媒体 bytes。
- **两种版本语义分工**：业务 `revision`（对外）与存储 `updateSeq`（内部恢复顺序）。

## 1. 部署形态

| 项 | SQLite profile | Mongo profile |
| --- | --- | --- |
| 数据库 | 单文件（含 WAL） | replica set / sharded（**必须支持事务**） |
| 协作实例数 | **1** | **1**（多实例需独立 room ownership capability） |
| 表/collection | `canvas_yjs_documents` / `canvas_yjs_updates` / `canvas_yjs_commands` | 同名 collection |
| 媒体 | COS | COS |

启动配置（服务端环境变量，见 `web/services/canvas-service/.env.example`）：

```
WOOHAA3_CANVAS_STORAGE_BACKEND=sqlite|mongo
WOOHAA3_CANVAS_STORAGE_SQLITE_PATH=...        # sqlite
MONGODB_URI=... MONGODB_DB=...                # mongo
COS_*                                         # 必需
```

**fail-fast**：未知 backend、缺数据库配置、缺 COS 配置均在监听前失败，不存在内存/本地回退。

## 2. 健康检查

```bash
curl -sS localhost:PORT/api/canvas-storage/health/live    # 不触碰依赖
curl -sS localhost:PORT/api/canvas-storage/health/ready   # 数据库 + COS + writer lock
```

readiness 失败时必须排查：

| reason 关键词 | 含义 | 处置 |
| --- | --- | --- |
| `存储不可用` | 数据库连接/事务探测失败 | 检查数据库可达性与事务能力（Mongo standalone 不支持事务） |
| `writer lock` | 另一实例持有协作锁 | **不要**强抢；确认旧实例已退出，或在同一实例上重启 |
| `媒体存储` | COS read/write probe 失败 | 检查 `COS_*` 与 bucket 权限 |

## 3. 单画布切换到 yjs 模式

前置：该 canvas 的 IndexedDB outbox **必须已排空**（未确认操作不得转成 raw Yjs update）。

```bash
# 1) 确认 outbox 已空（客户端侧）
#    浏览器 DevTools：IndexedDB woohaa3-canvas → outbox 应无该 canvasId 记录。

# 2) 执行切换（内部调用 migrateCanvasToYjs）
#    成功后：syncMode=yjs、roomEpoch 更新、/commands 返回 mode-moved
node scripts/canvas-storage.mjs health          # 确认 readiness

# 3) 客户端销毁旧 Store，从空 Y.Doc 或只读 cache 重新 sync
```

失败处置：`migrateCanvasToYjs` 失败时 canvas **留在 remote-cas**，可安全重试。
若失败原因是 `checkpoint-init-failed`，只会多一个未启用的 Yjs 文档，不影响旧写入方。

## 4. 回滚（yjs → remote-cas）

**必须按顺序**，不能只靠前端 feature flag：

1. 服务端把该 canvas 的 room 置**只读**并断开全部同步连接。
2. 导出最新 published Y.Doc 为规范 `ServerCanvas`。
3. 调用 `rollbackCanvasToRemoteCas`：先写回 JSON，再切 `syncMode=remote-cas`。
4. 客户端丢弃 Yjs cache，重新 `hydrate`。

失败处置：导出或写回失败时模式**保持 yjs**，room 仍持有权威状态，可重试。
绝不先切模式再导出（会造成「模式是 remote-cas 但 JSON 未更新」的丢数据状态）。

## 5. 备份与恢复

### 结构化画布（前置能力）

```bash
node scripts/canvas-storage.mjs export --out backup/canvases.json
node scripts/canvas-storage.mjs verify --in backup/canvases.json
```

### Yjs 状态（本 change 扩展）

Yjs 段包含：checkpoint（base64 + SHA-256）、format、roomEpoch、ordered updates（含 checksum）
与命令幂等记录。校验会拒绝 checksum 不一致、格式不匹配，以及包含签名 URL/blob/`data:` 的段。

```bash
# 导出（脚本入口见 §8；核心 API 为 exportYjsArchive）
# 校验
#   verifyYjsArchive(section) → { ok, recordCount, updateCount }
# 恢复
#   restoreYjsArchive(repository, section) → 恢复后 storageSeq/updates/命令记录与源一致
```

**恢复演练要求**（SQLite 与 Mongo 各一次）：

1. 在临时环境用同一份归档恢复。
2. 跑 `YjsDocumentRepository` contract suite。
3. 抽检 COS 引用；缺失媒体必须报告失败，不得伪装完整恢复。

## 6. 故障处置

| 症状 | 可能原因 | 处置 |
| --- | --- | --- |
| room 进入 `quarantined` | checkpoint/update 损坏、checksum 不匹配、seq 非单调 | **不要**清空重建；用归档恢复或人工导出。room 已自动拒绝写入 |
| 命令返回 `storage-seq-conflict` | 存储 sequence 被并发 writer 改变 | 检查是否有第二个实例；重试同一 `commandId` |
| 命令返回 `command-id-reused` | 同 ID 不同 payload | 客户端 bug；检查 commandId 生成逻辑 |
| 客户端一直 `offline-readonly` | 连接断开或 room 隔离 | 查 readiness 与日志（`room-quarantined` 事件） |
| 任务结果未进画布 | projector 失败（未标 receipt） | 观察 `projection-failed` 事件；**不会**重跑 provider，补偿扫描重试同一 projectionId |

## 7. 日志与指标

日志只允许白名单字段（`sanitizeSyncLogEvent`）：`event/status/canvasId/revision/bytes/latencyMs/commandId/code`。
**绝不**记录 prompt、Yjs bytes、签名 URL 或凭据。

关键指标（`collectYjsMetrics` + `YjsMetricsCounters`）：

- `activeRooms` / `activeConnections`
- `syncBytes`、`commandLatency_count` / `commandLatency_avgMs`
- `commandRejected`、`roomQuarantined`、`checkpointCompacted`

告警建议：`commandRejected` 持续增长、`roomQuarantined > 0`、`activeConnections` 触顶。

## 8. 灰度切换

1. 先在测试 canvas 完成 remote-cas → yjs 切换，验证双客户端收敛与 Godot hydrate。
2. 观测 sync latency、command reject、update bytes、checkpoint time、Godot recovery。
3. 指标稳定后按 canvas 扩大范围。
4. 每个 canvas 切换前确认：outbox 已排空、无进行中的 CAS 写入。

## 9. 已知限制

- **多实例不支持**：writer lock 抢不到即 readiness 失败，这是设计而非缺陷。
- **断线只读**：首版无离线编辑；重连只发 state vector。
- **浏览器不得上传 raw Yjs update**：所有持久化必须走语义命令（协议会拒绝并关闭连接）。
- **Godot 不连接 Yjs**：仍是 Web → Godot 帧投影的下游。
