/**
 * 完整任务链路浏览器 E2E（change: split-web-runtime-services，任务 8.1）。
 *
 * 在真实三服务拓扑下，用**真实页面 UI** 触发一次任务，验证端到端贯通：
 *   浏览器 run（面板） → Canvas run handler → Task submit → 假 provider 执行 →
 *   Task durable history 终态 → Canvas projector 消费 → 权威 Y.Doc → Yjs 广播 →
 *   本页派生聚合 → Godot 帧 → 全局历史页可见。
 *
 * 与 `run-cancel.spec.ts`（协议客户端）互补：这里走真实 React 面板与 Godot 投影。
 * 需要画布存储 + Yjs，跑在 `playwright.yjs.config.ts` 下。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, waitForCanvasSession, waitForBevyReady } from "./helpers.js";

const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const CANVAS = "woohaa3-default-canvas";
const DOCK = ".node-execution-dock";

function emptyCanvas() {
  return {
    id: CANVAS,
    title: "全链路演练",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
      updatedAt: "2026-09-24T00:00:00.000Z"
    },
    nodeData: { "text-1": { title: "全链路节点" } },
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

async function waitForSynced(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = (globalThis as unknown as { __canvasSessionStatus?: { phase?: string; remote?: { mode?: string; phase?: string } } })
        .__canvasSessionStatus;
      return status?.phase === "ready" && status?.remote?.mode === "remote" && status?.remote?.phase === "synced";
    },
    undefined,
    { timeout: 30_000 }
  );
}

/** 本页节点当前的 taskStatus（由规范聚合派生；不再依赖已删除的帧镜像）。 */
async function projectedTaskStatus(page: Page, nodeId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const canonical = (globalThis as unknown as {
      __canvasCanonical?: { nodeData?: Record<string, { taskStatus?: string }> };
    }).__canvasCanonical;
    return canonical?.nodeData?.[id]?.taskStatus ?? null;
  }, nodeId);
}

test.describe("完整任务链路（任务 8.1）", () => {
  test("面板触发 run → projector → Godot 帧 → 历史页贯通", async ({ page }) => {
    await enableYjs();
    await installPageHelpers(page);
    await page.goto("/");
    await waitForBevyReady(page);
    await waitForCanvasSession(page);
    await waitForSynced(page);

    // 选中文本节点（选中是浏览器本地状态；用交互控制器暴露的 E2E 入口）。
    await page.evaluate(() => {
      (globalThis as unknown as { __canvasSetSelection?: (ids: string[]) => void })
        .__canvasSetSelection?.(["text-1"]);
    });

    // 面板出现且是文本类型。
    const dock = page.locator(`${DOCK}[data-node-id="text-1"]`);
    await expect(dock).toBeVisible({ timeout: 20_000 });
    await expect(dock.locator("[data-task-kind]")).toHaveAttribute("data-task-kind", "text-generation");

    // 输入 prompt 并执行（面板 run 只提交，Canvas 负责异步任务）。
    // prompt 编辑器已由 textarea 迁移为结构化 contenteditable（change: add-reference-inputs-and-mentions）。
    const editor = dock.locator(".mention-editor__input");
    await editor.click();
    await editor.pressSequentially("全链路提示词");
    const send = dock.locator(".mc-panel__send");
    await expect(send).toBeEnabled();
    await send.click();

    // Godot 帧最终出现 processing → successed（终态由服务端 projector 写入权威 Y.Doc）。
    await expect
      .poll(() => projectedTaskStatus(page, "text-1"), { timeout: 30_000 })
      .toMatch(/processing|successed/);
    await expect
      .poll(() => projectedTaskStatus(page, "text-1"), { timeout: 30_000 })
      .toBe("successed");

    // 历史页可见该 run 的记录（Task history 是唯一事实源）。
    await page.goto("/task-history");
    await expect(page.getByTestId("task-history-page")).toBeVisible();
    await expect(page.locator('[data-state="succeeded"]').first()).toBeVisible({ timeout: 15_000 });
  });
});
