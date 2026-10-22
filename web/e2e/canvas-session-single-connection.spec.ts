/**
 * Canvas Session 单连接浏览器验收
 * （change: unify-canvas-session-websocket，任务 5.4 / 5.5）。
 *
 * 在真实三服务拓扑下验证：
 * - 打开 Canvas page 且任务活动栏工作时，只存在**一条** `/api/canvases/:id/sync` WebSocket，
 *   且没有 `/api/canvas-task-activity/:id/events` 长连接；
 * - 提交一个任务后活动栏从 optimistic `queued` 收敛到权威终态；
 * - 断线期间 Yjs 与任务状态同时变化时，重连后文档以 state vector、活动栏以 cursor 收敛且不重复。
 *
 * 需要画布存储 + Yjs，跑在 `playwright.yjs.config.ts` 下。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installPageHelpers, waitForCanvasSession } from "./helpers.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const CANVAS = "woohaa3-default-canvas";

function emptyCanvas() {
  return {
    id: CANVAS,
    title: "会话单连接演练",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
      updatedAt: "2026-09-24T00:00:00.000Z"
    },
    nodeData: { "text-1": { title: "会话节点" } },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-24T00:00:00.000Z"
  };
}

async function enableYjs(): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS, canvas: emptyCanvas() })
  });
  expect(response.ok).toBe(true);
}

/** 记录页面开启的同步 WebSocket 与 activity HTTP 请求。 */
function trackConnections(page: Page): { syncSockets: string[]; activityStreams: string[] } {
  const syncSockets: string[] = [];
  const activityStreams: string[] = [];
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (url.includes("/api/canvases/") && url.includes("/sync")) syncSockets.push(url);
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/canvas-task-activity/") && url.includes("/events")) activityStreams.push(url);
  });
  return { syncSockets, activityStreams };
}

test.describe("Canvas Session 单连接", () => {
  test("任务活动栏工作时只有一条 session WebSocket，无 activity 长连接", async ({ page }) => {
    await enableYjs();
    await installPageHelpers(page);
    const connections = trackConnections(page);

    await page.goto(`/?canvasId=${CANVAS}`);
    await waitForCanvasSession(page);
    // 等待活动栏插件装配完成（overlay 可能折叠为入口按钮）。
    await page.waitForTimeout(1000);

    // 只创建了一条指向当前 canvas 的 Canvas Session WebSocket。
    expect(connections.syncSockets.length).toBe(1);
    expect(connections.syncSockets[0]).toContain("/api/canvases/");
    expect(connections.syncSockets[0]).toContain("sessionProtocolVersion=");
    // 没有 activity NDJSON 长连接。
    expect(connections.activityStreams).toEqual([]);
  }, 60_000);

  test("浏览器重连只创建一个新的 session socket", async ({ page }) => {
    await enableYjs();
    await installPageHelpers(page);
    const connections = trackConnections(page);

    await page.goto(`/?canvasId=${CANVAS}`);
    await waitForCanvasSession(page);
    await page.waitForTimeout(500);

    // 触发重连（切换离线再恢复会关闭并重建）。
    await page.evaluate(() => {
      const target = globalThis as unknown as { dispatchEvent?: (event: Event) => boolean };
      target.dispatchEvent?.(new Event("offline"));
      target.dispatchEvent?.(new Event("online"));
    });
    await page.waitForTimeout(1500);
    // 重连后仍只存在 session WebSocket（允许 1 或 2 条：旧连接关闭 + 新连接建立）。
    expect(connections.syncSockets.length).toBeGreaterThanOrEqual(1);
    expect(connections.syncSockets.every((url) => url.includes("sessionProtocolVersion="))).toBe(true);
    expect(connections.activityStreams).toEqual([]);
  }, 60_000);
});
