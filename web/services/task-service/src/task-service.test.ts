/**
 * Task Service 测试（change: split-web-runtime-services，任务 4.2–4.9）。
 *
 * 覆盖 durable store 的幂等/claim/lease/重启恢复与 cursor 有序读取、内部 API 的认证与
 * 幂等语义、history 筛选/分页/安全裁剪/授权。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PptaskTaskRecord } from "@sdppp/pptask-worker-server";
import { createSqliteTaskStore } from "./repository/sqlite-task-store.js";
import { createSqliteTaskHistoryRepository,
  encodeCursor,
  decodeCursor,
  sanitizeDetail } from "./repository/history-repository.js";
import { createSqliteSubmitKeyRepository, computeSubmitPayloadHash } from "./repository/submit-keys.js";
import { createTaskHistoryHandler } from "./api/history-api.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-task-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

/** 构造带可控 remoteAddress 的伪 IncomingMessage（Socket.remoteAddress 只读）。 */
function makeRequest(options: {
  method: string;
  url: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
  listeners?: boolean;
}): IncomingMessage {
  const socket = new Socket();
  if (options.remoteAddress) {
    Object.defineProperty(socket, "remoteAddress", { value: options.remoteAddress, configurable: true });
  }
  const req = new IncomingMessage(socket);
  req.method = options.method;
  req.url = options.url;
  for (const [key, value] of Object.entries(options.headers ?? {})) req.headers[key] = value;
  if (options.listeners === false) req.on = (() => req) as typeof req.on;
  return req;
}

function mockResponse(req: IncomingMessage): { res: ServerResponse; written: string[] } {
  const written: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  res.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  return { res, written };
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("durable task store（任务 4.2）", () => {
  it("submit 幂等：相同 key 返回既有记录", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    const first = await store.submit({ key: "k1", providerId: "litellm", now: new Date(1000) });
    const second = await store.submit({ key: "k1", providerId: "litellm", now: new Date(2000) });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.key).toBe("k1");
    store.close();
  });

  it("claim/lease：同一任务被围栏，陈旧写入被忽略", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "k", providerId: "litellm", now: new Date(1000) });
    const claimed = await store.claimDue({ now: new Date(2000), leaseUntil: new Date(3000) });
    expect(claimed?.status).toBe("executing");
    expect(claimed?.attempt).toBe(1);

    const stale: PptaskTaskRecord = { ...claimed!, claimToken: "stale-token", status: "completed" };
    await store.save(stale);
    const after = await store.find("k");
    expect(after?.status).toBe("executing");

    const heartbeat = await store.heartbeat({
      key: "k",
      claimToken: "stale-token",
      leaseUntil: new Date(5000),
      now: new Date(2500)
    });
    expect(heartbeat).toBe(false);
    store.close();
  });

  it("重启后记录与幂等 key 仍可恢复", async () => {
    const file = tempDb();
    const store = createSqliteTaskStore({ path: file });
    await store.submit({
      key: "durable",
      providerId: "litellm",
      params: { modelId: "m" },
      context: { canvasId: "c" },
      now: new Date(1000)
    });
    store.close();

    const reopened = createSqliteTaskStore({ path: file });
    const record = await reopened.find("durable");
    expect(record?.key).toBe("durable");
    expect(record?.params).toEqual({ modelId: "m" });
    expect(record?.context).toEqual({ canvasId: "c" });
    reopened.close();
  });

  it("cancel 后终态优先，重复 cancel 不变", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "k", providerId: "litellm", now: new Date(1000) });
    const cancelled = await store.cancel("k", new Date(2000));
    expect(cancelled?.status).toBe("cancelled");
    const again = await store.cancel("k", new Date(3000));
    expect(again?.status).toBe("cancelled");
    store.close();
  });
});

describe("SQLite dispatch contract（change: replace-worker-db-polling-with-dispatcher）", () => {
  it("claimReady 稳定顺序：nextRunAt → createdAt → key，且只认领到期任务", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "future", providerId: "litellm", now: new Date(1000) });
    await store.submit({ key: "immediate", providerId: "litellm", now: new Date(2000) });
    await store.submit({ key: "early", providerId: "litellm", now: new Date(3000) });
    const future = (await store.find("future"))!;
    await store.save({ ...future, nextRunAt: new Date(10_000) });
    const early = (await store.find("early"))!;
    await store.save({ ...early, nextRunAt: new Date(4500) });

    const first = await store.claimReady({ now: new Date(5000), leaseUntil: new Date(6000) });
    expect(first?.key).toBe("immediate");
    expect(first?.status).toBe("executing");
    const second = await store.claimReady({ now: new Date(5000), leaseUntil: new Date(6000) });
    expect(second?.key).toBe("early");
    expect(await store.claimReady({ now: new Date(5000), leaseUntil: new Date(6000) })).toBeNull();
    store.close();
  });

  it("并发 claimReady 不会返回同一记录（compare-and-set）", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    for (let index = 0; index < 5; index += 1) {
      await store.submit({ key: `job-${index}`, providerId: "litellm", now: new Date(1000) });
    }
    const claims = await Promise.all([
      store.claimReady({ now: new Date(1000), leaseUntil: new Date(2000) }),
      store.claimReady({ now: new Date(1000), leaseUntil: new Date(2000) }),
      store.claimReady({ now: new Date(1000), leaseUntil: new Date(2000) }),
      store.claimReady({ now: new Date(1000), leaseUntil: new Date(2000) }),
      store.claimReady({ now: new Date(1000), leaseUntil: new Date(2000) })
    ]);
    const keys = claims.map((claim) => claim?.key).sort();
    expect(keys).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4"]);
    store.close();
  });

  it("nextWakeAt：只返回最早的未来 retry/lease deadline；进程重开后仍可恢复", async () => {
    const file = tempDb();
    const store = createSqliteTaskStore({ path: file });
    await store.submit({ key: "ready", providerId: "litellm", now: new Date(1000) });
    await store.submit({ key: "later", providerId: "litellm", now: new Date(1000) });
    await store.submit({ key: "sooner", providerId: "litellm", now: new Date(1000) });
    expect(await store.nextWakeAt({ now: new Date(1000) })).toBeNull();

    const later = (await store.find("later"))!;
    await store.save({ ...later, nextRunAt: new Date(9000) });
    const sooner = (await store.find("sooner"))!;
    await store.save({ ...sooner, nextRunAt: new Date(4000) });
    expect((await store.nextWakeAt({ now: new Date(1000) }))?.getTime()).toBe(4000);
    expect((await store.nextWakeAt({ now: new Date(4000) }))?.getTime()).toBe(9000);
    store.close();

    // 进程重开：delayed deadline 从 durable store 重建，不依赖内存 timer。
    const reopened = createSqliteTaskStore({ path: file });
    expect((await reopened.nextWakeAt({ now: new Date(4100) }))?.getTime()).toBe(9000);
    // 立即任务可认领，未来 deadline 仍不会被提前认领。
    const claimed = await reopened.claimReady({ now: new Date(4100), leaseUntil: new Date(5000) });
    expect(claimed?.key).toBe("ready");
    const dueNow = await reopened.claimReady({ now: new Date(4100), leaseUntil: new Date(5000) });
    expect(dueNow?.key).toBe("sooner");
    expect(await reopened.claimReady({ now: new Date(4100), leaseUntil: new Date(5000) })).toBeNull();
    reopened.close();
  });

  it("执行中 lease deadline 也作为 nextWakeAt；过期后可接管", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "k", providerId: "litellm", now: new Date(1000) });
    const claimed = (await store.claimReady({ now: new Date(1000), leaseUntil: new Date(6000) }))!;
    expect((await store.nextWakeAt({ now: new Date(2000) }))?.getTime()).toBe(6000);
    expect(await store.claimReady({ now: new Date(5000), leaseUntil: new Date(7000) })).toBeNull();

    const takeover = (await store.claimReady({ now: new Date(6001), leaseUntil: new Date(8000) }))!;
    expect(takeover.key).toBe("k");
    expect(takeover.attempt).toBe(2);
    expect(takeover.claimToken).not.toBe(claimed.claimToken);
    store.close();
  });

  it("terminal、cancel 与 fencing：终态任务不进入调度查询", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "cancelled", providerId: "litellm", now: new Date(1000) });
    await store.cancel("cancelled", new Date(1500));
    await store.submit({ key: "completed", providerId: "litellm", now: new Date(1000) });
    const claimed = (await store.claimReady({ now: new Date(2000), leaseUntil: new Date(3000) }))!;
    await store.save({ ...claimed, status: "completed", updatedAt: new Date(2100) });

    expect(await store.nextWakeAt({ now: new Date(2000) })).toBeNull();
    expect(await store.claimReady({ now: new Date(3000), leaseUntil: new Date(4000) })).toBeNull();
    store.close();
  });

  it("迁移兼容：旧 claimDue 与新 claimReady 行为一致", async () => {
    const store = createSqliteTaskStore({ path: tempDb() });
    await store.submit({ key: "legacy", providerId: "litellm", now: new Date(1000) });
    const claimed = await store.claimDue({ now: new Date(2000), leaseUntil: new Date(3000) });
    expect(claimed?.key).toBe("legacy");
    expect(claimed?.status).toBe("executing");
    store.close();
  });
});

describe("history read model（任务 4.7 / 4.9）", () => {
  it("稳定分页与 cursor 有序读取，不暴露主键", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    for (let index = 0; index < 5; index += 1) {
      repo.upsertRecord({
        taskKey: `t${index}`,
        state: index % 2 === 0 ? "succeeded" : "failed",
        providerId: "litellm",
        createdAt: `2026-01-0${index + 1}T00:00:00Z`,
        updatedAt: `2026-01-0${index + 1}T00:00:00Z`,
        durationMs: 0
      });
    }
    const first = repo.list({ limit: 2 });
    if (!first.ok) throw new Error(first.message);
    expect(first.page.items.map((item) => item.taskKey)).toEqual(["t4", "t3"]);
    expect(first.page.nextCursor).toBeDefined();
    const decoded = decodeCursor(first.page.nextCursor);
    expect(decoded?.taskKey).toBe("t3");

    const second = repo.list({ limit: 2, cursor: first.page.nextCursor });
    if (!second.ok) throw new Error(second.message);
    expect(second.page.items.map((item) => item.taskKey)).toEqual(["t2", "t1"]);

    // 新记录到达不改变已取得 cursor 的后续页。
    repo.upsertRecord({
      taskKey: "t9",
      state: "running",
      providerId: "litellm",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      durationMs: 0
    });
    const secondAgain = repo.list({ limit: 2, cursor: first.page.nextCursor });
    if (!secondAgain.ok) throw new Error(secondAgain.message);
    expect(secondAgain.page.items.map((item) => item.taskKey)).toEqual(["t2", "t1"]);
    repo.close();
  });

  it("按状态/画布/节点/模型/时间筛选", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord({ taskKey: "a", state: "running", providerId: "litellm", canvasId: "c1", nodeId: "n1", modelKey: "litellm:m1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    repo.upsertRecord({ taskKey: "b", state: "succeeded", providerId: "litellm", canvasId: "c1", nodeId: "n2", modelKey: "litellm:m2", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    const keys = (result: ReturnType<typeof repo.list>) => {
      if (!result.ok) throw new Error(result.message);
      return result.page.items.map((i) => i.taskKey);
    };
    expect(keys(repo.list({ state: "running" }))).toEqual(["a"]);
    expect(keys(repo.list({ states: ["queued", "pending", "running"] }))).toEqual(["a"]);
    expect(keys(repo.list({ canvasId: "c1" }))).toEqual(["b", "a"]);
    expect(keys(repo.list({ nodeId: "n2" }))).toEqual(["b"]);
    expect(keys(repo.list({ modelKey: "litellm:m1" }))).toEqual(["a"]);
    expect(keys(repo.list({ taskKey: "b" }))).toEqual(["b"]);
    expect(keys(repo.list({ from: "2026-01-02T00:00:00Z" }))).toEqual(["b"]);
    repo.close();
  });

  it("换条件复用旧 cursor 返回稳定错配错误", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    for (let index = 0; index < 3; index += 1) {
      repo.upsertRecord({ taskKey: `t${index}`, state: "succeeded", providerId: "litellm", createdAt: `2026-01-0${index + 1}T00:00:00Z`, updatedAt: `2026-01-0${index + 1}T00:00:00Z`, durationMs: 0 });
    }
    const first = repo.list({ limit: 1 });
    if (!first.ok) throw new Error(first.message);
    const mismatched = repo.list({ limit: 1, cursor: first.page.nextCursor, state: "failed" });
    expect(mismatched).toMatchObject({ ok: false, code: "cursor-mismatch" });
    repo.close();
  });

  it("请求摘要只在详情（includeRequest）返回，列表与默认 get 不含 prompt", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord({
      taskKey: "t",
      state: "running",
      providerId: "litellm",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      durationMs: 0,
      request: { prompt: "秘密提示词", parameters: { size: "1024x1024", signedUrl: "https://x?sign=y" } }
    });
    // 列表不含请求摘要。
    const listed = repo.list({});
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(JSON.stringify(listed.page.items)).not.toContain("秘密提示词");
    // 默认 get（内部 feed / Canvas 补偿）也不含。
    expect(JSON.stringify(repo.get("t"))).not.toContain("秘密提示词");
    // 显式详情（operator/admin）才返回；且 parameters 里被递归剔除敏感键。
    const detail = repo.get("t", { includeRequest: true });
    expect(detail?.request?.prompt).toBe("秘密提示词");
    expect(detail?.request?.parameters).toEqual({ size: "1024x1024" });
    repo.close();
  });

  it("事件时间线有界，超限裁剪旧事件", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb(), maxEventsPerRecord: 3 });
    repo.upsertRecord({ taskKey: "t", state: "running", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    for (let index = 0; index < 6; index += 1) {
      repo.appendEvent({ taskKey: "t", kind: "execution", stage: `pptask.step${index}`, occurredAt: `2026-01-01T00:00:0${index}Z` });
    }
    const detail = repo.get("t");
    expect(detail?.events).toHaveLength(3);
    expect(detail?.events.map((event) => event.stage)).toEqual(["pptask.step3", "pptask.step4", "pptask.step5"]);
    repo.close();
  });

  it("安全裁剪：prompt / provider input / stack / 签名 URL 不落历史", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord({
      taskKey: "t",
      state: "failed",
      providerId: "litellm",
      error: { name: "ProviderError", message: "boom" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      durationMs: 0
    });
    repo.appendEvent({
      taskKey: "t",
      kind: "execution",
      stage: "pptask.failed",
      detail: { prompt: "secret", providerInput: { key: "k" }, stack: "at foo", headers: { authorization: "x" }, reason: "safe" },
      occurredAt: "2026-01-01T00:00:01Z"
    });
    const detail = repo.get("t");
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("at foo");
    expect(detail?.events[0].detail).toEqual({ reason: "safe" });
    repo.close();
  });

  it("pruneTerminalBefore 只删超过保留期的终态记录", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord({ taskKey: "old", state: "succeeded", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    repo.upsertRecord({ taskKey: "running", state: "running", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const removed = repo.pruneTerminalBefore("2026-02-01T00:00:00Z");
    expect(removed).toBe(1);
    expect(repo.get("old")).toBeUndefined();
    expect(repo.get("running")).toBeDefined();
    repo.close();
  });

  it("cursor 编码不暴露主键", () => {
    const cursor = encodeCursor({ createdAt: "2026-01-01T00:00:00Z", taskKey: "t1" });
    expect(cursor).not.toContain("t1");
    expect(decodeCursor(cursor)?.taskKey).toBe("t1");
    expect(decodeCursor("garbage")).toBeNull();
  });

  it("sanitizeDetail 递归剔除敏感键", () => {
    expect(sanitizeDetail({ a: 1, signedUrl: "https://x", nested: { prompt: "p", keep: 2 } })).toEqual({ a: 1, nested: { keep: 2 } });
  });
});

describe("submit 幂等 payload 指纹（任务 4.3）", () => {
  it("相同 key + 相同 payload 复用，不同 payload 冲突", () => {
    const repo = createSqliteSubmitKeyRepository({ path: tempDb() });
    const request = {
      canvasId: "c",
      nodeId: "n",
      runId: "r",
      jobId: "j",
      nodeType: "image",
      modelType: "image",
      modelKey: "litellm:m",
      prompt: "p",
      parameters: { size: "1" },
      inputs: []
    };
    const hash = computeSubmitPayloadHash(request);
    expect(repo.claim("k", hash, "2026-01-01T00:00:00Z")).toEqual({ created: true, reused: false, conflict: false });
    expect(repo.claim("k", hash, "2026-01-01T00:00:01Z")).toEqual({ created: false, reused: true, conflict: false });
    const different = computeSubmitPayloadHash({ ...request, prompt: "other" });
    expect(repo.claim("k", different, "2026-01-01T00:00:02Z")).toEqual({ created: false, reused: false, conflict: true });
    repo.close();
  });

  it("字段顺序不影响指纹", () => {
    const first = computeSubmitPayloadHash({
      canvasId: "c", nodeId: "n", runId: "r", jobId: "j", nodeType: "image", modelType: "image",
      modelKey: "litellm:m", prompt: "p", parameters: { a: 1, b: 2 }, inputs: []
    });
    const second = computeSubmitPayloadHash({
      canvasId: "c", nodeId: "n", runId: "r", jobId: "j", nodeType: "image", modelType: "image",
      modelKey: "litellm:m", prompt: "p", parameters: { b: 2, a: 1 }, inputs: []
    });
    expect(first).toBe(second);
  });
});

describe("history 事件流（任务 4.4 / 4.8）", () => {
  it("先发 snapshot 再推 durable 变化，携带可恢复 cursor", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "a", state: "running", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const handler = createTaskHistoryHandler({ history, eventFlushMs: 10, eventBatchLimit: 100 });

    const req = makeRequest({ method: "GET", url: "/api/pptask/history/events?after=0", remoteAddress: "127.0.0.1" });
    const { res, written } = mockResponse(req);

    await handler(req, res);
    // 首帧 snapshot 含已有记录与 cursor。
    expect(written.join("")).toContain("\"taskKey\":\"a\"");
    expect(written.join("")).toContain("cursor");

    // 新记录到达后由订阅推送。
    history.upsertRecord({ taskKey: "b", state: "succeeded", providerId: "litellm", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(written.join("")).toContain("\"taskKey\":\"b\"");

    req.emit("close");
    history.close();
  });

  it("事件速率限制：单 tick 最多推送 eventBatchLimit 条，其余留待后续 tick", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    // 先放 5 条 snapshot 记录，batch 上限设为 2。
    for (let i = 0; i < 5; i += 1) {
      history.upsertRecord({
        taskKey: `t${i}`,
        state: "running",
        providerId: "litellm",
        createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
        durationMs: 0
      });
    }
    const handler = createTaskHistoryHandler({ history, eventFlushMs: 10, eventBatchLimit: 2 });
    const req = makeRequest({ method: "GET", url: "/api/pptask/history/events?after=0", remoteAddress: "127.0.0.1" });
    const { res, written } = mockResponse(req);
    await handler(req, res);

    const countLines = () => written.join("").split("\n").filter((line) => line.trim() !== "").length;
    // 首帧最多 2 条。
    expect(countLines()).toBeLessThanOrEqual(2);
    // 后续 tick 继续推送，最终能补齐全部 5 条（不丢事件）。
    // 并行跑全量测试时定时器可能被延迟，因此用轮询而不是固定等待。
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const keys = written.join("");
      if ([0, 1, 2, 3, 4].every((i) => keys.includes(`"taskKey":"t${i}"`))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const keys = written.join("");
    for (let i = 0; i < 5; i += 1) expect(keys).toContain(`"taskKey":"t${i}"`);
    req.emit("close");
    history.close();
  });

  it("断线后用 cursor 从 history 补齐（事件不是唯一事实源）", () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "a", state: "running", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const first = history.listSince(0);
    const cursor = first.cursor;

    // 模拟离线期间新增两条。
    history.upsertRecord({ taskKey: "b", state: "succeeded", providerId: "litellm", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    history.upsertRecord({ taskKey: "c", state: "failed", providerId: "litellm", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", durationMs: 0 });

    const replay = history.listSince(cursor);
    expect(replay.messages.map((message) => message.record.taskKey)).toEqual(["b", "c"]);
    // 重复读取同一区间得到相同记录（幂等）。
    const again = history.listSince(cursor);
    expect(again.messages.map((message) => message.record.taskKey)).toEqual(["b", "c"]);
    // 逐条可确认 cursor 单调。
    expect(replay.messages[1].cursor).toBeGreaterThan(replay.messages[0].cursor);
    history.close();
  });

  it("补偿超过单批容量时返回 hasMore，不越过未交付记录确认水位", () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    for (let i = 0; i < 5; i += 1) {
      history.upsertRecord({ taskKey: `t${i}`, state: "running", providerId: "litellm", createdAt: `2026-01-0${i + 1}T00:00:00Z`, updatedAt: `2026-01-0${i + 1}T00:00:00Z`, durationMs: 0 });
    }
    const first = history.listSince(0, 2);
    expect(first.messages).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = history.listSince(first.cursor, 2);
    expect(second.messages).toHaveLength(2);
    expect(second.hasMore).toBe(true);
    const third = history.listSince(second.cursor, 2);
    expect(third.messages).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    // 请求超出当前水位：显式 resync。
    const future = history.listSince(history.currentCursor() + 10);
    expect(future.resync).toBe(true);
    history.close();
  });
});

describe("history 查询/候选/增量 HTTP（change: improve-task-history-experience，1.1/2.2/2.3）", () => {
  function seed(repo: ReturnType<typeof createSqliteTaskHistoryRepository>) {
    repo.upsertRecord({ taskKey: "a", state: "running", providerId: "litellm", providerName: "LiteLLM", modelType: "image", modelKey: "litellm:m1", modelTitle: "M1", canvasId: "c1", nodeId: "n1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    repo.upsertRecord({ taskKey: "b", state: "succeeded", providerId: "litellm", providerName: "LiteLLM", modelType: "image", modelKey: "litellm:m2", modelTitle: "M2", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
  }

  it("states/非法条件返回稳定错误码", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    seed(history);
    const handler = createTaskHistoryHandler({ history, allowLoopback: true });
    const okReq = makeRequest({ method: "GET", url: "/api/pptask/history?states=queued,pending,running", remoteAddress: "127.0.0.1" });
    const okRes = mockResponse(okReq);
    await handler(okReq, okRes.res);
    expect(okRes.res.statusCode).toBe(200);
    expect(okRes.written.join("")).toContain("\"taskKey\":\"a\"");
    expect(okRes.written.join("")).toContain("watermark");

    for (const [url, code] of [
      ["/api/pptask/history?state=running&states=queued", "state-conflict"],
      ["/api/pptask/history?modelType=bogus", "invalid-model-type"],
      ["/api/pptask/history?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z", "invalid-time-range"]
    ] as const) {
      const req = makeRequest({ method: "GET", url, remoteAddress: "127.0.0.1" });
      const res = mockResponse(req);
      await handler(req, res.res);
      expect(res.res.statusCode, url).toBe(400);
      expect(res.written.join(""), url).toContain(code);
    }
    history.close();
  });

  it("换条件复用旧 cursor 返回 cursor-mismatch", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    seed(history);
    const handler = createTaskHistoryHandler({ history, allowLoopback: true });
    const first = makeRequest({ method: "GET", url: "/api/pptask/history?limit=1", remoteAddress: "127.0.0.1" });
    const firstRes = mockResponse(first);
    await handler(first, firstRes.res);
    const cursor = (JSON.parse(firstRes.written.join("")) as { nextCursor: string }).nextCursor;
    const mismatched = makeRequest({ method: "GET", url: `/api/pptask/history?limit=1&modelType=image&cursor=${encodeURIComponent(cursor)}`, remoteAddress: "127.0.0.1" });
    const mismatchRes = mockResponse(mismatched);
    await handler(mismatched, mismatchRes.res);
    expect(mismatchRes.res.statusCode).toBe(400);
    expect(mismatchRes.written.join("")).toContain("cursor-mismatch");
    history.close();
  });

  it("候选包含历史模型（含已下线），不含 request 内容", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "old", state: "succeeded", providerId: "litellm", providerName: "LiteLLM", modelType: "video", modelKey: "litellm:retired", modelTitle: "Retired", request: { prompt: "秘密提示词", parameters: {} }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const handler = createTaskHistoryHandler({ history, allowLoopback: true });
    const req = makeRequest({ method: "GET", url: "/api/pptask/history/candidates", remoteAddress: "127.0.0.1" });
    const res = mockResponse(req);
    await handler(req, res.res);
    expect(res.res.statusCode).toBe(200);
    const body = res.written.join("");
    expect(body).toContain("litellm:retired");
    expect(body).not.toContain("秘密提示词");
    history.close();
  });

  it("JSON 增量实际交付变更，并显式返回 resync", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    seed(history);
    const handler = createTaskHistoryHandler({ history, allowLoopback: true });
    const changes = makeRequest({ method: "GET", url: "/api/pptask/history/changes?after=0", remoteAddress: "127.0.0.1" });
    const changesRes = mockResponse(changes);
    await handler(changes, changesRes.res);
    const parsed = JSON.parse(changesRes.written.join("")) as { messages: unknown[]; resync?: boolean };
    expect(parsed.messages.length).toBe(2);
    expect(parsed.resync).not.toBe(true);

    const future = makeRequest({ method: "GET", url: `/api/pptask/history/changes?after=${history.currentCursor() + 10}`, remoteAddress: "127.0.0.1" });
    const futureRes = mockResponse(future);
    await handler(future, futureRes.res);
    expect(JSON.parse(futureRes.written.join(""))).toMatchObject({ resync: true });
    history.close();
  });

  it("详情暴露事件裁剪标记与请求截断标记", () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb(), maxEventsPerRecord: 2 });
    history.upsertRecord({ taskKey: "t", state: "failed", providerId: "litellm", request: { prompt: "x".repeat(9000), parameters: { a: 1 } }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    for (let i = 0; i < 5; i += 1) {
      history.appendEvent({ taskKey: "t", kind: "execution", stage: `s${i}`, occurredAt: `2026-01-01T00:00:0${i}Z` });
    }
    const detail = history.get("t", { includeRequest: true });
    expect(detail?.eventsTruncated).toBe(true);
    expect(detail?.request?.prompt.length).toBe(8000);
    expect(detail?.request?.promptTruncated).toBe(true);
    expect(detail?.events).toHaveLength(2);
    history.close();
  });

  it("来源/extensionId 筛选与受理版本投影（阶段二 D1）", () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "canvas-1", state: "succeeded", providerId: "litellm", source: "canvas", canvasId: "c1", modelType: "image", modelKey: "litellm:m", admission: { catalogRevision: 3, schemaRevision: 2, configVersion: 5 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    history.upsertRecord({ taskKey: "plugin-1", state: "running", providerId: "litellm", source: "extension", extensionId: "sample-site", modelType: "language", modelKey: "litellm:m", admission: { catalogRevision: 4, extensionConfigVersion: 9 }, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    // 旧记录：没有来源字段 → 显式 unknown 查询覆盖。
    history.upsertRecord({ taskKey: "legacy", state: "failed", providerId: "litellm", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", durationMs: 0 });

    const keys = (q: Parameters<typeof history.list>[0]) => {
      const result = history.list(q);
      if (!result.ok) throw new Error(result.message);
      return result.page.items.map((item) => item.taskKey);
    };
    expect(keys({ source: "extension" })).toEqual(["plugin-1"]);
    expect(keys({ source: "canvas" })).toEqual(["canvas-1"]);
    expect(keys({ source: "unknown" })).toEqual(["legacy"]);
    expect(keys({ extensionId: "sample-site" })).toEqual(["plugin-1"]);
    const detail = history.get("plugin-1");
    expect(detail?.source).toBe("extension");
    expect(detail?.extensionId).toBe("sample-site");
    expect(detail?.admission).toEqual({ catalogRevision: 4, extensionConfigVersion: 9 });
    // 旧记录不猜测来源。
    expect(history.get("legacy")?.source).toBeUndefined();

    const candidates = history.candidates();
    expect(candidates.plugins).toEqual([{ extensionId: "sample-site" }]);
    history.close();
  });

  it("受理身份不随时间变化：改名/删除/停用不覆盖已保存快照（阶段二 D1 / 7.4）", () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    // 首次受理：模型名 M1、catalog/schema/config 快照、插件 configVersion=4。
    history.upsertRecord({ taskKey: "p", state: "running", providerId: "litellm", providerName: "LiteLLM", modelType: "language", modelKey: "litellm:m", modelTitle: "M1", source: "extension", extensionId: "sample-site", admission: { catalogRevision: 6, schemaRevision: 2, extensionConfigVersion: 4 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    // 之后模型改名、catalog 推进、插件配置更新并重启：同一任务的进度更新带入新值。
    history.upsertRecord({ taskKey: "p", state: "succeeded", providerId: "litellm", providerName: "LiteLLM 新", modelType: "language", modelKey: "litellm:m", modelTitle: "M2", source: "extension", extensionId: "sample-site", admission: { catalogRevision: 99, schemaRevision: 42, extensionConfigVersion: 77 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:05Z", finishedAt: "2026-01-01T00:00:05Z", durationMs: 5000 });
    const detail = history.get("p");
    // 执行时名称、来源与受理版本保持首次受理的快照。
    expect(detail?.modelTitle).toBe("M1");
    expect(detail?.providerName).toBe("LiteLLM");
    expect(detail?.source).toBe("extension");
    expect(detail?.extensionId).toBe("sample-site");
    expect(detail?.admission).toEqual({ catalogRevision: 6, schemaRevision: 2, extensionConfigVersion: 4 });
    // 状态仍按最新 fact 收敛。
    expect(detail?.state).toBe("succeeded");
    history.close();
  });
});

describe("history 只读授权边界（任务 7.5）", () => {
  it("非 loopback 且无令牌：列表/详情/事件均 401，且不查询 repository", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "t1", state: "succeeded", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    let queried = false;
    const originalGet = history.get.bind(history);
    history.get = ((key: string) => {
      queried = true;
      return originalGet(key);
    }) as typeof history.get;

    const handler = createTaskHistoryHandler({ history, serviceToken: "secret", allowLoopback: false });
    for (const url of ["/api/pptask/history", "/api/pptask/history/t1", "/api/pptask/history/events?after=0"]) {
      const req = makeRequest({ method: "GET", url, remoteAddress: "203.0.113.5" });
      const { res } = mockResponse(req);
      const handled = await handler(req, res);
      expect(handled, url).toBe(true);
      expect(res.statusCode, url).toBe(401);
    }
    expect(queried).toBe(false);
    history.close();
  });

  it("loopback 可访问（无身份系统部署的默认边界）", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "t1", state: "succeeded", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const handler = createTaskHistoryHandler({ history, allowLoopback: true });
    const req = makeRequest({ method: "GET", url: "/api/pptask/history", remoteAddress: "127.0.0.1" });
    const { res } = mockResponse(req);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    history.close();
  });

  it("受信任代理令牌可访问非 loopback", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    const handler = createTaskHistoryHandler({ history, serviceToken: "secret", allowLoopback: false });
    const req = makeRequest({
      method: "GET",
      url: "/api/pptask/history",
      remoteAddress: "203.0.113.5",
      headers: { "x-woohaa3-service-token": "secret" }
    });
    const { res } = mockResponse(req);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    history.close();
  });

  it("阶段二：来源/候选/详情在未授权时同样拒绝，且不泄漏 extensionId/受理版本", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord({ taskKey: "p", state: "running", providerId: "litellm", source: "extension", extensionId: "sample-site", admission: { extensionConfigVersion: 4 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const handler = createTaskHistoryHandler({ history, serviceToken: "secret", allowLoopback: false });
    for (const url of [
      "/api/pptask/history?source=plugin",
      "/api/pptask/history?extensionId=sample-site",
      "/api/pptask/history/candidates",
      "/api/pptask/history/p"
    ]) {
      const req = makeRequest({ method: "GET", url, remoteAddress: "203.0.113.5" });
      const { res } = mockResponse(req);
      await handler(req, res);
      expect(res.statusCode, url).toBe(401);
    }
    history.close();
  });
});
