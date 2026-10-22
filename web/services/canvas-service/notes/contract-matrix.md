# SQLite / Mongo 一致性测试矩阵（任务 1.3）

所有 adapter 必须通过同一份可复用 contract suite（`src/contract-suite.ts`）。
SQLite adapter 必跑全套；Mongo adapter 在单元测试（内存 fake）与真实 replica-set 集成
测试中各跑一次。**同一份断言**是「两个 profile 行为一致」唯一可信的证明；任何 adapter
专有测试只补足该 adapter 的额外维度（迁移、连接、事务拓扑），不得放宽通用行为。

| # | 维度 | 断言位置 | SQLite | Mongo (fake) | Mongo (replica-set) |
| --- | --- | --- | --- | --- | --- |
| C1 | create → revision 1 → 读取 | contract: creates a canvas at revision 1 | ✅ | ✅ | ✅ |
| C2 | 重复 create 冲突且不覆盖 | contract: rejects duplicate create | ✅ | ✅ | ✅ |
| C3 | not-found 不返回空画布 | contract: returns not-found | ✅ | ✅ | ✅ |
| C4 | 单批命令恰好递增一次 revision | contract: increments revision exactly once | ✅ | ✅ | ✅ |
| C5 | 跨 node/nodeData/asset/job 原子提交 | contract: applies a batch atomically | ✅ | ✅ | ✅ |
| C6 | 后段非法 → 无部分状态（事务回滚） | contract: rejects a batch whose later command is invalid | ✅ | ✅ | ✅ |
| C7 | operationId 幂等重试返回首次结果 | contract: returns the first result for a duplicate operationId | ✅ | ✅ | ✅ |
| C8 | 跨画布 operationId 可复用 | contract: allows the same operationId on a different canvas | ✅ | ✅ | ✅ |
| C9 | CAS conflict 不应用命令 | contract: detects a concurrent revision conflict | ✅ | ✅ | ✅ |
| C10 | 空操作命令幂等且不递增 revision | contract: records an idempotent result for a no-op batch | ✅ | ✅ | ✅ |
| C11 | 列表稳定排序与分页 | contract: lists canvases with stable ordering | ✅ | ✅ | ✅ |
| C12 | 删除清理画布与 operation，不删 COS | contract: deletes a canvas with the matching revision | ✅ | ✅ | ✅ |
| C13 | 过期 revision 删除被拒 | contract: rejects delete with a stale revision | ✅ | ✅ | ✅ |
| C14 | health 报告稳定 backend id | contract: reports health with a stable backend id | ✅ | ✅ | ✅ |
| C15 | 命令数量上限在 adapter 之前拦截 | contract: enforces the configured command-count limit | ✅ | ✅ | ✅ |
| C16 | 重启后 revision / operation 幂等记录 / 资产 metadata 保持 | adapter 专有：SQLite 磁盘临时库重开；Mongo 新 client 重连 | ✅ | — | ✅ |
| C17 | MediaStorage 引用校验（不存在 / metadata 不符 / 临时 URL） | 核心测试 `asset-validation`；经应用服务注入真实存储 | ✅ | ✅ | ✅ |
| C18 | 底层错误映射为稳定 code（不泄漏路径/URI） | adapter 专有：只读库 / 锁 / 写失败 / schema 损坏 | ✅ | ✅ | — |

## 覆盖说明

- **事务回滚**由 C6 + C13 覆盖：C6 证明命令应用中段失败无部分写入，C13 证明 CAS 失败
  不写入。真实数据库 adapter 另用注入的写失败（C18）证明**底层**失败也回滚。
- **重启恢复**（C16）无法在进程内验证，必须是 adapter 专有测试：SQLite 用磁盘临时库
  关闭后重新打开；Mongo 用新 client 重连同一 replica set。
- **MediaStorage 引用校验**（C17）在核心层完成，不依赖数据库类型；adapter 测试通过注入
  同一 `MediaStorage` 复用。
- **错误映射**（C18）的断言目标是 `CanvasStorageError.code`，跨 bundle 按字符串比较，
  不使用 `instanceof`。
