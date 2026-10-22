# Yjs 性能基线（任务 3.8 / 9.4）

## 单元层基线（任务 3.8）

由 `src/atomicity.test.ts` 的「基线」用例测量（`pnpm -C web/packages/woohaa3-canvas-yjs test`），
用 100 个节点、分 100 个命令提交（模拟真实编辑节奏）。

| 指标 | 数值 |
| --- | --- |
| 100 次命令提交总耗时 | ~45 ms |
| 100 个 update 的累计字节 | ~26.6 KB |
| 恢复（checkpoint + 100 updates → Y.Doc → 导出） | ~11 ms |
| 压缩（`Y.encodeStateAsUpdate` + 替换 checkpoint） | ~39 ms |
| 压缩后 checkpoint 字节 | ~10.6 KB |

## 端到端基线（任务 9.4）

由 `e2e/yjs-perf.spec.ts` 测量真实 **WebSocket + room + 持久化** 链路
（`pnpm -C web exec playwright test -c playwright.yjs.config.ts`）：

| 指标 | 数值 | 样本 |
| --- | --- | --- |
| 初始 sync 耗时 | ~21 ms | 100 节点画布，空 state vector |
| 初始 sync 字节 | ~34.5 KB | 同上 |
| 20 次单节点命令的增量字节 | ~10.4 KB | 每次约 520 B |
| 命令延迟 p95 | ~37 ms | 20 次单节点命令 |
| 重连恢复耗时 | ~21 ms | 新连接 + 当前 state vector |

## 由此得到的默认阈值建议

| 阈值 | 建议值 | 依据 |
| --- | --- | --- |
| `maxUpdates`（触发压缩） | 500 | 100 updates ≈ 26 KB；压缩约 40 ms/100 节点 |
| `maxBytes`（触发压缩） | 4 MiB | 远高于 100 节点样本，避免小画布频繁压缩 |
| 单条消息上限 | 1 MiB | 单条命令 update 实测为数百字节量级 |
| 单文档上限 | 64 MiB | 大画布安全上限，超过应评估分片/CRDT 策略 |
| 命令速率上限 | 600/10s | 远高于正常编辑节奏，拦截异常客户端 |

`shouldCompact()` 同时按数量与字节判定，任一超限即压缩。

## 结论

- 压缩后 checkpoint（10.6 KB）**小于**累加 update（26.6 KB）：增量有重复开销，压缩确实回收空间。
- 端到端初始 sync 与重连均在**毫秒级**（100 节点），不需要额外缓存层。
- 命令 p95 约 37 ms，主要是持久化往返；`COMMAND_RESULT` 在 durable 之后才返回，这是设计代价。
- 这些是**环境相关**基线：CI 会更慢，因此测试断言用宽松上限，只拦截数量级回归。

## 与媒体边界的关系

存储内只有 Yjs update 与 JSON projection；测试断言 projection 序列化后不含
`blob:`、`base64` 或 `X-Amz-Signature`，确认媒体 bytes 仍只在 COS。
