/**
 * 进程级重启演练（change: split-web-runtime-services，任务 8.2）。
 *
 * 与 `topology.test.ts`（同进程、真实 HTTP 边界）互补：这里用 `child_process.spawn`
 * 起**真实独立进程**，真实 kill / restart，验证 durable 恢复语义：
 *
 * 1. **Task durable history 跨进程重启仍可读**，且同 key + 同 payload 重提时 provider
 *    至多执行一次（PROVIDER_LOG 只应有一条）。
 * 2. **Canvas Service 跨进程重启后**画布 API、durable Yjs room（checkpoint 恢复）与
 *    语义命令提交仍可用（单实例约束下不出现双写）。
 *
 * 需要构建产物（`build:units`）；缺少时跳过并给出明确原因。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  decodeSessionFrame,
  encodeSessionFrame,
  decodeMessage,
  encodeCommandMessage,
  encodeSyncMessage,
  serverCanvasToYDoc
} from "@woohaa3/contracts/canvas-yjs";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCESS_DIR = fileURLToPath(new URL("./process", import.meta.url));

const bundles = [
  path.join(WEB_ROOT, "services/media-service/dist/index.js"),
  path.join(WEB_ROOT, "services/task-service/dist/index.js"),
  path.join(WEB_ROOT, "services/canvas-service/dist/index.js")
];
const built = bundles.every((file) => existsSync(file));

type Child = ReturnType<typeof spawn>;

const children: Child[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-proc-"));
  dirs.push(dir);
  return dir;
}

function start(kind: "media" | "task" | "canvas", env: Record<string, string>, port: number): Promise<Child> {
  const child = spawn(process.execPath, [path.join(PROCESS_DIR, `${kind}-entry.mjs`)], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind} 启动超时`)), 25_000);
    let buffered = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes(`[${kind}]`)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${kind} 提前退出：${code}\n${buffered}`));
    });
  });
}

async function stop(child: Child): Promise<void> {
  if (child.killed) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROTOCOL_HEADER = { "x-woohaa3-protocol-version": "1" };

async function putSubmit(
  port: number,
  token: string,
  workerTaskKey: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/internal/v1/tasks/${encodeURIComponent(workerTaskKey)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-woohaa3-service-token": token, ...PROTOCOL_HEADER },
    body: JSON.stringify(body)
  });
}

async function getStatus(port: number, token: string, workerTaskKey: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/internal/v1/tasks/${encodeURIComponent(workerTaskKey)}`, {
    headers: { "x-woohaa3-service-token": token, ...PROTOCOL_HEADER }
  });
}

/** 连一个只读同步客户端并等 synced；返回 doc 与一个提交语义命令的入口。 */
async function connectSync(port: number, canvasId: string) {
  const doc = new Y.Doc();
  const statuses: string[] = [];
  const results: Array<{ commandId?: string; status?: string }> = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/api/canvases/${canvasId}/sync?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}&protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}`
      + `&formatVersion=${YJS_CANVAS_FORMAT_VERSION}&roomEpoch=proc-epoch`
  );
  ws.on("message", (raw: Buffer) => {
    const frame = decodeSessionFrame(new Uint8Array(raw));
    if (frame.channelId !== SESSION_CHANNEL.CANVAS_YJS) return;
    const decoded = decodeMessage(frame.payload);
    if (decoded.type === MESSAGE_TYPE.SYNC) {
      const syncType = decoded.syncType as number;
      if (syncType === SYNC_MESSAGE_TYPE.STEP2 || syncType === SYNC_MESSAGE_TYPE.UPDATE) {
        Y.applyUpdate(doc, decoded.payload as Uint8Array, "server");
      } else if (syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
      }
    } else if (decoded.type === MESSAGE_TYPE.STATUS) {
      statuses.push((decoded.status as { status?: string }).status ?? "");
    } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
      results.push(decoded.result as { commandId?: string; status?: string });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`);
      await sleep(50);
    }
  };
  ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
  await waitFor(() => statuses.includes("synced"), "synced");
  const submit = (batch: Parameters<typeof encodeCommandMessage>[0]) =>
    ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeCommandMessage(batch)));
  return { doc, ws, results, waitFor, submit };
}

function enableYjs(port: number, canvasId: string, canvas: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/__proc_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId, canvas })
  });
}

function emptyCanvas(canvasId: string) {
  return {
    id: canvasId,
    title: "进程演练画布",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      // 复用一个真实文本节点：语义命令在最新 published 状态上串行执行，节点必须存在。
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-09-24T00:00:00.000Z"
    },
    nodeData: { "text-1": { title: "演练节点", prompt: "初始" } },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-24T00:00:00.000Z"
  };
}

const describeOrSkip = built ? describe : describe.skip;

describeOrSkip("进程级重启演练（任务 8.2）", () => {
  it("Task durable history 跨进程重启仍可读，且同 key 重提 provider 仍只执行一次", async () => {
    const dir = tempDir();
    const providerLog = path.join(dir, "provider.log");
    writeFileSync(providerLog, "");
    const taskDb = path.join(dir, "task.sqlite");
    const modelsConfig = path.join(WEB_ROOT, "services/task-service/pptask.models.json");
    const taskToken = "proc-task-token";
    const taskPort = await freePort();

    const taskEnv = {
      TASK_DB: taskDb,
      TASK_TOKEN: taskToken,
      MEDIA_URL: "http://127.0.0.1:1",
      PROVIDER_LOG: providerLog,
      MODELS_CONFIG: modelsConfig
    };
    const key = "proc-key-1";
    const payload = {
      canvasId: "c1",
      nodeId: "n1",
      runId: "r1",
      jobId: "j1",
      nodeType: "text",
      modelType: "language",
      modelKey: "litellm:gemini-2.5-flash",
      prompt: "进程重启演练",
      parameters: {},
      inputs: []
    };

    await start("task", taskEnv, taskPort);
    const submit = await putSubmit(taskPort, taskToken, key, payload);
    expect([200, 202]).toContain(submit.status);
    expect((await getStatus(taskPort, taskToken, key)).status).toBe(200);
    // 首次执行的 provider 调用已落盘。
    await sleep(300);
    expect(readFileSync(providerLog, "utf8").split("\n").filter(Boolean)).toEqual([key]);

    // 真实 kill 进程并重启同一 durable store。
    await stop(children[0]);
    await sleep(300);
    await start("task", taskEnv, taskPort);

    // ① 重启后同 key status 仍返回记录（durable history）。
    const afterRestart = await getStatus(taskPort, taskToken, key);
    expect(afterRestart.status).toBe(200);
    expect((await afterRestart.json()) as { taskKey?: string }).toMatchObject({ taskKey: key });

    // ② 重启后以相同 payload 重提：复用既有记录，不重跑 provider。
    const retry = await putSubmit(taskPort, taskToken, key, payload);
    expect([200, 202]).toContain(retry.status);
    await sleep(300);
    expect(readFileSync(providerLog, "utf8").split("\n").filter(Boolean)).toEqual([key]);
  }, 30_000);

  it("Canvas Service 跨进程重启后画布 API、durable Yjs room 与语义命令仍可用", async () => {
    const dir = tempDir();
    const canvasDb = path.join(dir, "canvas.sqlite");
    const canvasPort = await freePort();
    const canvasEnv = {
      CANVAS_DB: canvasDb,
      TASK_TOKEN: "unused",
      CANVAS_TOKEN: "proc-canvas-token",
      // 指向不可达的 Task/Media：本用例只验证 Canvas 自身重启恢复，不涉及下游。
      TASK_URL: "http://127.0.0.1:1",
      MEDIA_URL: "http://127.0.0.1:1"
    };

    await start("canvas", canvasEnv, canvasPort);
    const canvasId = `proc-canvas-${Date.now()}`;
    await fetch(`http://127.0.0.1:${canvasPort}/api/canvases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId })
    });
    expect((await enableYjs(canvasPort, canvasId, emptyCanvas(canvasId))).ok).toBe(true);

    // 重启前：经同步提交一条语义命令（写入 durable checkpoint/update）。
    const before = await connectSync(canvasPort, canvasId);
    before.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId,
      commandId: "proc-before",
      baseRevision: 0,
      actorId: "proc-writer",
      commands: [{ type: "nodeData.patch", nodeId: "text-1", value: { prompt: "重启前" } }] as never
    });
    await before.waitFor(() => before.results.some((r) => r.commandId === "proc-before"), "proc-before result");
    expect(before.results.find((r) => r.commandId === "proc-before")?.status).toBe("accepted");
    before.ws.close();

    // 真实 kill + 重启。
    await stop(children[0]);
    await sleep(300);
    await start("canvas", canvasEnv, canvasPort);

    // ① REST 画布仍在。
    const readBack = await fetch(`http://127.0.0.1:${canvasPort}/api/canvases/${canvasId}`);
    expect(readBack.status).toBe(200);
    expect((await readBack.json()) as { canvas?: { id?: string } }).toMatchObject({ canvas: { id: canvasId } });

    // ② durable Yjs room 从 checkpoint 恢复：重启前写入的 nodeData 仍在。
    const after = await connectSync(canvasPort, canvasId);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const nodes = after.doc.getMap("nodeData");
      const entry = nodes.get("text-1") as { prompt?: string } | undefined;
      if (entry?.prompt === "重启前") break;
      await sleep(50);
    }
    const restored = after.doc.getMap("nodeData").get("text-1") as { prompt?: string } | undefined;
    expect(restored?.prompt).toBe("重启前");

    // ③ 重启后仍可提交语义命令（单写者，无第二个 writer）。
    after.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId,
      commandId: "proc-after",
      baseRevision: 0,
      actorId: "proc-writer",
      commands: [{ type: "nodeData.patch", nodeId: "text-1", value: { prompt: "重启后" } }] as never
    });
    await after.waitFor(() => after.results.some((r) => r.commandId === "proc-after"), "proc-after result");
    expect(after.results.find((r) => r.commandId === "proc-after")?.status).toBe("accepted");
    after.ws.close();
    void serverCanvasToYDoc;
  }, 30_000);

  it("图片任务 begin 后 Canvas 退出：Task 持久化失败终态，重启后补偿且不重复付费", async () => {
    const dir = tempDir();
    const providerLog = path.join(dir, "provider.log");
    writeFileSync(providerLog, "");
    const canvasDb = path.join(dir, "canvas.sqlite");
    const taskDb = path.join(dir, "task.sqlite");
    const modelsConfig = path.join(WEB_ROOT, "services/task-service/pptask.models.json");
    const canvasToken = "proc-c3-canvas";
    const taskToken = "proc-c3-task";
    const canvasPort = await freePort();
    const taskPort = await freePort();

    // Task 的假执行延迟 1.2s 终结：给 Canvas 在 begin 之后、终态之前退出的窗口。
    const taskEnv = {
      TASK_DB: taskDb,
      TASK_TOKEN: taskToken,
      MEDIA_URL: "http://127.0.0.1:1",
      PROVIDER_LOG: providerLog,
      MODELS_CONFIG: modelsConfig,
      WORKER_DELAY_MS: "1200",
      WORKER_FAIL: "1"
    };
    const canvasEnv = {
      CANVAS_DB: canvasDb,
      TASK_TOKEN: taskToken,
      CANVAS_TOKEN: canvasToken,
      TASK_URL: `http://127.0.0.1:${taskPort}`,
      MEDIA_URL: "http://127.0.0.1:1"
    };

    await start("task", taskEnv, taskPort);
    await start("canvas", canvasEnv, canvasPort);

    const canvasId = `proc-run-${Date.now()}`;
    await fetch(`http://127.0.0.1:${canvasPort}/api/canvases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId })
    });
    const initial = emptyCanvas(canvasId);
    initial.document.nodes[0]!.type = "image";
    expect((await enableYjs(canvasPort, canvasId, initial)).ok).toBe(true);

    // 从权威 Y.Doc 解析输入需要画布处于 yjs 模式（enableYjs 已写入 durable syncMode）。
    const run = await fetch(`http://127.0.0.1:${canvasPort}/api/canvases/${canvasId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "text-1",
        runId: "run-proc-c3",
        jobId: "job-proc-c3",
        modelKey: "litellm:fixture-image",
        prompt: "begin 后退出",
        parameters: {}
      })
    });
    expect(run.status).toBe(202);

    // Canvas 在假 worker 终结前退出（begin 已 durable，provider 已提交）。
    await stop(children[1]); // canvas 是第二个 spawn
    // 等 Task 的延迟终结落盘（Canvas 不在线）。
    await sleep(2_000);
    expect(readFileSync(providerLog, "utf8").split("\n").filter(Boolean)).toEqual(["run-proc-c3"]);

    // 重启 Canvas：启动补偿从持久化 history 拉取终态并投影，provider 不重跑。
    await start("canvas", canvasEnv, canvasPort);
    const reader = await connectSync(canvasPort, canvasId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const node = reader.doc.getMap("nodeData").get("text-1") as { taskStatus?: string } | undefined;
      if (node?.taskStatus === "failed") break;
      await sleep(100);
    }
    const projected = reader.doc.getMap("nodeData").get("text-1") as { taskStatus?: string } | undefined;
    expect(projected?.taskStatus).toBe("failed");
    // provider 仍只执行一次（补偿只投影，不重跑）。
    expect(readFileSync(providerLog, "utf8").split("\n").filter(Boolean)).toEqual(["run-proc-c3"]);
    reader.ws.close();
  }, 30_000);
});
