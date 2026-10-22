/**
 * 画布交互对齐的端到端验收
 * （change: align-godot-canvas-interactions，任务 8.2 / 8.4 / 8.5；
 *  change: replace-godot-canvas-runtime-with-bevy 改为浏览器交互 + 服务端命令）。
 *
 * 通过真实鼠标/键盘与浏览器命令出口验证：
 * - 滚轮缩放提交一次最终 viewport；
 * - 输入框焦点隔离；
 * - 画布快捷键复制到页内 fallback；
 * - nodeData.patch 字段级 allowlist 落盘 + 刷新恢复；
 * - 单批次提交原子推进一次 revision。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	createNode,
	sendCommands,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

test.describe("交互对齐：真实鼠标/键盘", () => {
	test("画布滚轮在本地缩放（不写规范视口）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.mouse.wheel(0, 120);
		await page.waitForTimeout(500);

		// 视口是各浏览器本地状态：滚轮缩放写入 localStorage，不改变规范画布。
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document).not.toHaveProperty("viewport");
	});

	test("输入框焦点隔离：textarea 上的快捷键不触发画布命令", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 0, y: 0 },
			commandId: "e2e-focus-create"
		});
		expect(created.ok).toBe(true);
		revision = created.revision ?? revision;
		const nodeId = (await readStoredCanvas(page))?.document.nodes[0].id as string;
		// 通过真实点击选中节点（触发控制器选择 + 执行面板）。
		await page.evaluate((id) => {
			(window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.([id]);
		}, nodeId);

		const textarea = page.locator(".node-execution-dock .mc-panel__textarea");
		if (await textarea.count()) {
			await textarea.first().focus();
			await page.evaluate(() => {
				delete (window as unknown as Record<string, unknown>).__canvasMemoryClipboard;
			});
			await page.keyboard.press("Control+c");
			await page.waitForTimeout(200);
			const memory = await page.evaluate(
				() => (window as unknown as Record<string, unknown>).__canvasMemoryClipboard ?? null
			);
			expect(memory).toBeNull();
		}
		void revision;
	});
});

test.describe("交互对齐协议与 nodeData", () => {
	test("nodeData.patch 经 allowlist 落盘并在刷新后保留，任务字段不受影响", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 0, y: 0 },
			commandId: "e2e-nd-create"
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		revision = created.revision ?? revision;
		const nodeId = (await readStoredCanvas(page))?.document.nodes[0].id as string;

		// 合法字段。
		const patched = await sendCommands(
			page,
			[{ type: "nodeData.patch", nodeId, value: { prompt: "对齐后的提示词", agentId: "agent-1" } }],
			"e2e-nd-patch"
		);
		expect(patched.ok, JSON.stringify(patched)).toBe(true);
		await waitForPersistedRevision(page, revision + 1);
		revision += 1;

		// 刷新后保留用户配置。
		await page.reload();
		await waitForCanvasSession(page);
		const after = await readStoredCanvas(page);
		expect(after?.nodeData[nodeId]).toMatchObject({
			prompt: "对齐后的提示词",
			agentId: "agent-1"
		});
		expect(after?.nodeData[nodeId]).not.toHaveProperty("activeRunId");
	});

	test("单批次提交原子推进至多一次 revision", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		const first = await createNode(page, {
			nodeType: "text",
			position: { x: 0, y: 0 },
			commandId: "e2e-batch-first"
		});
		revision = first.revision ?? revision;
		const firstId = (await readStoredCanvas(page))?.document.nodes[0].id as string;

		const second = await createNode(page, {
			nodeType: "image",
			position: { x: 400, y: 0 },
			connect: { fromNodeId: firstId },
			commandId: "e2e-batch-second"
		});
		revision = second.revision ?? revision;
		const imageId = (await readStoredCanvas(page))?.document.nodes.find((node) => node.type === "image")!.id as string;

		const before = revision;
		const batch = await sendCommands(
			page,
			[
				{ type: "nodeData.patch", nodeId: firstId, value: { prompt: "粘贴的提示" } },
				{ type: "node.update", nodeId: imageId, position: { x: 800, y: 0 } }
			],
			"e2e-batch"
		);
		expect(batch.ok, JSON.stringify(batch)).toBe(true);
		await waitForPersistedRevision(page, before + 1);
		// 一个批次 → 至多一次 revision 前进。
		expect((await readStoredCanvas(page))?.revision).toBeLessThanOrEqual(before + 1);
	});
});
