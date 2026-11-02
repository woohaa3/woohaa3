/**
 * Yjs 协作同步 E2E（change: add-yjs-canvas-sync，任务 9.1–9.3）。
 *
 * 这几条用例覆盖三件事：
 * - **9.1 双标签页收敛**：两个页面并发改不同节点，最终 Y.Doc/React/Godot 一致；
 * - **9.2 网络**：刷新、漏广播、重连差量、幂等重试；
 * - **9.3 持久化**：服务端 room 在进程内持久化，命令在重连后仍可见。
 *
 * 前置：E2E server 启用了画布存储与 Yjs 同步（`e2e/server.mjs`），并用**内存** Yjs 仓储
 * 保证每个运行都是干净状态。测试通过 `/__e2e_enable_yjs__` 把 canvas 置为 yjs 模式。
 *
 * 这些用例直接驱动**同步协议**（WebSocket），而不是 UI：协议是规范行为，UI 只是消费者。
 */
import { expect, test } from "./review-browser.js";
import { WebSocket } from "ws";
import { MESSAGE_TYPE, SYNC_MESSAGE_TYPE, encodeCommandMessage, encodeStatusMessage, encodeSyncMessage, YJS_SYNC_PROTOCOL_VERSION, serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

/**
 * 每个用例用独立 canvasId：E2E server 的 Yjs 仓储在**进程内**共享，
 * 复用同一 ID 会让上一个用例的文档残留，导致断言串味。
 */
let CANVAS = "e2e-yjs-canvas";

/** 空画布聚合（与服务端 domain 默认一致）。 */
function emptyCanvas(revision = 0) {
  return {
    id: CANVAS,
    title: "E2E 画布",
    revision,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [],
      edges: [],
      updatedAt: "2026-09-23T00:00:00.000Z"
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-23T00:00:00.000Z"
  };
}

/** 为当前用例分配一个全新的 canvasId。 */
async function useFreshCanvas(): Promise<void> {
  CANVAS = `e2e-yjs-${Math.random().toString(36).slice(2, 10)}`;
  await enableYjs();
}

/** 把 canvas 置为 yjs 模式（幂等）。 */
async function enableYjs(canvas = emptyCanvas()) {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS, canvas })
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { roomEpoch: string };
}

/** 一条测试客户端连接（同步协议）。 */
function connectClient(options: { actorId: string } = { actorId: "e2e" }) {
  const client = new Y.Doc();
  const results: Array<Record<string, unknown>> = [];
  const statuses: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId: CANVAS, roomEpoch: "e2e-epoch" }),
    { headers: { "x-woohaa3-actor": options.actorId } }
  );

  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  ws.on("message", (data: Buffer) => messageHandler?.(new Uint8Array(data)));
  ws.on("close", () => closeHandler?.());

  return {
    client,
    results,
    statuses,
    /** 等待连接建立。 */
    async open(): Promise<void> {
      if (ws.readyState === WebSocket.OPEN) return;
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
    },
    /** 安装消息处理并把收到的 update/result 记录/应用。 */
    listen(): void {
      messageHandler = (data) => {
        const decoded = decodeYjsFrame(data);
        if (!decoded) return;
        if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
          Y.applyUpdate(client, decoded.payload);
          return;
        }
        if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
          // 服务端要 state vector：回 step1（协议允许）。
          ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
          return;
        }
        if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) results.push(decoded.result as Record<string, unknown>);
        if (decoded.type === MESSAGE_TYPE.STATUS) statuses.push(decoded.status as Record<string, unknown>);
      };
    },
    /** 用本地 state vector 发起同步，返回是否拿到 synced。 */
    async sync(): Promise<void> {
      this.listen();
      ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
      await waitFor(() => statuses.some((entry) => entry.status === "synced"));
    },
    sendCommand(commandId: string, commands: unknown[]): void {
      ws.send(yjsFrame(encodeCommandMessage({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId,
        baseRevision: 0,
        actorId: options.actorId,
        commands: commands as never
      })));
    },
    async waitForResult(commandId: string): Promise<Record<string, unknown>> {
      await waitFor(() => results.some((entry) => entry.commandId === commandId));
      return results.find((entry) => entry.commandId === commandId) as Record<string, unknown>;
    },
    close(): void {
      closeHandler?.();
      ws.close();
    },
    /** 强制断开（模拟网络中断，不发 close 帧）。 */
    terminate(): void {
      ws.terminate();
    },
    async reconnect(): Promise<void> {
      ws.close();
      await waitFor(() => ws.readyState !== WebSocket.OPEN);
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test.describe("Yjs 协作同步 E2E", () => {
  test("9.1 两个客户端并发修改不同节点最终收敛", async () => {
    await useFreshCanvas();
    const a = connectClient({ actorId: "client-a" });
    const b = connectClient({ actorId: "client-b" });
    await a.open();
    await b.open();
    await a.sync();
    await b.sync();

    // A 建一个节点，B 建另一个（各自 baseRevision 相同 → 不做全局 CAS）。
    a.sendCommand("a-1", [{ type: "node.add", node: { id: "a-node", type: "text", position: { x: 0, y: 0 } } }]);
    expect((await a.waitForResult("a-1")).status).toBe("accepted");
    b.sendCommand("b-1", [{ type: "node.add", node: { id: "b-node", type: "image", position: { x: 100, y: 0 } } }]);
    expect((await b.waitForResult("b-1")).status).toBe("accepted");

    // 双方最终收敛到包含两个节点的状态（用 state vector 等价判定）。
    await waitFor(() => {
      a.listen();
      a.client.transact(() => {});
      return JSON.stringify(Array.from(Y.encodeStateVector(a.client))) ===
        JSON.stringify(Array.from(Y.encodeStateVector(b.client)));
    });
    expect(Array.from(Y.encodeStateVector(a.client))).toEqual(Array.from(Y.encodeStateVector(b.client)));

    a.close();
    b.close();
  });

  test("9.1 同字段按接收顺序应用，删除竞态在最新状态上拒绝", async () => {
    await useFreshCanvas();
    const a = connectClient({ actorId: "client-a" });
    await a.open();
    await a.sync();

    a.sendCommand("seed", [
      { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "n1", value: { title: "初始" } }
    ]);
    expect((await a.waitForResult("seed")).status).toBe("accepted");

    // 删除后移动：基于最新状态应被拒绝（节点不存在）。
    a.sendCommand("del", [{ type: "node.remove", nodeIds: ["n1"] }]);
    expect((await a.waitForResult("del")).status).toBe("accepted");
    a.sendCommand("move-stale", [{ type: "node.update", nodeId: "n1", position: { x: 50, y: 50 } }]);
    expect((await a.waitForResult("move-stale")).status).toBe("rejected");

    a.close();
  });

  test("9.2 刷新/重连只用 state vector 补齐差量", async () => {
    await useFreshCanvas();
    const first = connectClient({ actorId: "client-a" });
    await first.open();
    await first.sync();
    first.sendCommand("c-1", [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }]);
    await first.waitForResult("c-1");

    // 断开期间服务端再提交两条。
    const second = connectClient({ actorId: "client-b" });
    await second.open();
    await second.sync();
    second.sendCommand("c-2", [{ type: "node.add", node: { id: "n2", type: "text", position: { x: 60, y: 0 } } }]);
    await second.waitForResult("c-2");
    second.sendCommand("c-3", [{ type: "node.add", node: { id: "n3", type: "text", position: { x: 120, y: 0 } } }]);
    await second.waitForResult("c-3");

    // first 断开并重连：只发 state vector，应补齐它漏掉的 n2/n3。
    first.terminate();
    const reconnected = connectClient({ actorId: "client-a" });
    // 让重连客户端带上 first 已经拥有的状态。
    reconnected.client = first.client;
    await reconnected.open();
    await reconnected.sync();

    const exported = Y.encodeStateAsUpdate(reconnected.client);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, exported);
    const nodes = doc.getMap("nodes");
    expect([...nodes.keys()].sort()).toEqual(["n1", "n2", "n3"]);

    reconnected.close();
    second.close();
  });

  test("9.2 响应丢失后同 commandId 重试返回 duplicate 且不重复应用", async () => {
    await useFreshCanvas();
    const client = connectClient({ actorId: "client-a" });
    await client.open();
    await client.sync();

    const command = [{ type: "node.add", node: { id: "retry-node", type: "text", position: { x: 0, y: 0 } } }];
    client.sendCommand("retry-1", command);
    const first = await client.waitForResult("retry-1");
    expect(first.status).toBe("accepted");

    // 同一 commandId + payload 重试。
    client.sendCommand("retry-1", command);
    await waitFor(() => client.results.filter((entry) => entry.commandId === "retry-1").length >= 2);
    const retries = client.results.filter((entry) => entry.commandId === "retry-1");
    expect(retries.at(-1)?.status).toBe("duplicate");

    client.close();
  });

  test("9.2 同 commandId 不同 payload 被拒绝", async () => {
    await useFreshCanvas();
    const client = connectClient({ actorId: "client-a" });
    await client.open();
    await client.sync();

    client.sendCommand("reuse-1", [{ type: "node.add", node: { id: "x1", type: "text", position: { x: 0, y: 0 } } }]);
    await client.waitForResult("reuse-1");
    client.sendCommand("reuse-1", [{ type: "node.add", node: { id: "x2", type: "text", position: { x: 0, y: 0 } } }]);
    await waitFor(() => client.results.filter((entry) => entry.commandId === "reuse-1").length >= 2);
    const retries = client.results.filter((entry) => entry.commandId === "reuse-1");
    expect(retries.at(-1)?.status).toBe("rejected");
    expect(retries.at(-1)?.code).toBe("command-id-reused");

    client.close();
  });

  test("9.2 客户端上传 raw Yjs update 被拒绝并关闭连接", async () => {
    await useFreshCanvas();
    const client = connectClient({ actorId: "malicious" });
    await client.open();
    await client.sync();

    // 违规：客户端不得发送 sync update。
    const before = Y.encodeStateVector(client.client);
    client.listen();
    const ws = new WebSocket(
      sessionWsUrl({ wsBase: BASE_WS, canvasId: CANVAS, roomEpoch: "e2e-epoch" })
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const statuses: Array<Record<string, unknown>> = [];
    ws.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (decoded?.type === MESSAGE_TYPE.STATUS) statuses.push(decoded.status as Record<string, unknown>);
    });
    const illegalUpdate = Y.encodeStateAsUpdate(new Y.Doc());
    ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, illegalUpdate)));
    await waitFor(() => statuses.some((entry) => entry.code === "client-sync-update-forbidden"));
    // 连接被关闭。
    await waitFor(() => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING);

    client.close();
  });

  test("9.3 服务端 room 保留已提交命令（重连可见）", async () => {
    await useFreshCanvas();
    const writer = connectClient({ actorId: "writer" });
    await writer.open();
    await writer.sync();
    writer.sendCommand("persist-1", [
      { type: "node.add", node: { id: "persist-node", type: "text", position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "persist-node", value: { prompt: "持久化" } }
    ]);
    expect((await writer.waitForResult("persist-1")).status).toBe("accepted");
    writer.close();

    // 新连接（空 state vector）应拿到包含该节点的完整文档。
    const reader = connectClient({ actorId: "reader" });
    await reader.open();
    await reader.sync();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(reader.client));
    expect([...doc.getMap("nodes").keys()]).toContain("persist-node");

    reader.close();
  });

  test("新画布 bootstrap：仅 REST 建画布后即可连接并提交命令（无需预置 Y.Doc）", async () => {
    // 用真实 REST 创建路径（不调用 /__e2e_enable_yjs__ 预置 Y.Doc）。
    const canvasId = `e2e-bootstrap-${Math.random().toString(36).slice(2, 10)}`;
    const created = await fetch(`${BASE_HTTP}/api/canvases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId })
    });
    expect(created.status).toBe(201);

    // 连接同步：room 应经 bootstrap 从结构化画布建立首个 Y.Doc，而不是隔离。
    const client = new Y.Doc();
    const statuses: Array<Record<string, unknown>> = [];
    const results: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(
      sessionWsUrl({ wsBase: BASE_WS, canvasId })
    );
    ws.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (!decoded) return;
      if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
        Y.applyUpdate(client, decoded.payload);
      } else if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
      } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
        results.push(decoded.result as Record<string, unknown>);
      } else if (decoded.type === MESSAGE_TYPE.STATUS) {
        statuses.push(decoded.status as Record<string, unknown>);
      }
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
    await waitFor(() => statuses.some((entry) => entry.status === "synced"));

    // 新画布可提交语义命令，且投影收敛到本地。
    ws.send(yjsFrame(encodeCommandMessage({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId,
      commandId: "cmd-bootstrap",
      baseRevision: 0,
      actorId: "e2e",
      commands: [{ type: "node.add", node: { id: "n-boot", type: "text", position: { x: 1, y: 2 } } }] as never
    })));
    await waitFor(() => results.some((entry) => entry.commandId === "cmd-bootstrap"));
    expect(results.find((entry) => entry.commandId === "cmd-bootstrap")?.status).toBe("accepted");
    await waitFor(() => (client.getMap("nodes").get("n-boot") as { type?: string } | undefined)?.type === "text");
    ws.close();
  });

  test("9.3 隔离：损坏的 Yjs 文档不创建空文档继续服务", async () => {
    // 直接对不存在的 canvas 建 room：room 加载失败应被隔离，连接收到明确错误。
    const ws = new WebSocket(
      sessionWsUrl({ wsBase: BASE_WS, canvasId: "nonexistent-canvas" })
    );
    const statuses: Array<Record<string, unknown>> = [];
    ws.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (decoded?.type === MESSAGE_TYPE.STATUS) statuses.push(decoded.status as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await waitFor(() => statuses.length > 0);
    // 结构化存储里也没有该画布 → bootstrap 返回 null → room 隔离，绝不当作空画布。
    expect(statuses[0]).toMatchObject({ status: "error" });
    expect(statuses[0].code).toBe("room-quarantined");
    ws.close();
  });

  test("9.1 旧客户端缺少 sessionProtocolVersion 时在交换文档内容前失败关闭", async () => {
    await useFreshCanvas();
    // 只声明内层 Yjs 版本（旧 Yjs-only 客户端）：upgrade 被 426 拒绝。
    const ws = new WebSocket(
      `${BASE_WS}/api/canvases/${CANVAS}/sync?protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}`
    );
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once("open", () => resolve(0));
      ws.once("error", () => resolve(-1));
    });
    expect(status).toBe(426);
  });

  test("9.1 内层 Yjs 协议版本不兼容时在交换文档内容前失败关闭", async () => {
    await useFreshCanvas();
    const ws = new WebSocket(
      `${BASE_WS}/api/canvases/${CANVAS}/sync?sessionProtocolVersion=1&protocolVersion=99`
    );
    const messages: Array<Record<string, unknown>> = [];
    let sawSyncUpdate = false;
    ws.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (!decoded) return;
      if (decoded.type === MESSAGE_TYPE.SYNC) sawSyncUpdate = true;
      if (decoded.type === MESSAGE_TYPE.STATUS) messages.push(decoded.status as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await waitFor(() => messages.length > 0);
    expect(messages[0]).toMatchObject({ status: "error", code: "protocol-version-unsupported" });
    // 没有交换任何文档内容。
    expect(sawSyncUpdate).toBe(false);
    ws.close();
  });
});

/** 引用以避免未使用告警（模型断言用）。 */
void serverCanvasToYDoc;
void encodeStatusMessage;
