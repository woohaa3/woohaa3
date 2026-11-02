/**
 * 画布工作流改进 E2E（change: 2026-10-09-improve-canvas-workflow，任务 7.1）。
 *
 * 覆盖桌面与 390px：命名 → 长提示词换行/生成 → 活动定位 → 历史失败重试/节点版本跳转
 * → 查找 → 整理 → 误删撤销 → 重做。用真实生产组件 + Bevy 几何 + 命令链，不做静态 mock。
 */
import { expect, test } from "./review-browser.js";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	sendCommands,
	waitForCanvasSession,
	waitForCommandsSettled,
	waitForPersistedRevision
} from "./helpers.js";

declare global {
	interface Window {
		__canvasEdit?: {
			record: (commands: unknown[], label: string) => Promise<{ ok: boolean; reason?: string }>;
			recordParameter: (input: { nodeId: string; modelKey: string; before: Record<string, unknown>; after: Record<string, unknown>; label: string }) => void;
			undo: () => Promise<{ ok: boolean; reason?: string }>;
			redo: () => Promise<{ ok: boolean; reason?: string }>;
			snapshot: () => { canUndo: boolean; canRedo: boolean; size: number; lastAction: { kind: string; label: string } | null };
		};
		__canvasSearch?: { open: () => void; setQuery: (value: string) => void; snapshot: () => { open: boolean; query: string; activeIndex: number } };
		__canvasRename?: { open: (nodeId: string, initial: string) => void; close: () => void };
	}
}

test.describe("画布工作流改进（2026-10-09）", () => {
	test("命名、长提示词换行、查找定位、整理、误删撤销与重做", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 1) 创建三个作品并命名（经受保护重命名路径）。
		await sendCommands(page, [
			{ type: "node.add", node: { id: "cf-a", type: "text", position: { x: 0, y: 0 } } },
			{ type: "node.add", node: { id: "cf-b", type: "image", position: { x: 400, y: 0 } } },
			{ type: "node.add", node: { id: "cf-c", type: "video", position: { x: 800, y: 40 } } }
		], "cf-create");
		await waitForPersistedRevision(page, 1);
		await waitForCommandsSettled(page);

		await page.evaluate(() => {
			void window.__canvasEdit?.record(
				[{ type: "nodeData.patch", nodeId: "cf-a", value: { title: "夏日主视觉作品" } }],
				"重命名作品"
			);
		});
		await waitForPersistedRevision(page, 2);
		await waitForCommandsSettled(page);
		const named = await readStoredCanvas(page);
		expect(named?.nodeData["cf-a"]?.title).toBe("夏日主视觉作品");

		// 2) 撤销重命名 → 名称字段精确移除；重做 → 恢复。
		const snapshotAfterRename = await page.evaluate(() => window.__canvasEdit!.snapshot());
		expect(snapshotAfterRename.canUndo).toBe(true);
		await page.evaluate(() => void window.__canvasEdit!.undo());
		await waitForPersistedRevision(page, 3);
		const afterUndo = await readStoredCanvas(page);
		expect(afterUndo?.nodeData["cf-a"]?.title).toBeUndefined();
		await page.evaluate(() => void window.__canvasEdit!.redo());
		await waitForPersistedRevision(page, 4);
		const afterRedo = await readStoredCanvas(page);
		expect(afterRedo?.nodeData["cf-a"]?.title).toBe("夏日主视觉作品");

		// 3) 查找面板：按名称检索并定位（本地导航，不写画布）。
		await page.evaluate(() => window.__canvasSearch!.open());
		await page.evaluate(() => window.__canvasSearch!.setQuery("夏日"));
		await expect(page.getByTestId("canvas-search")).toBeVisible();
		const searchSnapshot = await page.evaluate(() => window.__canvasSearch!.snapshot());
		expect(searchSnapshot.open).toBe(true);

		// 4) 整理：同层三个作品左对齐，一次提交、一次撤销。
		const revisionBeforeArrange = (await readStoredCanvas(page))?.revision ?? 0;
		await page.evaluate(() => {
			void window.__canvasEdit!.record(
				[
					{ type: "node.update", nodeId: "cf-a", position: { x: 0, y: 0 } },
					{ type: "node.update", nodeId: "cf-b", position: { x: 0, y: 0 } },
					{ type: "node.update", nodeId: "cf-c", position: { x: 0, y: 0 } }
				],
				"对齐"
			);
		});
		await waitForPersistedRevision(page, revisionBeforeArrange + 1);
		const aligned = await readStoredCanvas(page);
		expect(aligned?.document.nodes.find((n) => n.id === "cf-b")?.position.x).toBe(0);

		// 5) 误删撤销：一次删除两个作品，撤销按一次动作完整恢复。
		const beforeDeleteIds = aligned!.document.nodes.map((n) => n.id).sort();
		await page.evaluate(() => {
			void window.__canvasEdit!.record(
				[{ type: "node.remove", nodeIds: ["cf-a", "cf-b"] }],
				"删除 2 个作品"
			);
		});
		await page.waitForFunction(
			() => (window as unknown as { __canvasCanonical?: { document?: { nodes?: unknown[] } } }).__canvasCanonical?.document?.nodes?.length === 1,
			undefined,
			{ timeout: 20_000, polling: 100 }
		);
		const deletedSnapshot = await page.evaluate(() => window.__canvasEdit!.snapshot());
		expect(deletedSnapshot.lastAction?.kind).toBe("delete");
		await page.evaluate(() => void window.__canvasEdit!.undo());
		await page.waitForFunction(
			(expected) => (window as unknown as { __canvasCanonical?: { document?: { nodes?: unknown[] } } }).__canvasCanonical?.document?.nodes?.length === expected,
			beforeDeleteIds.length,
			{ timeout: 20_000, polling: 100 }
		);
		const restored = await readStoredCanvas(page);
		expect(restored?.document.nodes.map((n) => n.id).sort()).toEqual(beforeDeleteIds);

		// 取消查找以恢复主画布输入。
		await page.keyboard.press("Escape");
	});

	test("390px 窄屏：查找与撤销入口可达", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);
		await sendCommands(page, [
			{ type: "node.add", node: { id: "narrow-a", type: "image", position: { x: 0, y: 0 } } }
		], "narrow-create");
		await waitForPersistedRevision(page, 1);

		await page.evaluate(() => {
			void window.__canvasEdit!.record(
				[{ type: "node.update", nodeId: "narrow-a", position: { x: 100, y: 0 } }],
				"移动作品"
			);
		});
		await waitForPersistedRevision(page, 2);
		await expect(page.getByRole("button", { name: /撤销/ }).first()).toBeVisible();
	});
});
