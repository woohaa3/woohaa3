# Mongo 集成测试启用说明（任务 6.4 / 6.5）

Mongo profile 的**通用行为**（CRUD、CAS、幂等、事务回滚、依赖边界）已由
`src/index.test.ts` 配合内存 fake driver 跑通，且复用与 SQLite 完全相同的 contract suite
（`web/packages/woohaa3-canvas-storage/notes/contract-matrix.md` 的 C1–C15）。

## 单元层已覆盖

- `{canvasId, operationId}` 与 `{canvasId, resultRevision}` 唯一索引
- 两个独立 adapter 实例并发提交同一 revision → 只有一个成功，另一个 `REVISION_CONFLICT`
- 不同实例重复提交相同 `canvasId + operationId` → 只产生一份 operation、一次 revision
- 事务中途失败 → operation 与画布更新**全部回滚**，无部分写入
- 实际只使用 `canvases` / `canvas_operations` 两个 collection（无 GridFS / blob collection）

## 真实 replica-set 集成（默认跳过）

以下场景必须用**真实** Mongo 验证，无法由 fake driver 替代：

- 启动探测：连接、事务能力、索引建立（`MongoCanvasRepository.connect`）
- 真实并发：两个进程/实例对同一 replica set 的条件更新竞争
- 服务重启后 revision 与 operation 幂等记录保持

在 CI 或本地 replica set 上通过环境变量启用：

```bash
export MONGO_TEST_URI="mongodb://127.0.0.1:27017/?replicaSet=rs0"
export MONGO_TEST_DB="woohaa3_test"   # 可选，默认 woohaa3_test
pnpm -C web/packages/woohaa3-canvas-storage-mongo test
```

未设置 `MONGO_TEST_URI` 时对应测试**显式跳过**（测试文件中以「明确说明跳过（不静默通过）」
断言记录原因），不会伪装成通过。

## 本机启动最小 replica set（参考）

```bash
mongod --replSet rs0 --dbpath /tmp/woohaa3-mongo --bind_ip 127.0.0.1 --port 27017
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

`standalone` 拓扑**不满足**要求：`assertTransactionsSupported()` 会失败，服务拒绝进入
ready（spec「Mongo 不支持事务」）。
