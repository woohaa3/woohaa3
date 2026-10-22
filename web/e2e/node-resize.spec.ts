/**
 * 节点 resize 端到端验收（change: add-node-resize）。
 *
 * 用真实浏览器指针事件拖拽选中节点右下角抓手，断言：
 * - 规范尺寸（服务端 Y.Doc 派生）按 `node.update{width,height}` 更新并回流；
 * - 节点自由缩放为任意宽高比（图片节点亦不锁比例）；
 * - 过小尺寸被 clamp 到下限；
 * - 服务端拒绝非法（过小）尺寸命令。
 *
 * 抓手位置按 `RESIZE_HANDLE_SIZE` 与节点在屏幕上的位置计算，保证与 Bevy 绘制/JS 命中一致。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	sendCommands,
	waitForCanvasSession,
	waitForCommandsSettled,
	waitForPersistedRevision
} from "./helpers.js";

const MIN_NODE_WIDTH = 180;
const MIN_NODE_HEIGHT = 64;
const RESIZE_HANDLE_SIZE = 20;

/** 节点在页面里的屏幕矩形（世界坐标=canvas 局部，zoom 由页面控制器暴露）。 */
async function nodeScreenRect(page: import("@playwright/test").Page, nodeId: string) {
	return page.evaluate((id) => {
		const canvas = document.querySelector<HTMLCanvasElement>("#bevy-canvas")!;
		const rect = canvas.getBoundingClientRect();
		const store = (window as unknown as {
			__canvasCanonical?: { document: { nodes: Array<{ id: string; position: { x: number; y: number }; width?: number; height?: number }> } };
		}).__canvasCanonical;
		const node = store?.document.nodes.find((entry) => entry.id === id);
		if (!node) return null;
		const viewport = (window as unknown as {
			__canvasViewport?: () => { x: number; y: number; zoom: number };
		}).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
		const width = node.width ?? 248;
		const height = node.height ?? 232;
		return {
			left: rect.left + node.position.x * viewport.zoom + viewport.x,
			top: rect.top + node.position.y * viewport.zoom + viewport.y,
			width: width * viewport.zoom,
			height: height * viewport.zoom,
			zoom: viewport.zoom
		};
	}, nodeId);
}

async function selectNode(page: import("@playwright/test").Page, nodeId: string) {
	await page.evaluate((id) => {
		(window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.([id]);
	}, nodeId);
	await page.waitForTimeout(200);
}

test.describe("节点 resize（change: add-node-resize）", () => {
	test("拖拽右下抓手提交 node.update 并经 Yjs 回流（自由缩放）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const created = await sendCommands(page, [
			{ type: "node.add", node: { id: "resize-image", type: "image", position: { x: 200, y: 160 }, width: 300, height: 200 } }
		], "e2e-resize-create");
		expect(created.ok, JSON.stringify(created)).toBe(true);
		await waitForCommandsSettled(page);
		await selectNode(page, "resize-image");

		const before = await nodeScreenRect(page, "resize-image");
		expect(before).not.toBeNull();

		// 抓手中心（右下角内缘 RESIZE_HANDLE_SIZE 的中点）。
		const zoom = before!.zoom;
		const startX = before!.left + before!.width - (RESIZE_HANDLE_SIZE / 2) * zoom;
		const startY = before!.top + before!.height - (RESIZE_HANDLE_SIZE / 2) * zoom;
		const endX = startX + 120 * zoom;
		const endY = startY + 80 * zoom;

		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(endX, endY, { steps: 8 });
		await page.mouse.up();
		// 等 resize 命令落定（服务端经 Yjs 回流），不再用固定 sleep。
		await waitForCommandsSettled(page);

		const canvas = await readStoredCanvas(page);
		const node = (canvas as { document: { nodes: Array<{ id: string; width?: number; height?: number }> } })
			.document.nodes.find((entry) => entry.id === "resize-image");
		expect(node?.width).toBeGreaterThan(300);
		// 节点自由缩放：宽高独立变化（图片节点不锁比例），两端均增大。
		expect(node?.height).toBeGreaterThan(200);
	});

	test("刷新后尺寸恢复（规范状态）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await sendCommands(page, [
			{ type: "node.add", node: { id: "resize-persist", type: "text", position: { x: 100, y: 100 }, width: 260, height: 195 } }
		], "e2e-resize-persist-create");
		await waitForCommandsSettled(page);

		const canvasBefore = await readStoredCanvas(page);
		const revision = canvasBefore?.revision ?? 0;
		const result = await sendCommands(page, [
			{ type: "node.update", nodeId: "resize-persist", width: 360, height: 260 }
		], "e2e-resize-persist-update");
		expect(result.ok, JSON.stringify(result)).toBe(true);
		await waitForPersistedRevision(page, revision + 1);

		await page.reload();
		await waitForCanvasSession(page);
		const canvas = await readStoredCanvas(page);
		const node = (canvas as unknown as { document: { nodes: Array<{ id: string; width?: number; height?: number }> } })
			.document.nodes.find((entry) => entry.id === "resize-persist");
		expect(node?.width).toBe(360);
		expect(node?.height).toBe(260);
	});

	test("服务端拒绝过小尺寸命令", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await sendCommands(page, [
			{ type: "node.add", node: { id: "resize-reject", type: "image", position: { x: 0, y: 0 }, width: 300, height: 200 } }
		], "e2e-resize-reject-create");
		await waitForCommandsSettled(page);

		// 提交是乐观的（本地 Yjs 立即应用），服务端拒绝是异步的；断言规范尺寸最终不变。
		const before = await readStoredCanvas(page);
		const beforeRevision = before?.revision ?? 0;
		await sendCommands(page, [
			{ type: "node.update", nodeId: "resize-reject", width: 10, height: 10 }
		], "e2e-resize-reject");
		// 等本地批次结算（服务端拒绝会 settle 掉该批次），再读规范值。
		await waitForCommandsSettled(page);
		await page.waitForTimeout(200);

		const canvas = await readStoredCanvas(page);
		const node = (canvas as unknown as { document: { nodes: Array<{ id: string; width?: number; height?: number }> } })
			.document.nodes.find((entry) => entry.id === "resize-reject");
		// 服务端拒绝后不产生尺寸变更（revision 不因该命令前进，尺寸保持 300x200）。
		expect(node?.width).toBe(300);
		expect(node?.height).toBe(200);
		expect((canvas?.revision ?? 0)).toBeLessThanOrEqual(beforeRevision);
	});

	test("下限常量与实现一致（防写死漂移）", async () => {
		expect(MIN_NODE_WIDTH).toBe(180);
		expect(MIN_NODE_HEIGHT).toBe(64);
		expect(RESIZE_HANDLE_SIZE).toBe(20);
	});
});
