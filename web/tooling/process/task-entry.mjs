#!/usr/bin/env node
/**
 * 进程级 E2E 的 Task Service 入口（change: split-web-runtime-services，任务 8.2）。
 *
 * 真实 durable task/history store + 确定性假 worker（每次 provider 调用追加到
 * `PROVIDER_LOG`，供测试断言「终态恢复不重跑 provider」）。监听 `PORT`。
 */
import http from "node:http";
import fs from "node:fs";
import { createTaskService, createSqliteTaskStore } from "../../services/task-service/dist/index.js";

const port = Number(process.env.PORT);

const scheduler = createSqliteTaskStore({ path: process.env.TASK_DB });
const records = new Map();
const listeners = new Set();
const emit = (record) => {
  records.set(record.id, record);
  for (const listener of listeners) listener(record);
};

const fakeWorker = {
  worker: {},
  async submit(input) {
    const receipt = await scheduler.submit({ key: input.key, providerId: input.providerId, now: new Date(), params: input.input, context: input.context });
    if (!receipt.created) return receipt;
    // provider 调用计数写入共享文件：同一 workerTaskKey 恢复后不得再执行一次。
    fs.appendFileSync(process.env.PROVIDER_LOG, `${input.key}\n`);
    const delayMs = Number(process.env.WORKER_DELAY_MS ?? "0");
    const now = new Date().toISOString();
    const emitTerminal = () => {
      emit({
        id: input.key,
        providerId: "e2e",
        state: "succeeded",
        events: [],
        result: { outputs: [{ kind: "text", text: "durable-result" }] },
        createdAt: now,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        metadata: input.context
      });
    };
    if (delayMs > 0) {
      // 延迟终结：用于「Canvas begin 后退出」场景——Canvas 离线时 Task 仍在执行。
      setTimeout(emitTerminal, delayMs).unref();
    } else {
      emitTerminal();
    }
    return { created: true, record: { id: input.key, status: "queued" } };
  },
  async status(key) {
    return records.get(key) ?? null;
  },
  async cancel(key) {
    const record = records.get(key);
    if (record) emit({ ...record, state: "cancelled" });
  },
  history: {
    get: async (id) => records.get(id),
    list: async () => [...records.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ingestSchedulingEvent() {},
    async flush() {},
    async dispose() {}
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  stop() {},
  async drained() {},
  async close() { scheduler.close(); }
};

const modelsConfig = JSON.parse(fs.readFileSync(process.env.MODELS_CONFIG, "utf8"));

const service = createTaskService({
  env: { PPTASK_LITELLM_API_KEY: "x", PPTASK_LITELLM_BASE_URL: "https://litellm.invalid" },
  modelsConfig,
  storePath: process.env.TASK_DB,
  serviceToken: process.env.TASK_TOKEN,
  mediaServiceUrl: process.env.MEDIA_URL,
  generationProviders: () => [{ extensionId: "test-provider", providerId: "litellm", available: true, provider: {}, models: [{ providerId: "litellm", providerModelId: "gemini-2.5-flash", modelType: "language", inputSchema: {}, defaultInput: {} }] }],
  workerServer: fakeWorker,
  logger: () => undefined
});

const server = http.createServer((req, res) => {
  service.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(port, "127.0.0.1", () => process.stderr.write(`[task] ${port}\n`));
const shutdown = () => {
  void service.close().finally(() => server.close(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
