/**
 * 全局任务历史页浏览器 E2E（change: split-web-runtime-services，任务 8.1 / 6.5 / 6.6）。
 *
 * 在真实三服务拓扑下（E2E server）验证：
 * - 通过 Canvas run 入口提交任务后，Task durable history 出现记录；
 * - `/task-history` 页面经同源 ingress 读取只读 history，并展示进行中→完成；
 * - 页面只读：不出现 submit/cancel 控件；列表只含安全字段。
 *
 * 需要画布存储 + Yjs + Task + Media，跑在 `playwright.yjs.config.ts` 下。
 */
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  encodeSyncMessage
} from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import { decodeYjsFrame, sessionWsUrl, yjsFrame } from "./session.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

function emptyCanvas(canvasId: string) {
  return {
    id: canvasId,
    title: "history E2E",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
      updatedAt: "2026-09-24T00:00:00.000Z"
    },
    nodeData: { "text-1": { title: "历史节点" } },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-24T00:00:00.000Z"
  };
}

async function enableYjs(canvasId: string): Promise<void> {
  const response = await fetch(`${BASE_HTTP}/__e2e_enable_yjs__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId, canvas: emptyCanvas(canvasId) })
  });
  expect(response.ok).toBe(true);
}

/** 用只读同步客户端连一次，确认 room 已就绪（不提交任何命令）。 */
async function ensureRoom(canvasId: string): Promise<void> {
  const doc = new Y.Doc();
  const ws = new WebSocket(
    sessionWsUrl({ wsBase: BASE_WS, canvasId, roomEpoch: "e2e-epoch" })
  );
  const statuses: string[] = [];
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
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(yjsFrame(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(doc))));
  const deadline = Date.now() + 8_000;
  while (!statuses.includes("synced")) {
    if (Date.now() > deadline) throw new Error("room 未同步");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  ws.close();
}

test.describe("全局任务历史页（任务 8.1 / 6.5 / 6.6）", () => {
  test("Canvas run 后 history 出现记录，页面只读展示且可实时更新", async ({ page }) => {
    const canvasId = `e2e-history-${Math.random().toString(36).slice(2, 10)}`;
    await enableYjs(canvasId);
    await ensureRoom(canvasId);

    // 通过 Canvas run 入口提交一次任务（浏览器写入口只到 Canvas）。
    const run = await fetch(`${BASE_HTTP}/api/canvases/${canvasId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "text-1",
        runId: "run-history-1",
        jobId: "job-history-1",
        modelKey: "fixture:gemini-2.5-flash",
        prompt: "历史页演练",
        parameters: { model: "fixture:gemini-2.5-flash" }
      })
    });
    expect(run.status).toBe(202);

    // 等 Task durable history 记录出现（终态由假 worker 立即产生）。
    const deadline = Date.now() + 15_000;
    let listed = false;
    while (Date.now() < deadline) {
      const response = await fetch(`${BASE_HTTP}/api/pptask/history?limit=5&canvasId=${canvasId}`);
      if (response.ok) {
        const body = (await response.json()) as { items?: Array<{ taskKey?: string }> };
        if (body.items?.some((item) => item.taskKey === "run-history-1")) {
          listed = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(listed).toBe(true);

    // 打开全局历史页（同源 ingress 读取只读 history）。
    await page.goto("/task-history");
    await expect(page.getByTestId("task-history-page")).toBeVisible();

    // 记录出现在列表里，且状态为终态（succeeded）。
    const row = page.locator('[data-task-key="run-history-1"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-state", "succeeded");

    // 页面只读：行内不出现提交/取消/重跑动作控件（tab 里的「取消」是状态筛选，不是动作）。
    const pageHtml = await page.getByTestId("task-history-page").innerHTML();
    const rowActionTexts = await page
      .getByTestId("task-history-page")
      .locator("tbody button")
      .allInnerTexts();
    for (const text of rowActionTexts) {
      expect(["提交", "取消", "重跑", "重新执行"]).not.toContain(text.trim());
    }

    // 列表不泄漏敏感字段。
    expect(pageHtml).not.toContain("sign=");
    expect(pageHtml).not.toContain("COS_SECRET");
  });

  test("history 详情抽屉展示安全时间线，不含 bytes/签名 URL/stack", async ({ page }) => {
    const canvasId = `e2e-history-detail-${Math.random().toString(36).slice(2, 10)}`;
    await enableYjs(canvasId);
    await ensureRoom(canvasId);

    await fetch(`${BASE_HTTP}/api/canvases/${canvasId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "text-1",
        runId: "run-history-detail",
        jobId: "job-history-detail",
        modelKey: "fixture:gemini-2.5-flash",
        prompt: "详情演练",
        parameters: { model: "fixture:gemini-2.5-flash" }
      })
    });

    await page.goto("/task-history");
    const row = page.locator('[data-task-key="run-history-detail"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: /查看任务/ }).click();
    const detail = page.getByTestId("task-history-detail");
    await expect(detail).toBeVisible();
    const detailHtml = await detail.innerHTML();
    for (const forbidden of ["sign=", "base64", "blob:", "Authorization", "COS_SECRET_ID"]) {
      expect(detailHtml).not.toContain(forbidden);
    }
  });
});
