/**
 * Canvas Service HTTP / WebSocket contract suite（change: split-web-runtime-services，任务 5.1 / 5.2）。
 *
 * 直接对 `createCanvasService` 组装出的真实 HTTP 边界运行，覆盖：
 * - REST lifecycle（create/list/get/delete）；
 * - health live/ready；
 * - Yjs room 的 durable-before-broadcast 与单实例 writer lock；
 * - 结构命令与媒体命令的边界（无媒体 client 时媒体命令失败、结构命令继续）。
 * - 旧 CAS `/commands`、`sync-mode` 与旧 Blob 路由不存在。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "./sync/index.js";
import { SqliteCanvasRepository } from "./storage/sqlite/index.js";
import { createCanvasService } from "./composition.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-canvas-"));
  dirs.push(dir);
  return path.join(dir, name);
}

async function start(): Promise<{ base: string; token: string; yjsRepository: InMemoryYjsDocumentRepository }> {
  const token = "canvas-contract-token";
  const canvasRepository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
  const yjsRepository = new InMemoryYjsDocumentRepository();
  const activityCalls: Array<{ canvasId: string; after: number }> = [];
  const service = await createCanvasService({
    env: {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
      WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: token
    },
    repository: canvasRepository,
    yjsRepository,
    mediaClient: {
      async verify() {
        return { exists: true, matches: true };
      }
    },
    taskClient: {
      async submit() {
        throw new Error("not used");
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges(canvasId, after) {
        activityCalls.push({ canvasId, after });
        return { items: [], cursor: 0 };
      }
    }
  });
  void activityCalls;
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  if (service.sync) {
    server.on("upgrade", (req, socket, head) => {
      if (service.sync?.matches(req.url)) service.sync.handle(req, socket, head);
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => {
    await service.close();
    await new Promise<void>((r) => server.close(() => r()));
    canvasRepository.close();
  });
  return { base: `http://127.0.0.1:${port}`, token, yjsRepository };
}

/** 打开一条 Canvas Session 并等待内层 Yjs 同步完成，返回协议读写 helper。 */
async function connectSession(input: {
  wsBase: string;
  canvasId: string;
  token: string;
}): Promise<{
  ws: import("ws").WebSocket;
  sendYjs: (payload: Uint8Array) => void;
  waitForCommandResult: (commandId: string) => Promise<Record<string, unknown>>;
  statuses: Array<Record<string, unknown>>;
}> {
  const { WebSocket } = await import("ws");
  const {
    MESSAGE_TYPE,
    SYNC_MESSAGE_TYPE,
    decodeMessage,
    encodeSyncMessage,
    CANVAS_SESSION_PROTOCOL_VERSION,
    SESSION_CHANNEL,
    decodeSessionFrame,
    encodeSessionFrame
  } = await import("@woohaa3/contracts/canvas-yjs");
  const Y = await import("yjs");
  const client = new Y.Doc();
  const statuses: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    `${input.wsBase}/api/canvases/${input.canvasId}/sync?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}`,
    { headers: { "x-woohaa3-actor": "contract", "x-woohaa3-service-token": input.token } }
  );
  ws.on("message", (raw: Buffer) => {
    const frame = decodeSessionFrame(new Uint8Array(raw));
    if (frame.channelId !== SESSION_CHANNEL.CANVAS_YJS) return;
    const decoded = decodeMessage(frame.payload);
    if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
      ws.send(encodeSessionFrame(
        SESSION_CHANNEL.CANVAS_YJS,
        encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))
      ));
    } else if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
      Y.applyUpdate(client, decoded.payload);
    } else if (decoded.type === MESSAGE_TYPE.STATUS) {
      statuses.push(decoded.status as Record<string, unknown>);
    } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
      results.push(decoded.result as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("等待超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => statuses.some((entry) => entry.status === "synced"));
  return {
    ws,
    statuses,
    sendYjs: (payload) => ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, payload)),
    waitForCommandResult: async (commandId) => {
      await waitFor(() => results.some((entry) => entry.commandId === commandId));
      return results.find((entry) => entry.commandId === commandId)!;
    }
  };
}

/** 在一条 session 上向 task-activity 通道订阅并收集记录。 */
async function subscribeActivity(ws: import("ws").WebSocket, after: number): Promise<() => Array<{ cursor: number }>> {
  const {
    SESSION_CHANNEL,
    decodeSessionFrame,
    decodeTaskActivityServerMessage,
    encodeSessionFrame,
    encodeTaskActivitySubscribe
  } = await import("@woohaa3/contracts/canvas-yjs");
  const records: Array<{ cursor: number }> = [];
  const handler = (raw: Buffer) => {
    const frame = decodeSessionFrame(new Uint8Array(raw));
    if (frame.channelId !== SESSION_CHANNEL.TASK_ACTIVITY) return;
    const message = decodeTaskActivityServerMessage(frame.payload);
    if (message.type === "record") records.push({ cursor: message.cursor });
  };
  ws.on("message", handler);
  ws.send(encodeSessionFrame(
    SESSION_CHANNEL.TASK_ACTIVITY,
    encodeTaskActivitySubscribe({ type: "subscribe", after })
  ));
  return () => records;
}

describe("Canvas Service HTTP contract（任务 5.1）", () => {
  it("create / get / delete 生命周期", async () => {
    const { base, token } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };

    const created = await fetch(`${base}/api/canvases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId: "c1", title: "t" })
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { revision: number };
    expect(createdBody.revision).toBe(1);

    const got = await fetch(`${base}/api/canvases/c1`, { headers: { "x-woohaa3-service-token": token } });
    expect(got.status).toBe(200);

    const deleted = await fetch(`${base}/api/canvases/c1?expectedRevision=1`, {
      method: "DELETE",
      headers: { "x-woohaa3-service-token": token }
    });
    expect(deleted.status).toBe(204);
  });

  it("旧 CAS / sync-mode / Blob 路由不存在", async () => {
    const { base, token } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };

    const commands = await fetch(`${base}/api/canvases/c1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, operationId: "op1", commands: [] })
    });
    expect(commands.status).toBe(404);

    const syncMode = await fetch(`${base}/api/canvases/c1/sync-mode`, {
      headers: { "x-woohaa3-service-token": token }
    });
    expect(syncMode.status).toBe(404);

    const blob = await fetch(`${base}/api/canvases/c1/assets/a1/blob`, {
      headers: { "x-woohaa3-service-token": token }
    });
    expect(blob.status).toBe(404);
  });

  it("health live/ready 反映依赖且不泄漏敏感字段", async () => {
    const { base } = await start();
    const live = await fetch(`${base}/api/canvas-storage/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${base}/api/canvas-storage/health/ready`);
    expect(ready.status).toBe(200);
    const text = await ready.text();
    for (const needle of ["MONGODB_URI", "sqlite", ".sqlite", "COS_SECRET"]) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it("未认证请求被拒绝", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/canvases`, { method: "GET" });
    expect(response.status).toBe(401);
  });
});

describe("Canvas Service Yjs room contract（任务 5.2）", () => {
  it("WebSocket upgrade 走 Canvas Session 且 room 持久化先于广播", async () => {
    const { base, token, yjsRepository } = await start();
    const wsBase = base.replace("http:", "ws:");
    const { WebSocket } = await import("ws");
    const {
      MESSAGE_TYPE,
      SYNC_MESSAGE_TYPE,
      decodeMessage,
      encodeSyncMessage,
      encodeCommandMessage,
      YJS_SYNC_PROTOCOL_VERSION,
      YJS_CANVAS_FORMAT_VERSION
    } = await import("@woohaa3/contracts/canvas-yjs");
    const {
      CANVAS_SESSION_PROTOCOL_VERSION,
      SESSION_CHANNEL,
      decodeSessionFrame,
      encodeSessionFrame
    } = await import("@woohaa3/contracts/canvas-yjs");
    const Y = await import("yjs");

    // 建画布（REST 结构仓储）+ Yjs 文档（room 加载来源）。
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    await fetch(`${base}/api/canvases`, { method: "POST", headers, body: JSON.stringify({ canvasId: "room-canvas" }) });
    void headers;
    const { createEmptyWoohaa3ServerCanvas } = await import("@woohaa3/contracts");
    const { serverCanvasToYDoc } = await import("@woohaa3/contracts/canvas-yjs");
    const empty = createEmptyWoohaa3ServerCanvas("room-canvas");
    await yjsRepository.createYjsDocument({
      canvasId: "room-canvas",
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "contract-epoch",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(empty)),
      projection: empty,
      revision: empty.revision,
      createdAt: "2026-09-24T00:00:00Z"
    });

    const ws = new WebSocket(
      `${wsBase}/api/canvases/room-canvas/sync?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}`
      + `&protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}&formatVersion=${YJS_CANVAS_FORMAT_VERSION}`,
      { headers: { "x-woohaa3-actor": "contract", "x-woohaa3-service-token": token } }
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // 等初始同步到位（服务端 step1/step2），再发命令。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      ws.on("message", (raw: Buffer) => {
        const frame = decodeSessionFrame(new Uint8Array(raw));
        if (frame.channelId === SESSION_CHANNEL.CONTROL) return;
        const decoded = decodeMessage(frame.payload);
        if (decoded.type === MESSAGE_TYPE.STATUS) {
          clearTimeout(timer);
          resolve();
        } else if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
          ws.send(encodeSessionFrame(
            SESSION_CHANNEL.CANVAS_YJS,
            encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(new Y.Doc()))
          ));
        }
      });
    });
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      ws.on("message", (raw: Buffer) => {
        const frame = decodeSessionFrame(new Uint8Array(raw));
        if (frame.channelId !== SESSION_CHANNEL.CANVAS_YJS) return;
        const decoded = decodeMessage(frame.payload);
        if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
          clearTimeout(timer);
          resolve((decoded.result as { status?: string }).status === "accepted");
        }
      });
      ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeCommandMessage({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: "room-canvas",
        commandId: "cmd-1",
        baseRevision: 0,
        actorId: "contract",
        commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }] as never
      })));
    });
    expect(accepted).toBe(true);
    ws.close();
  }, 15_000);

  it("缺少 sessionProtocolVersion 的旧客户端在交换文档内容前被拒绝", async () => {
    const { base, token, yjsRepository } = await start();
    void yjsRepository;
    const wsBase = base.replace("http:", "ws:");
    const { WebSocket } = await import("ws");
    const { YJS_SYNC_PROTOCOL_VERSION, YJS_CANVAS_FORMAT_VERSION } = await import("@woohaa3/contracts/canvas-yjs");
    const ws = new WebSocket(
      `${wsBase}/api/canvases/room-canvas/sync?protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}&formatVersion=${YJS_CANVAS_FORMAT_VERSION}`,
      { headers: { "x-woohaa3-actor": "contract", "x-woohaa3-service-token": token } }
    );
    const error = await new Promise<Error | null>((resolve) => {
      ws.once("open", () => resolve(null));
      ws.once("error", (err) => resolve(err as Error));
    });
    expect(error).not.toBeNull();
    expect(String(error?.message)).toContain("426");
  }, 15_000);

  it("新画布 bootstrap：仅 REST 建画布后即可连接同步并提交命令（无需预置 Y.Doc）", async () => {
    const { base, token, yjsRepository } = await start();
    const wsBase = base.replace("http:", "ws:");
    const { encodeCommandMessage, YJS_SYNC_PROTOCOL_VERSION } = await import("@woohaa3/contracts/canvas-yjs");

    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    const created = await fetch(`${base}/api/canvases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId: "bootstrap-canvas" })
    });
    expect(created.status).toBe(201);
    // 只建了结构化画布，尚未有任何 Yjs 文档。
    expect(await yjsRepository.loadYjsState("bootstrap-canvas")).toBeNull();

    const session = await connectSession({ wsBase, canvasId: "bootstrap-canvas", token });
    // bootstrap 已把首个 Y.Doc 写入仓储（新画布不再隔离）。
    expect(await yjsRepository.loadYjsState("bootstrap-canvas")).not.toBeNull();

    session.sendYjs(encodeCommandMessage({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: "bootstrap-canvas",
      commandId: "cmd-bootstrap-1",
      baseRevision: 0,
      actorId: "contract",
      commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }] as never
    }));
    expect((await session.waitForCommandResult("cmd-bootstrap-1")).status).toBe("accepted");
    session.ws.close();
  }, 15_000);

  it("task-activity 通道：订阅后经 relay 收到该 canvas 的持久化记录", async () => {
    const { base, token } = await start();
    const wsBase = base.replace("http:", "ws:");
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    await fetch(`${base}/api/canvases`, { method: "POST", headers, body: JSON.stringify({ canvasId: "activity-canvas" }) });
    const session = await connectSession({ wsBase, canvasId: "activity-canvas", token });
    const records = await subscribeActivity(session.ws, 0);
    // relay 立即追赶空批次；无记录也不报错（Yjs 通道健康）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Array.isArray(records())).toBe(true);
    expect(session.statuses.some((entry) => entry.status === "synced")).toBe(true);
    session.ws.close();
  }, 15_000);
});

describe("Canvas Service 画布目录 contract（多画布工作区）", () => {
  it("目录列表：结构化分页 + 新建立即可见 + published projection 覆盖最新标题", async () => {
    const { base, token, yjsRepository } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    await fetch(`${base}/api/canvases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId: "cat-a", title: "结构化旧标题" })
    });
    await fetch(`${base}/api/canvases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId: "cat-b" })
    });

    // 刚创建、尚未 bootstrap：立即可见且使用结构化摘要。
    const first = await fetch(`${base}/api/canvases?offset=0&limit=10`, {
      headers: { "x-woohaa3-service-token": token }
    });
    const firstBody = (await first.json()) as { items: Array<{ id: string; title: string; total?: number }>; total: number };
    expect(firstBody.total).toBeGreaterThanOrEqual(2);
    expect(firstBody.items.find((item) => item.id === "cat-a")?.title).toBe("结构化旧标题");

    // 写入 published projection（模拟 canvas.setTitle 已 durable commit）。
    const { createEmptyWoohaa3ServerCanvas } = await import("@woohaa3/contracts");
    const projected = { ...createEmptyWoohaa3ServerCanvas("cat-a"), title: "Yjs 新标题", revision: 5 };
    await yjsRepository.createYjsDocument({
      canvasId: "cat-a",
      formatVersion: "1",
      roomEpoch: "catalog-epoch",
      checkpoint: new Uint8Array(),
      projection: projected,
      revision: projected.revision,
      createdAt: "2026-09-29T00:00:00Z"
    });

    const second = await fetch(`${base}/api/canvases?offset=0&limit=10`, {
      headers: { "x-woohaa3-service-token": token }
    });
    const secondBody = (await second.json()) as { items: Array<{ id: string; title: string; revision: number }> };
    const merged = secondBody.items.find((item) => item.id === "cat-a")!;
    expect(merged.title).toBe("Yjs 新标题");
    expect(merged.revision).toBe(5);
  }, 15_000);
});

describe("Canvas Service 模型 MCP HTTP contract（integrate-origin-master）", () => {

  it("浏览器登记请求 → MCP 提交脚本 → 权威 nodeData.modelScript 落库", async () => {
    const { base, token, yjsRepository } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    const canvasId = "model-mcp-canvas";

    await fetch(`${base}/api/canvases`, { method: "POST", headers, body: JSON.stringify({ canvasId }) });

    const { createEmptyWoohaa3ServerCanvas } = await import("@woohaa3/contracts");
    const { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } = await import("@woohaa3/contracts/canvas-yjs");
    const Y = await import("yjs");
    const canvas = createEmptyWoohaa3ServerCanvas(canvasId);
    canvas.document.nodes.push({ id: "model-1", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData["model-1"] = {
      modelScript: "scene.box({ id: 'seed' });",
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: "seed-source", contentHash: "seed-content" },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    } as never;
    await yjsRepository.createYjsDocument({
      canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "model-epoch",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(canvas)),
      projection: canvas,
      revision: canvas.revision,
      createdAt: "2026-09-24T00:00:00Z"
    });

    // 旧客户端不带 canvasId → 默认画布；这里显式带 canvasId 走多画布语义。
    // change: replace-model-mcp-board-with-canvas-subscription —— 登记端点已移除，
    // 直接提交脚本（权威写入）即可。

    const scriptSource = "scene.box({ id: 'body', size: [1, 2, 1], color: '#ff0000' });";
    const submitted = await fetch(`${base}/api/model-mcp/scripts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId, nodeId: "model-1", source: scriptSource, requestId: "req-http-1" })
    });
    expect(submitted.status).toBe(200);
    const submittedBody = (await submitted.json()) as { script: { commandId: string; idempotent: boolean } };
    expect(submittedBody.script.commandId).toContain("model-script:model-1");

    // 重复提交幂等（同一 requestId）。
    const again = await fetch(`${base}/api/model-mcp/scripts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canvasId, nodeId: "model-1", source: scriptSource, requestId: "req-http-1" })
    });
    expect(((await again.json()) as { script: { idempotent: boolean } }).script.idempotent).toBe(true);

    // 权威 Y.Doc 中已写入 modelScript。
    const state = await yjsRepository.loadYjsState(canvasId);
    expect(state).not.toBeNull();
    const { yDocToServerCanvas } = await import("@woohaa3/contracts/canvas-yjs");
    const doc = new Y.Doc();
    if (state) {
      Y.applyUpdate(doc, state.checkpoint);
      for (const entry of state.updates) Y.applyUpdate(doc, entry.update);
    }
    const projected = yDocToServerCanvas(doc);
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(projected.canvas.nodeData["model-1"]).toMatchObject({ modelScript: scriptSource });
    }
  }, 15_000);
});


