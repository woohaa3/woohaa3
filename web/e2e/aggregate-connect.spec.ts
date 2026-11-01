import { bevySelectionBounds, bevyAggregateHandle } from "@woohaa3/contracts";
/**
 * 多选聚合拉线的浏览器验收
 * （change: add-multi-select-aggregate-connect，任务 4.2）。
 *
 * 用产品镜像断言：`window.__bevyRuntime.lastScene()`（版本化场景投影）与
 * `window.__canvasCanonical`（服务端 Y.Doc 派生规范状态）。
 */
import { expect, test, type Page } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	sendCommands,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

type Scene = {
	nodes: Array<{ id: string; type: string; x: number; y: number; width: number; height: number }>;
	selection: { nodes: string[] };
	aggregateConnect?: {
		direction: "input" | "output" | null;
		cursor?: { x: number; y: number };
		pendingEdges: Array<{ id: string; source: string; target: string }>;
	};
};

async function scene(page: Page): Promise<Scene | null> {
	return page.evaluate(
		() => (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
	) as Promise<Scene | null>;
}

async function toClient(page: Page, world: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.evaluate((point) => {
		const vp = (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
		const rect = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
		return { x: point.x * vp.zoom + vp.x + rect.left, y: point.y * vp.zoom + vp.y + rect.top };
	}, world);
}

async function handleClient(page: Page, direction: "input" | "output") {
  const projection = (await scene(page))!;
  const bounds = bevySelectionBounds(projection.nodes.filter(node => projection.selection.nodes.includes(node.id)))!;
  return toClient(page, bevyAggregateHandle(bounds, direction));
}
async function nodeClient(page: Page, id: string) {
  const node = (await scene(page))!.nodes.find(node => node.id === id)!;
  return toClient(page, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
}

async function selectAll(page: Page, ids: string[]): Promise<void> {
	await page.evaluate((nodeIds) => {
		(window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.(nodeIds);
	}, ids);
}

/** a(200,0,200x120) b(200,300,200x120) t(800,0,200x120)；输出把手 (418,210)、输入把手 (182,210)。 */
async function seed(page: Page): Promise<void> {
	await sendCommands(page, [
		{ type: "node.add", node: { id: "a", type: "image", position: { x: 200, y: 0 }, width: 200, height: 120 } },
		{ type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 300 }, width: 200, height: 120 } },
		{ type: "node.add", node: { id: "t", type: "image", position: { x: 800, y: 0 }, width: 200, height: 120 } }
	] as never, "aggregate-setup");
	await page.waitForTimeout(400);
}

test.describe("多选聚合拉线（change: add-multi-select-aggregate-connect）", () => {
	test("多选显示聚合把手；输出把手拖到目标一次提交两条边", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await seed(page);
		await selectAll(page, ["a", "b"]);
		await page.waitForTimeout(200);

		// 未拖拽：仅显示把手（direction null）。
		let projection = (await scene(page))!;
		expect(projection.aggregateConnect).toMatchObject({ direction: null, pendingEdges: [] });
		await page.screenshot({ path: "test-results/aggregate-handles.png" });

		const handle = await handleClient(page, "output");
		const target = await nodeClient(page, "t");
		await page.mouse.move(handle.x, handle.y);
		await page.mouse.down();
		await page.mouse.move(target.x, target.y, { steps: 6 });
		await page.waitForTimeout(150);
		projection = (await scene(page))!;
		expect(projection.aggregateConnect?.direction).toBe("output");
		expect(projection.aggregateConnect?.pendingEdges).toHaveLength(2);
		await page.screenshot({ path: "test-results/aggregate-dragging.png" });

		await page.mouse.up();
		await page.waitForTimeout(600);
		// 手势结束：回到仅显示把手（选择仍为多选）。
		expect((await scene(page))!.aggregateConnect).toMatchObject({ direction: null, pendingEdges: [] });

		const canonical = await readStoredCanvas(page);
		const edges = (canonical?.document.edges ?? []).filter((edge) => edge.target === "t");
		expect(edges.map((edge) => edge.source).sort()).toEqual(["a", "b"]);
		await waitForPersistedRevision(page, canonical!.revision);
	});

	test("输入把手拖到目标建立目标 -> 成员；Escape 取消不提交", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await seed(page);
		await selectAll(page, ["a", "b"]);
		await page.waitForTimeout(200);

		const handle = await handleClient(page, "input");
		const target = await nodeClient(page, "t");
		await page.mouse.move(handle.x, handle.y);
		await page.mouse.down();
		await page.mouse.move(target.x, target.y, { steps: 6 });
		await page.waitForTimeout(150);
		const projection = (await scene(page))!;
		expect(projection.aggregateConnect?.direction).toBe("input");
		expect(projection.aggregateConnect?.pendingEdges.map((edge) => edge.source)).toEqual(["t", "t"]);

		// Escape 取消。
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);
		await page.mouse.up();
		await page.waitForTimeout(400);
		const canonical = await readStoredCanvas(page);
		expect((canonical?.document.edges ?? []).filter((edge) => edge.source === "t")).toHaveLength(0);
	});

});
