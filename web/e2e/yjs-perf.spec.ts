/**
 * Yjs 同步性能基线（change: add-yjs-canvas-sync，任务 9.4）。
 *
 * 用协议层直接测「初始 sync / 增量 bytes / 命令 p95 / 恢复时间」，据此设置默认硬限制。
 * 场景与 `notes/yjs-baseline.md` 的单元基线互补：那里测单机 Y.Doc 计算，这里测**真实
 * WebSocket + room + 持久化**的端到端成本。
 */
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import { MESSAGE_TYPE, SYNC_MESSAGE_TYPE, YJS_SYNC_PROTOCOL_VERSION, encodeCommandMessage, encodeSyncMessage } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

/** 一个带 N 个节点的画布（用于初始 sync 基线）。 */
function canvasWithNodes(id: string, count: number) {
  const now = "2026-09-23T00:00:00.000Z";
  return {
    id,
    title: "perf canvas",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `n${index}`,
        type: "text",
        position: { x: index * 10, y: 0 },
        width: 260,
        height: 195,
        zIndex: index + 1
      })),
      edges: [],
      updatedAt: now
    },
    nodeData: Object.fromEntries(Array.from({ length: count }, (_, index) => [`n${index}`, { prompt: `p${index}` }])),
    assets: [],
    jobs: [],
    updatedAt: now
  };
}

async function enableYjs(canvas: ReturnType<typeof canvasWithNodes>): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: canvas.id, canvas })
  });
  expect(response.ok).toBe(true);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

test.describe("Yjs 同步性能基线", () => {
  test("9.4 初始 sync / 增量 bytes / 命令 p95 / 重连恢复时间", async () => {
    const canvasId = `e2e-perf-${Math.random().toString(36).slice(2, 10)}`;
    const canvas = canvasWithNodes(canvasId, 100);
    await enableYjs(canvas);

    // —— 初始 sync：空 state vector 拉全量。
    const client = new Y.Doc();
    const syncBytes: number[] = [];
    const statuses: Array<Record<string, unknown>> = [];
    const results: Array<{ at: number; commandId: string; status: string }> = [];
    const sendTimes = new Map<string, number>();

    const ws = new WebSocket(
      sessionWsUrl({ wsBase: BASE_WS, canvasId, roomEpoch: "e2e-epoch" })
    );
    ws.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (!decoded) return;
      if (decoded.type === MESSAGE_TYPE.SYNC) {
        if (decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
          syncBytes.push(decoded.payload.byteLength);
          Y.applyUpdate(client, decoded.payload);
        }
        if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
          ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
        }
        return;
      }
      if (decoded.type === MESSAGE_TYPE.STATUS) {
        statuses.push(decoded.status as Record<string, unknown>);
        return;
      }
      if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
        const result = decoded.result as Record<string, unknown>;
        const sentAt = sendTimes.get(String(result.commandId)) ?? Date.now();
        results.push({ at: Date.now() - sentAt, commandId: String(result.commandId), status: String(result.status) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const initialStart = Date.now();
    ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
    await waitFor(() => statuses.some((entry) => entry.status === "synced"));
    const initialSyncMs = Date.now() - initialStart;
    const initialSyncBytes = syncBytes.reduce((sum, value) => sum + value, 0);

    // —— 20 次单节点命令，测延迟与增量字节。
    syncBytes.length = 0;
    for (let index = 0; index < 20; index += 1) {
      const commandId = `perf-${index}`;
      sendTimes.set(commandId, Date.now());
      const before = syncBytes.reduce((sum, value) => sum + value, 0);
      ws.send(yjsFrame(encodeCommandMessage({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId,
        baseRevision: 0,
        actorId: "perf",
        commands: [{ type: "node.add", node: { id: `new-${index}`, type: "text", position: { x: 0, y: index * 10 } } }]
      })));
      await waitFor(() => results.some((entry) => entry.commandId === commandId));
      void before;
    }
    const latencies = results.map((entry) => entry.at);
    const incrementalBytes = syncBytes.reduce((sum, value) => sum + value, 0);

    // —— 重连恢复：新连接用当前 state vector 拉到「零差量」，时间应接近往返成本。
    const reconnectStart = Date.now();
    const reconnected: Array<Record<string, unknown>> = [];
    const ws2 = new WebSocket(
      sessionWsUrl({ wsBase: BASE_WS, canvasId, roomEpoch: "e2e-epoch" })
    );
    ws2.on("message", (data: Buffer) => {
      const decoded = decodeYjsFrame(new Uint8Array(data));
      if (decoded?.type === MESSAGE_TYPE.STATUS) reconnected.push(decoded.status as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    ws2.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
    await waitFor(() => reconnected.some((entry) => entry.status === "synced"));
    const reconnectMs = Date.now() - reconnectStart;

    const baseline = {
      initialSyncMs,
      initialSyncBytes,
      incrementalBytes,
      commandCount: latencies.length,
      commandP95Ms: percentile(latencies, 0.95),
      reconnectMs
    };
    // eslint-disable-next-line no-console
    console.info("[yjs-e2e-baseline]", JSON.stringify(baseline));

    // 断言（宽松上限，拦截数量级回归；数值记录在 notes 里）。
    expect(initialSyncBytes).toBeGreaterThan(0);
    expect(incrementalBytes).toBeGreaterThan(0);
    expect(latencies.length).toBe(20);
    expect(baseline.commandP95Ms).toBeLessThan(2_000);
    expect(initialSyncMs).toBeLessThan(5_000);
    expect(reconnectMs).toBeLessThan(5_000);

    ws.close();
    ws2.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
