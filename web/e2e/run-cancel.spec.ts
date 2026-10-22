/**
 * run/cancel + projector 增量接线 E2E（change: split-web-runtime-services，任务 1.1）。
 *
 * 这条用例验证**实际主链路**与规范一致，且不依赖 UI：
 * - 通过同源 `POST /api/canvases/:id/runs` 发起 run（只提交，不等待终态）；
 * - 由服务端 projector 从 runtime history 消费终态并写入权威 Y.Doc；
 * - 通过同步协议读回 Y.Doc，断言节点最终为 successed。
 *
 * 前置：E2E server 启用画布存储 + Yjs 同步（playwright.yjs.config.ts）。
 */
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import { MESSAGE_TYPE, SYNC_MESSAGE_TYPE, encodeSyncMessage, YJS_SYNC_PROTOCOL_VERSION, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";
import * as Y from "yjs";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

function emptyCanvas(canvasId: string, revision = 0) {
  return {
    id: canvasId,
    title: "E2E run 画布",
    revision,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
      updatedAt: "2026-09-23T00:00:00.000Z"
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-23T00:00:00.000Z"
  };
}

async function enableYjs(canvas: ReturnType<typeof emptyCanvas>): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: canvas.id, canvas })
  });
  expect(response.ok).toBe(true);
}

/** 连一个只读同步客户端，持续把 update 应用到本地 Y.Doc。 */
function connectReader(canvasId: string, actorId = "e2e-reader") {
  const doc = new Y.Doc();
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId, roomEpoch: "e2e-epoch" }),
    { headers: { "x-woohaa3-actor": actorId } }
  );
  ws.on("open", () => {
    ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
  });
  ws.on("message", (raw: Buffer) => {
    const decoded = decodeYjsFrame(new Uint8Array(raw));
    if (!decoded) return;
    if (decoded.type === MESSAGE_TYPE.SYNC) {
      const syncType = decoded.syncType as number;
      if (syncType === SYNC_MESSAGE_TYPE.STEP2 || syncType === SYNC_MESSAGE_TYPE.UPDATE) {
        Y.applyUpdate(doc, decoded.payload as Uint8Array, "server");
      } else if (syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
      }
    }
  });
  return { doc, ws };
}

async function waitForNodeStatus(
  reader: { doc: Y.Doc },
  canvasId: string,
  nodeId: string,
  status: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exported = yDocToServerCanvas(reader.doc);
    if (exported.ok) {
      const node = exported.canvas.nodeData[nodeId] as { taskStatus?: string } | undefined;
      if (node?.taskStatus === status) return;
    }
    if (Date.now() > deadline) {
      const exported = yDocToServerCanvas(reader.doc);
      throw new Error(
        `等待 ${nodeId} -> ${status} 超时；当前：${JSON.stringify(
          exported.ok ? exported.canvas.nodeData[nodeId] : null
        )}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test.describe("run/cancel 主链路（任务 1.1）", () => {
  test("run 只提交并由 projector 写终态", async () => {
    const canvasId = `e2e-run-${Math.random().toString(36).slice(2, 10)}`;
    await enableYjs(emptyCanvas(canvasId));
    const reader = connectReader(canvasId);
    try {
      // 等初始同步到位。
      await new Promise((resolve) => setTimeout(resolve, 300));

      const response = await fetch(`${BASE_HTTP}/api/canvases/${canvasId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: "text-1",
          runId: "run-e2e-1",
          jobId: "job-e2e-1",
          modelKey: "fixture:gemini-2.5-flash",
          prompt: "E2E run",
          parameters: { model: "fixture:gemini-2.5-flash" }
        })
      });
      // 只受理：202 accepted，不等待 worker 终态。
      expect(response.status).toBe(202);
      const body = (await response.json()) as { ok: boolean; state: string };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("accepted");

      // 终态由 projector 从 runtime history 消费并写入 Y.Doc。
      await waitForNodeStatus(reader, canvasId, "text-1", "successed");
    } finally {
      reader.ws.close();
    }
  });

  test("取消非 active run 被拒绝", async () => {
    const canvasId = `e2e-run-${Math.random().toString(36).slice(2, 10)}`;
    await enableYjs(emptyCanvas(canvasId));
    const response = await fetch(`${BASE_HTTP}/api/canvases/${canvasId}/runs/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "text-1", runId: "not-active" })
    });
    expect(response.status).toBe(409);
  });
});
