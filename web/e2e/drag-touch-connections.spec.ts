/**
 * 单节点拖动 Q/E 触碰粘连的浏览器验收
 * （change: add-drag-touch-connections，任务 4.2）。
 *
 * 用产品镜像断言：`window.__bevyRuntime.lastScene()`（版本化场景投影）与
 * `window.__canvasCanonical`（服务端 Y.Doc 派生规范状态）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
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
	dragAttach?: {
		nodeId: string;
		mode: "predecessor" | "successor" | null;
		contactNodeId?: string;
		pendingEdges: Array<{ id: string; source: string; target: string }>;
	};
};

async function scene(page: Page): Promise<Scene | null> {
	return page.evaluate(
		() => (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
	) as Promise<Scene | null>;
}

/** 世界坐标 → 页面 client 坐标（与控制器 `worldToClient` 同一换算）。 */
async function toClient(page: Page, world: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.evaluate((point) => {
		const viewport = (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } })
			.__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
		const canvas = document.querySelector("canvas") as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		return {
			x: point.x * viewport.zoom + viewport.x + rect.left,
			y: point.y * viewport.zoom + viewport.y + rect.top
		};
	}, world);
}

/** 建两个 image 节点：a(100,100)、b(330,100)，触须可直接碰到 b。 */
async function seedTwoNodes(page: Page): Promise<void> {
	await sendCommands(
		page,
		[
			{ type: "node.add", node: { id: "a", type: "image", position: { x: 100, y: 100 } } },
			{ type: "node.add", node: { id: "b", type: "image", position: { x: 330, y: 100 } } }
		] as never,
		"drag-attach-setup"
	);
	await page.waitForTimeout(400);
}

test.describe("拖动 Q/E 触碰粘连（change: add-drag-touch-connections）", () => {
	test("按住 E 后序触碰邻居并释放：投影预览 + 一次提交位置与边", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await seedTwoNodes(page);

		const center = await toClient(page, { x: 100 + 124, y: 100 + 116 });
		const moved = await toClient(page, { x: 105 + 124, y: 100 + 116 });

		await page.mouse.move(center.x, center.y);
		await page.mouse.down();
		// 越过拖动阈值，随后静止；按键应独立求值接触。
		await page.mouse.move(moved.x, moved.y, { steps: 4 });
		await page.waitForTimeout(150);

		// 未按键：只显示操作条，无触须/待提交边。
		let projection = (await scene(page))!;
		expect(projection.dragAttach).toMatchObject({ nodeId: "a", mode: null, pendingEdges: [] });

		await page.keyboard.down("e");
		await page.waitForTimeout(200);
		projection = (await scene(page))!;
		expect(projection.dragAttach?.mode).toBe("successor");
		expect(projection.dragAttach?.contactNodeId).toBe("b");
		expect(projection.dragAttach?.pendingEdges).toMatchObject([{ source: "a", target: "b" }]);
		await page.screenshot({ path: "test-results/drag-attach-successor.png" });

		await page.keyboard.up("e");
		await page.mouse.up();
		await page.waitForTimeout(600);

		// 手势结束：投影消失。
		expect((await scene(page))!.dragAttach).toBeUndefined();

		// 规范状态：位置更新 + 一条 a -> b 边。
		const canonical = await readStoredCanvas(page);
		const edge = canonical?.document.edges.find((entry) => entry.source === "a" && entry.target === "b");
		expect(edge, JSON.stringify(canonical?.document.edges)).toBeTruthy();
		await waitForPersistedRevision(page, canonical!.revision);
	});

	test("按住 Q 前序触碰左侧邻居，Escape 取消不提交", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// a 在右、c 在左：Q 触须向左碰到 c。
		await sendCommands(
			page,
			[
				{ type: "node.add", node: { id: "a", type: "image", position: { x: 430, y: 100 } } },
				{ type: "node.add", node: { id: "c", type: "image", position: { x: 200, y: 100 } } }
			] as never,
			"drag-attach-q-setup"
		);
		await page.waitForTimeout(400);

		const center = await toClient(page, { x: 430 + 124, y: 100 + 116 });
		const moved = await toClient(page, { x: 435 + 124, y: 100 + 116 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.down();
		await page.mouse.move(moved.x, moved.y, { steps: 4 });
		await page.keyboard.down("q");
		await page.waitForTimeout(200);

		const projection = (await scene(page))!;
		expect(projection.dragAttach?.mode).toBe("predecessor");
		expect(projection.dragAttach?.pendingEdges[0]).toMatchObject({ source: "c", target: "a" });

		// Escape 取消整次手势。
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		expect((await scene(page))!.dragAttach).toBeUndefined();
		await page.keyboard.up("q");
		await page.mouse.up();
		await page.waitForTimeout(400);

		// 规范状态：没有新增边。
		const canonical = await readStoredCanvas(page);
		expect(canonical?.document.edges ?? []).toHaveLength(0);
	});

	test("自定义尺寸节点与不同 zoom 下操作条/触须不越界", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await sendCommands(
			page,
			[
				{ type: "node.add", node: { id: "a", type: "image", position: { x: 200, y: 200 }, width: 320, height: 260 } },
				{ type: "node.add", node: { id: "b", type: "image", position: { x: 540, y: 200 } } }
			] as never,
			"drag-attach-size-setup"
		);
		await page.waitForTimeout(400);

		const center = await toClient(page, { x: 200 + 160, y: 200 + 130 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.down();
		const moved = await toClient(page, { x: 205 + 160, y: 200 + 130 });
		await page.mouse.move(moved.x, moved.y, { steps: 4 });
		await page.keyboard.down("e");
		await page.waitForTimeout(250);

		const projection = (await scene(page))!;
		const owner = projection.nodes.find((node) => node.id === "a")!;
		expect(owner.width).toBe(320);
		expect(projection.dragAttach?.mode).toBe("successor");
		await page.screenshot({ path: "test-results/drag-attach-custom-size.png" });

		await page.keyboard.up("e");
		await page.mouse.up();
	});
});
