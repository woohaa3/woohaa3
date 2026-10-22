# @sdppp/pptask-worker-server

受管执行运行时：调度（认领/租约/重试/恢复）+ 执行历史投影 + 存储组合，一个包。

- `pptask`（core）是无策略的执行机制库；**本包是它之上的受管运行时**。
- 受管执行的唯一入口是 `submit`：按幂等 key 在 taskStore 原子判重 → durable commit → 唤醒 dispatcher。
- **调度是事件驱动的**：单一 `TaskDispatcher` 按可用执行容量认领，worker 是**被动 executor**，不各自轮询数据库。
- **"怎么执行"统一收敛在 pptask provider 层**：异步任务走 jobs API；流式 LLM 由 worker 直接驱动模型 doStream（`stream: true`），delta 作为执行事实可推给前端。

## 快速上手

```ts
import { createMemoryJobRepository, createPptaskProvider } from '@sdppp/pptask';
import {
  createPptaskWorkerServer,
  createMemoryPptaskStorage,
} from '@sdppp/pptask-worker-server';

const storage = createMemoryPptaskStorage();
const jobRepository = createMemoryJobRepository();
const provider = createPptaskProvider({ providerId: 'example', jobRepository, imageModel: ... });

const server = await createPptaskWorkerServer({
  taskStore: storage.taskStore,
  jobRepository,
  resolveProvider: async (providerId) => provider,
  historyRepository: storage.history('pptask'),
});

// 唯一受管入口：按 key 判重，重复提交返回已有任务
await server.submit({
  key: 'order-42',
  providerId: 'example',
  modelType: 'image',
  modelId: 'demo',
  input: { prompt: 'hi' },
  context: { tenantId: 't1' },   // 业务上下文透传给 provider 执行；不放凭证
});

const task = await server.status('order-42');   // { status, result, state, ... }
await server.cancel('order-42');
await server.close();
```

进度与结果观测：`server.subscribe(r => ...)` / `server.history.get(key)`。
一条记录同时包含 scheduling（入队/认领/重试/结算）与 execution（提交/进度/终态）两类 phase。

## 流式 LLM 任务

```ts
// 提交：stream: true → worker 直接驱动模型 doStream（不经过 jobs API）
await server.submit({
  key: 'chat-42',
  providerId: 'example', modelType: 'language', modelId: 'gpt-x',
  input: { prompt: '讲个故事' },
  stream: true,
});

// 增量消费：delta 作为执行事实累积进历史记录的 streamedText
server.subscribe((record) => {
  if (record.id !== 'chat-42') return;
  pushSse(record.streamedText);            // 前端断线重连：先读累积文本再续播
  if (record.state === 'succeeded' || record.state === 'failed') endSse();
});
```

流不可续传：进程崩溃后流式任务从头重跑（at-least-once），已生成部分仍可在历史记录中回放。

## 自定义 provider（接入你自己的执行器）

业务执行器（模板 handler、聚合流程）实现为 pptask provider 的模型（doStart/doStatus 或
doGenerate/doStream），通过 `resolveProvider` 注册即可被受管调度。计费、租户凭证解析等
业务逻辑在 provider 实现内部完成，通过 `submit` 的 `context` 字段接收业务上下文（不放凭证）。

## 自定义存储

实现 `PptaskTaskStore`（`submit / find / claimReady / nextWakeAt / claimDue / heartbeat / save / cancel`，可选 `subscribe`）。
数据库实现的硬要求：`key` 唯一约束 + `INSERT ON CONFLICT` 判重、原子 `claimReady`（`FOR UPDATE SKIP LOCKED`）、
`claimToken` 条件写（防串号）、`cancel` 轮换令牌。`claimDue` 是过渡兼容别名，语义与 `claimReady` 相同。
写完后用一致性套件自测：

```ts
import { runTaskStoreConformance } from '@sdppp/pptask-worker-server/conformance';

it('postgres task store conforms', async () => {
  await runTaskStoreConformance(() => createPostgresTaskStore(pool));
});
```

## 导出

| 入口 | 内容 |
|---|---|
| `.` | worker 运行时、dispatcher/notifier、引擎契约与默认引擎、taskStore 契约与内存实现、server 组合、PptaskStorage |
| `./history` | 执行历史投影（scheduling + execution phases、保留、分页） |
| `./direct` | 直接 AI SDK 调用的记录器（不经 submit 的观测路径） |
| `./direct-node` | JSON 文件版历史仓库（本地工具） |
| `./conformance` | taskStore 一致性测试套件 |

## 调度与恢复语义（重要）

- **durable store 是事实源，通知只是 hint**：`submit` 先 durable commit 再 `dispatch notifier`；
  通知可以丢失、重复或合并，dispatcher 始终从 store 读取 `claimReady` 决定任务身份与顺序。
- **单一 dispatcher 按容量认领**：同一时刻最多一个本地 drain，只 claim 当前空闲容量能够立即执行的任务，
  不预取超过 capacity 的 lease；executor settle 释放容量后继续消费 durable backlog。
- **retry 用持久化 `nextRunAt` + 单次 timer**：executor 先 fenced 保存 `queued + nextRunAt`，再
  `dispatcher.schedule(nextRunAt)`；进程在两者之间退出可从 store 恢复，不为每个任务创建 interval。
- **低频 recovery 是安全网**：启动、低频带抖动 sweep、readiness 恢复和重复 submit 命中非终态记录时
  触发 recovery drain，补偿 commit 后通知丢失、timer 丢失和过期 lease。默认 30s 量级，绝不退化为
  100ms 级轮询；空闲稳定态不产生 claim query。
- **单进程 SQLite 只允许一个 dispatcher**：多实例部署必须先替换为支持跨进程原子 claim 的 durable
  backend 和 notification transport（`DispatchNotifier` 即该扩展点），不能靠提高扫描频率扩容。
- 引擎在远端操作被接受后必须 `updateState`；进程崩溃后 worker 按 key 重新认领并把快照交还引擎 `resume`，已接受的提交不会重做。
- 若崩溃发生在提交被上游接受之前，恢复会重新执行提交。**主流上游平台不支持幂等创建**，窄窗口内可能重复创建上游任务——at-least-once 的已知代价。
