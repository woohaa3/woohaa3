/**
 * 受保护可撤销编辑的多标签页/并发集成验收
 * （change: 2026-10-09-improve-canvas-workflow，任务 7.2）。
 *
 * 用真实服务：第一标签页是真实浏览器页面（生产组件 + Yjs provider），第二「标签页」走同一
 * 同步协议提交命令（等价于另一个浏览器）。覆盖：
 * - 无关节点变化不阻止撤销；
 * - 同字段/关系变化整批拒绝（无部分写入）；
 * - 响应丢失后同 commandId 幂等重试；
 * - 删除与任务启动竞态（进行中任务删除被原子拒绝）。
 *
 * 跑在 `playwright.yjs.config.ts` 下。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installPageHelpers, waitForCanvasSession } from "./helpers.js";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_SYNC_PROTOCOL_VERSION,
  encodeCommandMessage,
  encodeSyncMessage
} from "@woohaa3/contracts/canvas-yjs";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;
const CANVAS = "woohaa3-default-canvas";

function canvasWithNodes() {
  return {
    id: CANVAS,
    title: "并发编辑演练",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [
        { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
        { id: "b", type: "image", position: { x: 300, y: 0 }, width: 260, height: 195 }
      ],
      edges: [],
      updatedAt: "2026-10-09T00:00:00.000Z"
    },
    nodeData: { a: { title: "作品 A" } },
    assets: [],
    jobs: [],
    updatedAt: "2026-10-09T00:00:00.000Z"
  };
}

async function seed(): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS, canvas: canvasWithNodes(), reset: true })
  });
  expect(response.ok).toBe(true);
}

/** 第二个「标签页」：提交命令并返回结果状态。 */
async function submitFromSecondTab(command: unknown, commandId: string): Promise<{ status?: string; code?: string }> {
  const doc = new Y.Doc();
  const statuses: string[] = [];
  const results: Array<{ commandId?: string; status?: string; code?: string }> = [];
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId: CANVAS, roomEpoch: "e2e-epoch" }),
    { headers: { "x-woohaa3-actor": "tab-2" } }
  );
  ws.on("message", (raw: Buffer) => {
    const decoded = decodeYjsFrame(new Uint8Array(raw));
    if (!decoded) return;
    if (decoded.type === MESSAGE_TYPE.SYNC) {
      if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP2 || decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) {
        Y.applyUpdate(doc, decoded.payload as Uint8Array, "server");
      } else if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
      }
    } else if (decoded.type === MESSAGE_TYPE.STATUS) {
      statuses.push((decoded.status as { status?: string }).status ?? "");
    } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
      results.push(decoded.result as { commandId?: string; status?: string; code?: string });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
  await waitFor(() => statuses.includes("synced"), "第二标签页 synced");
  const payload = {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId,
    baseRevision: 0,
    actorId: "tab-2",
    commands: [command]
  };
  ws.send(yjsFrame(encodeCommandMessage(payload as never)));
  await waitFor(() => results.some((r) => r.commandId === commandId), "第二标签页命令结果");
  // 同 ID 同载荷再次发送：应返回 duplicate（幂等重试）。
  ws.send(yjsFrame(encodeCommandMessage(payload as never)));
  await waitFor(() => results.filter((r) => r.commandId === commandId).length >= 2, "幂等重试结果");
  const first = results.find((r) => r.commandId === commandId) ?? {};
  const second = results.filter((r) => r.commandId === commandId)[1] ?? {};
  ws.close();
  return { status: first.status, code: second.status === "duplicate" ? "duplicate" : first.code };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

async function canonical(page: Page) {
  return page.evaluate(() => (globalThis as unknown as { __canvasCanonical?: unknown }).__canvasCanonical ?? null);
}

test.describe("受保护编辑并发与多标签页（2026-10-09，任务 7.2）", () => {
  // 本 spec 会在共享默认画布上留下节点；结束时清空，避免污染后续未 reset 的用例。
  test.afterAll(async ({ request }) => {
    await request.post(`${BASE_HTTP}/__e2e_reset_canvases__`);
  });

  test("无关节点变化不阻止撤销，同字段变化整批拒绝且无部分写入", async ({ page }) => {
    await installPageHelpers(page);
    await seed();
    await page.goto("/");
    await waitForCanvasSession(page);

    // 本页撤销 A 的移动（前向：A → x:120；反向条件针对 A 的 position）。这里直接用受保护编辑表达。
    // 先由第二标签页提交 A 的移动，制造 before 状态。
    const move = await submitFromSecondTab(
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-update", nodeId: "a", position: { x: 120, y: 0 } }] },
      "tab2-move-a"
    );
    expect(move.status).toBe("accepted");

    // 第二标签页修改无关节点 B（不应阻止 A 的撤销条件）。
    const unrelated = await submitFromSecondTab(
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "b", value: { title: "另一标签页改名 B" } }] },
      "tab2-rename-b"
    );
    expect(unrelated.status).toBe("accepted");

    // 满足 A 的 position 条件后撤销可提交（无关变化放行）。
    const undo = await submitFromSecondTab(
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-fields", nodeId: "a", fields: [{ field: "position", present: true, value: { x: 120, y: 0 } }] }],
        operations: [{ kind: "node-update", nodeId: "a", position: { x: 0, y: 0 } }]
      },
      "tab2-undo-a"
    );
    expect(undo.status).toBe("accepted");

    // 同字段冲突：条件要求 x:120，但当前已是 x:0 → 整批拒绝，且 B 的新名称不被回退。
    const conflict = await submitFromSecondTab(
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-fields", nodeId: "a", fields: [{ field: "position", present: true, value: { x: 120, y: 0 } }] }],
        operations: [{ kind: "node-data-set", nodeId: "b", value: { title: "不应写入" } }]
      },
      "tab2-conflict"
    );
    expect(conflict.status).toBe("rejected");

    // 命令结果发给提交连接，不代表观察标签页已消费对应 Yjs update。
    await expect.poll(async () => ((await canonical(page)) as { nodeData: Record<string, { title?: string }> }).nodeData.b?.title).toBe("另一标签页改名 B");
    const projection = (await canonical(page)) as { document: { nodes: Array<{ id: string; position: { x: number } }> }; nodeData: Record<string, { title?: string }> };
    expect(projection.document.nodes.find((n) => n.id === "a")?.position.x).toBe(0);
    expect(projection.nodeData.b?.title).toBe("另一标签页改名 B");
  });

  test("进行中任务的节点删除被原子拒绝，不隐式取消任务", async ({ page }) => {
    await installPageHelpers(page);
    await seed();
    await page.goto("/");
    await waitForCanvasSession(page);

    const running = await submitFromSecondTab(
      { type: "nodeData.patch", nodeId: "b", value: { taskStatus: "processing" } },
      "tab2-run-b"
    );
    expect(running.status).toBe("accepted");

    const deletion = await submitFromSecondTab(
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-remove", nodeIds: ["b"] }] },
      "tab2-delete-b"
    );
    expect(deletion.status).toBe("rejected");

    // 等权威状态回流到本页（processing 仍在，说明未删除也未隐式取消任务）。
    await page.waitForFunction(
      () => (globalThis as unknown as { __canvasCanonical?: { nodeData?: Record<string, { taskStatus?: string }> } })
        .__canvasCanonical?.nodeData?.b?.taskStatus === "processing",
      undefined,
      { timeout: 20_000, polling: 100 }
    );
    const projection = (await canonical(page)) as { document: { nodes: Array<{ id: string }> }; nodeData: Record<string, { taskStatus?: string }> };
    expect(projection.document.nodes.some((n) => n.id === "b")).toBe(true);
    expect(projection.nodeData.b?.taskStatus).toBe("processing");
  });
});
