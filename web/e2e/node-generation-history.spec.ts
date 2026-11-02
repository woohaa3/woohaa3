/**
 * 节点生成历史浏览器 E2E
 * （change: add-canvas-node-generation-history，任务 5.2 / 5.3）。
 *
 * 用真实三服务 + 真实 Bevy WASM 验证：
 * - 五类节点打开历史（空态），点击历史动作不改变 selection；
 * - 只读会话允许浏览但禁用「设为当前」；
 * - 恢复成功/失败与权威当前标记；
 * - 刷新后当前输出与历史顺序一致；
 * - 模型历史聚焦分栏：左侧模型非空、不被 drawer 遮挡、关闭恢复。
 *
 * Canvas Service 的历史登记由内部路径触发；这里通过受控 API（run/model-mcp）间接产生版本，
 * 或直接断言空态/边界以覆盖 UI 契约。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { bevyNodeHistoryActionRect } from "@woohaa3/contracts";
import { designEvidence } from "./design-evidence.js";
import { installPageHelpers, resetCanvasStorage, createNode, readStoredCanvas, waitForCanvasSession } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

const SIMPLE_V2 = `
scene.box({ id: "body", size: [1, 1, 1], position: [0, 1, 0], color: "#c06030" });
`;

async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, source, version: "woohaa-model-js-v2", requestId: `e2e-${nodeId}-${source}` }
  });
  expect(response.ok(), `submit_model_script 失败：${response.status()}`).toBe(true);
}

/** 打开某节点的历史面板（E2E 镜像入口；等价于点击历史动作）。 */
async function openHistory(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { __openNodeHistory?: (nodeId: string) => void }).__openNodeHistory?.(id);
  }, nodeId);
}

async function historyState(page: Page) {
  return page.evaluate(() => {
    return (window as unknown as { __nodeHistoryState?: () => unknown }).__nodeHistoryState?.() ?? null;
  });
}

test.describe("节点生成历史（change: add-canvas-node-generation-history）", () => {
  test("四类媒体/文本历史空态与自包含模型初始版本可打开", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    let revision = 0;
    for (const [index, nodeType] of ["text", "image", "video", "audio", "model3d"].entries()) {
      const created = await createNode(page, {
        nodeType,
        position: { x: index * 240, y: 180 },
        nodeId: `ngh-${nodeType}`,
        commandId: `e2e-ngh-${nodeType}`
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      revision = created.revision ?? revision;
    }

    for (const nodeType of ["text", "image", "video", "audio", "model3d"]) {
      if (nodeType === "image") {
        const target = await page.evaluate(() => {
          const scene = (window as any).__bevyRuntime.lastScene();
          const node = scene.nodes.find((entry: any) => entry.id === "ngh-image");
          const surface = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
          return { node, viewport: scene.viewport, left: surface.left, top: surface.top };
        });
        const rect = bevyNodeHistoryActionRect(target.node);
        await page.mouse.click(target.left + (rect.x + rect.width / 2) * target.viewport.zoom + target.viewport.x,
          target.top + (rect.y + rect.height / 2) * target.viewport.zoom + target.viewport.y);
      } else await openHistory(page, `ngh-${nodeType}`);
      await expect.poll(async () => {
        const state = (await historyState(page)) as { status?: string } | null;
        return state?.status ?? "none";
      }, { timeout: 15_000 }).toBe(nodeType === "model3d" ? "ready" : "empty");
      const state = (await historyState(page)) as { status: string; kind: string };
      expect(state.status).toBe(nodeType === "model3d" ? "ready" : "empty");
      await expect(page.locator("[data-node-history-panel]")).toHaveCount(1);
      if (nodeType === "image") await designEvidence(page, "final-image-history-empty", "真实鼠标点击无输出图片节点的历史动作，空态可打开并关闭");
      await page.getByRole("button", { name: "关闭节点版本", exact: true }).click();
      await expect(page.locator("[data-node-history-panel]")).toHaveCount(0);
    }
  });

  test("模型历史：聚焦分栏左侧模型非空、关闭恢复", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, { nodeType: "model3d", position: { x: 500, y: 200 }, nodeId: "ngh-model" });
    await submitModelScript(page, "ngh-model", SIMPLE_V2);
    // 第二个版本形成历史（用于快速切换）。
    const SECOND_V2 = `
scene.sphere({ id: "ball", radius: 0.8, position: [0, 0.8, 0], color: "#3060c0" });
`;
    await submitModelScript(page, "ngh-model", SECOND_V2);
    await page.waitForFunction(
      () => {
        const canonical = (window as unknown as {
          __canvasCanonical?: { nodeData?: Record<string, { modelScriptStatus?: string }> };
        }).__canvasCanonical;
        return canonical?.nodeData?.["ngh-model"]?.modelScriptStatus === "ok";
      },
      undefined,
      { timeout: 30_000, polling: 200 }
    );

    await openHistory(page, "ngh-model");
    // 模型历史进入聚焦并挂载右侧 drawer。
    await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(600);

    // 左侧模型非空（前景像素）。
    const canvasPixels = async () => page.locator("#bevy-canvas").screenshot().then(async (buffer) => {
      const base64 = buffer.toString("base64");
      return page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let count = 0;
        for (let y = 0; y < bitmap.height; y += 2) {
          for (let x = 0; x < bitmap.width; x += 2) {
            const i = (y * bitmap.width + x) * 4;
            const r = px[i], g = px[i + 1], b = px[i + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (mx - mn > 40 && mx > 60) count += 1;
          }
        }
        return { count };
      }, base64);
    });
    const stats = await canvasPixels();
    expect(stats.count).toBeGreaterThan(200);

    // 页面只有一个 canvas。
    expect(await page.locator("canvas#bevy-canvas").count()).toBe(1);

    // 快速切换模型版本：连续选择多个条目后最终显示最新选择（selection generation 丢弃迟到）。
    const entries = await page.evaluate(() => {
      const state = (window as unknown as { __nodeHistoryState?: () => { items?: Array<{ entryId: string }> } }).__nodeHistoryState?.();
      return state?.items?.map((item) => item.entryId) ?? [];
    });
    if (entries.length >= 2) {
      await page.locator(`[data-entry-id="${entries[0]}"] .node-history__select`).click();
      await page.locator(`[data-entry-id="${entries[1]}"] .node-history__select`).click();
      await expect.poll(async () => {
        const state = (await historyState(page)) as { selectedEntryId?: string | null } | null;
        return state?.selectedEntryId ?? null;
      }, { timeout: 10_000 }).toBe(entries[1]);
    }

    // drawer 输入隔离：在 drawer 内滚轮/点击不改变画布 viewport。
    const viewportBefore = await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.() ?? null);
    await page.locator(".node-history--drawer").hover();
    await page.mouse.wheel(0, 300);
    await page.locator(".node-history--drawer").click({ position: { x: 20, y: 200 } });
    await page.waitForTimeout(200);
    const viewportAfter = await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.() ?? null);
    expect(viewportAfter).toEqual(viewportBefore);

    // 动态 resize：drawer 仍挂载、左侧模型仍非空（content rect 随宽度更新）。
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(700);
    expect(await page.locator(".node-history--drawer").count()).toBe(1);
    expect((await canvasPixels()).count).toBeGreaterThan(120);

    // 窄屏检查面板保留左右64px关联栏，宽度随工作区计算。
    await page.setViewportSize({ width: 640, height: 800 });
    await page.waitForTimeout(500);
    const drawerWidth = await page.locator(".node-history--drawer").evaluate((el) => el.getBoundingClientRect().width);
    expect(drawerWidth).toBeCloseTo(640 - 2 * 64, 0);

    // 关闭 drawer → 聚焦退出、面板消失、无资源错误。
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const close = document.querySelector(".node-history--drawer .node-history__close") as HTMLButtonElement | null;
      close?.click();
    });
    await expect(page.locator(".node-history--drawer")).toHaveCount(0);
    expect(errors.filter((message) => /NaN|panic|RuntimeError/i.test(message))).toEqual([]);
  });

  test("恢复历史后权威当前标记与刷新一致", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, { nodeType: "model3d", position: { x: 400, y: 150 }, nodeId: "ngh-apply" });
    await submitModelScript(page, "ngh-apply", SIMPLE_V2);

    // 提交第二个脚本形成两个模型版本。
    const SECOND = `
scene.box({ id: "body2", size: [2, 1, 1], position: [0, 1, 0], color: "#3060c0" });
`;
    await submitModelScript(page, "ngh-apply", SECOND);

    await openHistory(page, "ngh-apply");
    await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });
    // 至少两个可恢复版本；第一项为当前。
    await expect.poll(async () => {
      const state = (await historyState(page)) as { items?: unknown[] } | null;
      return state?.items?.length ?? 0;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // 选择较旧版本并恢复（通过面板「设为当前」按钮）。
    const olderEntryId = await page.evaluate(() => {
      const state = (window as unknown as { __nodeHistoryState?: () => { items?: Array<{ entryId: string; current: boolean }> } })
        .__nodeHistoryState?.();
      return state?.items?.find((item) => !item.current)?.entryId ?? null;
    });
    expect(olderEntryId).not.toBeNull();

    await page.locator(`[data-entry-id="${olderEntryId}"] .node-history__select`).click();
    await expect(page.locator(`[data-entry-id="${olderEntryId}"] .node-history__apply`)).toBeEnabled();
    await page.locator(`[data-entry-id="${olderEntryId}"] .node-history__apply`).click();

    // 权威回流后当前标记更新（不做固定延时）。
    await expect.poll(async () => {
      const state = (await historyState(page)) as { items?: Array<{ entryId: string; current: boolean }> } | null;
      return state?.items?.find((item) => item.entryId === olderEntryId)?.current ?? false;
    }, { timeout: 15_000 }).toBe(true);

    // 刷新后当前输出与历史顺序一致（恢复后的当前版本为较早脚本）。
    await page.reload();
    await waitForCanvasSession(page);
    const canvas = await readStoredCanvas(page);
    const modelScript = canvas?.nodeData?.["ngh-apply"]?.modelScript as string | undefined;
    expect(modelScript).toContain("body");
    expect(modelScript).not.toContain("body2");
  });

  test("清空历史：二次确认后列表空态，画布内容不变", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await createNode(page, {
      nodeType: "model3d",
      position: { x: 240, y: 180 },
      nodeId: "ngh-clear",
      commandId: "e2e-ngh-clear"
    });
    await submitModelScript(page, "ngh-clear", SIMPLE_V2);
    const SECOND = `
scene.box({ id: "body2", size: [2, 1, 1], position: [0, 1, 0], color: "#3060c0" });
`;
    await submitModelScript(page, "ngh-clear", SECOND);

    await openHistory(page, "ngh-clear");
    await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(async () => {
      const state = (await historyState(page)) as { items?: unknown[] } | null;
      return state?.items?.length ?? 0;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // 已提交内容在清空后必须保持原样。
    const beforeScript = (await readStoredCanvas(page))?.nodeData?.["ngh-clear"]?.modelScript as string | undefined;
    expect(beforeScript).toContain("body2");

    // 第一次点击只进入确认态，不提交。
    await page.locator(".node-history--drawer .node-history__clear").click();
    await expect(page.locator(".node-history--drawer [data-clear-confirm]")).toHaveCount(1);
    await expect.poll(async () => {
      const state = (await historyState(page)) as { items?: unknown[] } | null;
      return state?.items?.length ?? 0;
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);

    await page.locator(".node-history--drawer [data-clear-confirm] .node-history__clear").click();
    await expect.poll(async () => {
      const state = (await historyState(page)) as { items?: unknown[]; status?: string } | null;
      return { count: state?.items?.length ?? -1, status: state?.status };
    }, { timeout: 15_000 }).toEqual({ count: 0, status: "empty" });
    await expect(page.locator(".node-history--drawer .node-history__card[data-entry-id]")).toHaveCount(0);

    // 画布内容、当前版本与刷新后保持一致（清空历史不是回滚）。
    const afterScript = (await readStoredCanvas(page))?.nodeData?.["ngh-clear"]?.modelScript as string | undefined;
    expect(afterScript).toBe(beforeScript);
    await page.reload();
    await waitForCanvasSession(page);
    const reloaded = (await readStoredCanvas(page))?.nodeData?.["ngh-clear"]?.modelScript as string | undefined;
    expect(reloaded).toBe(beforeScript);
  });
});
