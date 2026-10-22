# 限制基线（任务 1.4）

由 `src/limits-baseline.test.ts` 用真实形态样本测量。运行：

```bash
pnpm -C web/packages/woohaa3-canvas-storage test
```

## 实测值

| 样本 | 规范 JSON 字节 | 说明 |
| --- | --- | --- |
| 空画布 | 271 B | 无节点、无边、无资产 |
| 含 1 个 COS 图片资产 + 2 节点 + 1 边 | 1,974 B | 完整 nodes/edges/nodeData/assets/jobs |
| 大型画布（100 节点 / 99 边 / 100 资产 / 50 份 nodeData） | 87,127 B | 典型大型项目上限量级 |

| 命令批次 | 数值 |
| --- | --- |
| 大型批次命令数 | 20（10 节点 + 10 资产） |
| 大型批次 JSON 字节 | 7,090 B |

## 由此确定的默认限制

`DEFAULT_CANVAS_STORAGE_LIMITS`（可经配置覆盖）：

| 限制 | 默认值 | 相对基线的余量 |
| --- | --- | --- |
| `maxCommands` | 512 | ≈ 25× 大型批次 |
| `maxCanvasJsonBytes` | 8 MiB | ≈ 96× 大型画布 |
| `maxStringLength` | 256 KiB | 单个字段 |
| `maxTitleLength` | 512 | 标题 |

结论：

- 默认值不会误伤任何已测量样本，且余量足以容纳比「大型画布」大一个数量级的项目。
- `maxCanvasJsonBytes` 是**安全上限**而非目标体积：达到该量级说明聚合需要分片/CRDT
  （见 design「Risks / Trade-offs：完整 JSON 快照在大画布下写放大」），应在压测后重新评估，
  而不是在本 change 内提前优化。
- 这些值是**可配置默认值**；部署侧可通过 `WOOHAA3_CANVAS_STORAGE_MAX_JSON_BYTES` 等调整。
