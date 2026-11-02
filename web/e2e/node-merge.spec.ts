/**
 * 同类型节点拖动合并 E2E
 * （change: 2026-10-27-merge-same-type-node-history，任务 5.2）。
 *
 * 用真实三服务 + 真实 Bevy WASM 验证用户路径：
 * - 拖动同类型节点进入目标中心区域时出现 DOM 合并高亮；
 * - 松手出现共享 AlertDialog 确认（文案说明不可撤销）；
 * - 确认后来源节点消失、目标内容切换为来源当前版本，画布 revision 前进；
 * - 目标节点历史面板能看到合并后的多版本（来源当前版本成为当前项）。
 *
 * 交互全部走真实输入：`mouse.down` → `mouse.move` → `mouse.up` → 对话框按钮点击。
 * 需要真实 GPU；无 GPU 环境标记「待人工验证」（`waitForCanvasSession` 等待 Bevy ready）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession, createNode } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const SOURCE = "merge-source";
const TARGET = "merge-target";

const SOURCE_V1 = `scene.box({ id: "source-v1", size: [1, 1, 1], position: [0, 0.5, 0], color: "#c06030" });`;
const SOURCE_V2 = `scene.sphere({ id: "source-latest", radius: 0.8, position: [0, 0.8, 0], color: "#3060c0" });`;
const TARGET_V1 = `scene.box({ id: "target-v1", size: [1.2, 1.2, 1.2], position: [0, 0.6, 0], color: "#30a060" });`;

async function submitModelScript(page: Page, nodeId: string, source: string, label: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, source, version: "woohaa-model-js-v2", requestId: `merge-e2e-${nodeId}-${label}` }
  });
  expect(response.ok(), `提交 ${nodeId} 的模型脚本失败：${response.status()} ${await response.text()}`).toBe(true);
}

/** 节点当前屏幕矩形（世界坐标 × 当前视口 + canvas 外框偏移）。 */
async function nodeScreenRect(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((entry: any) => entry.id === id);
    if (!node) return null;
    const viewport = scene.viewport;
    const surface = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return {
      x: surface.left + (node.x + node.width / 2) * viewport.zoom + viewport.x,
      y: surface.top + (node.y + node.height / 2) * viewport.zoom + viewport.y
    };
  }, nodeId);
}

async function nodeHistoryState(page: Page) {
  return page.evaluate(() => {
    return (window as unknown as {
      __nodeHistoryState?: () => { status?: string; items?: Array<{ current: boolean }> } | null;
    }).__nodeHistoryState?.() ?? null;
  });
}

async function openNodeHistory(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { __openNodeHistory?: (nodeId: string) => void }).__openNodeHistory?.(id);
  }, nodeId);
}

test.describe("同类型节点拖动合并（change: 2026-10-27-merge-same-type-node-history）", () => {
  test("拖动同类型节点 → 确认 → 来源消失且合并结果进入目标历史", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    // 两个 3D 节点：来源先有两个版本（形成可合并历史），目标一个版本。
    expect((await createNode(page, {
      nodeType: "model3d", nodeId: SOURCE, position: { x: 160, y: 220 }, commandId: "e2e-merge-source"
    })).ok).toBe(true);
    expect((await createNode(page, {
      nodeType: "model3d", nodeId: TARGET, position: { x: 820, y: 220 }, commandId: "e2e-merge-target"
    })).ok).toBe(true);
    await submitModelScript(page, SOURCE, SOURCE_V1, "v1");
    await submitModelScript(page, SOURCE, SOURCE_V2, "v2");
    await submitModelScript(page, TARGET, TARGET_V1, "v1");
    await page.waitForFunction(
      ({ source, target }) => {
        const nodeData = (window as unknown as {
          __canvasCanonical?: { nodeData?: Record<string, { modelScriptStatus?: string; modelScript?: string }> };
        }).__canvasCanonical?.nodeData;
        return nodeData?.[source]?.modelScriptStatus === "ok"
          && nodeData[source]?.modelScript?.includes("source-latest")
          && nodeData?.[target]?.modelScriptStatus === "ok"
          && nodeData[target]?.modelScript?.includes("target-v1");
      },
      { source: SOURCE, target: TARGET },
      { timeout: 30_000, polling: 200 }
    );
    // 等两个模型都进入渲染镜像，才能从真实矩形取拖动坐标。
    await expect.poll(async () => page.evaluate(
      ({ source, target }) => {
        const nodes = (window as any).__bevyRuntime.lastScene()?.nodes ?? [];
        return [source, target].every((id) => Boolean(nodes.find((node: any) => node.id === id)?.model));
      },
      { source: SOURCE, target: TARGET }
    ), { timeout: 30_000 }).toBe(true);
    const revisionBefore = await page.evaluate(
      () => (window as unknown as { __canvasCanonical?: { revision?: number } }).__canvasCanonical?.revision ?? 0
    );

    const sourceCenter = await nodeScreenRect(page, SOURCE);
    const targetCenter = await nodeScreenRect(page, TARGET);
    expect(sourceCenter, "来源节点未进入渲染镜像").not.toBeNull();
    expect(targetCenter, "目标节点未进入渲染镜像").not.toBeNull();

    // 真实拖动：进入目标完整矩形时出现 DOM 合并高亮。
    await page.mouse.move(sourceCenter!.x, sourceCenter!.y);
    await page.mouse.down();
    await page.mouse.move(targetCenter!.x, targetCenter!.y, { steps: 20 });
    const overlay = page.locator(`.node-merge-overlay[data-node-id="${TARGET}"]`);
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await expect(overlay).toContainText("松手合并到此节点");

    // 松手：不提交普通移动，而是打开确认框；取消路径不改变画布（先验证一次取消）。
    await page.mouse.up();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "合并", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.locator(`.node-merge-overlay`)).toHaveCount(0);
    await expect.poll(async () => page.evaluate(
      () => (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string }> } } })
        .__canvasCanonical?.document?.nodes?.some((node) => node.id === "merge-source") ?? false
    )).toBe(true);

    // 再次拖动并确认合并。
    const sourceCenter2 = await nodeScreenRect(page, SOURCE);
    const targetCenter2 = await nodeScreenRect(page, TARGET);
    await page.mouse.move(sourceCenter2!.x, sourceCenter2!.y);
    await page.mouse.down();
    await page.mouse.move(targetCenter2!.x, targetCenter2!.y, { steps: 20 });
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await page.mouse.up();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1, { timeout: 10_000 });
    await page.getByRole("button", { name: "合并", exact: true }).click();

    // 写面成功：确认框关闭、来源节点消失、目标内容切换为来源当前版本、revision 前进。
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForFunction(
      ({ source, target }) => {
        const canonical = (window as unknown as {
          __canvasCanonical?: {
            revision?: number;
            document?: { nodes?: Array<{ id: string }> };
            nodeData?: Record<string, { modelScript?: string }>;
          };
        }).__canvasCanonical;
        const nodes = canonical?.document?.nodes ?? [];
        return !nodes.some((node) => node.id === source)
          && nodes.some((node) => node.id === target)
          && canonical?.nodeData?.[target]?.modelScript?.includes("source-latest") === true;
      },
      { source: SOURCE, target: TARGET },
      { timeout: 30_000, polling: 200 }
    );
    const revisionAfter = await page.evaluate(
      () => (window as unknown as { __canvasCanonical?: { revision?: number } }).__canvasCanonical?.revision ?? 0
    );
    expect(revisionAfter).toBeGreaterThan(revisionBefore);
    expect(await page.evaluate(
      ({ source }) => (window as any).__bevyRuntime.lastScene()?.nodes?.some((node: any) => node.id === source) ?? false,
      { source: SOURCE }
    )).toBe(false);

    // 合并结果进入目标历史：多版本且来源当前版本成为当前项。
    await openNodeHistory(page, TARGET);
    await expect(page.locator("[data-node-history-panel]")).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(async () => {
      const state = await nodeHistoryState(page);
      return state?.status ?? "none";
    }, { timeout: 20_000 }).toBe("ready");
    const state = await nodeHistoryState(page);
    expect(state?.items?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(state?.items?.filter((item) => item.current).length ?? 0).toBe(1);
    // 列表确实渲染了合并进来的版本行（不是只在内存状态里）。
    await expect.poll(async () => page.locator("[data-entry-id]").count()).toBeGreaterThanOrEqual(3);

    expect(errors).toEqual([]);
  });
});
