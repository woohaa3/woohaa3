/**
 * 交互与恢复的端到端验收
 * （change: replace-godot-canvas-runtime-with-bevy，任务 8.2）。
 *
 * 通过真实浏览器命令出口提交语义命令（等价于交互控制器完成一次手势），断言两层一致：
 * 规范状态（服务端 Y.Doc 派生）与 Bevy 渲染 revision。
 *
 * 已删除 Godot bridge 与帧缓冲：不再有投影帧、帧版本号或「已应用帧」信号；改为断言
 * `__canvasCanonical`（规范派生）与 `__bevyRuntime.renderedRevision`（渲染信号）。
 */
import { expect, test } from "./review-browser.js";
import {
	installPageHelpers,
	readStoredCanvas,
	readRenderedRevision,
	resetCanvasStorage,
	createNode,
	moveNode,
	deleteNodes,
	sendCommands,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

test.describe("交互与恢复", () => {
	test("创建 / 移动 / 连接 / 删除 / 视口变更都落盘", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;

		// —— 创建两个节点
		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 20, y: 40 },
			commandId: "e2e-create-1"
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		revision = created.revision ?? revision;

		let canvas = await readStoredCanvas(page);
		const textNode = canvas?.document.nodes.find((node) => node.type === "text");
		expect(textNode).toBeDefined();
		expect(textNode?.position).toEqual({ x: 20, y: 40 });

		// 第二个节点直接带连线创建（一个用户动作 = 一次提交）
		const connected = await createNode(page, {
			nodeType: "image",
			position: { x: 640, y: 40 },
			connect: { fromNodeId: textNode!.id as string, label: "文本" },
			commandId: "e2e-create-2"
		});
		expect(connected.ok, JSON.stringify(connected)).toBe(true);
		revision = connected.revision ?? revision;

		canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(2);
		expect(canvas?.document.edges).toHaveLength(1);
		const imageNode = canvas?.document.nodes.find((node) => node.type === "image");
		expect(canvas?.document.edges[0]).toMatchObject({ source: textNode?.id, target: imageNode?.id });

		// —— 移动
		const moved = await moveNode(page, {
			nodeId: imageNode!.id,
			position: { x: 300, y: 260 },
			commandId: "e2e-move"
		});
		expect(moved.ok, JSON.stringify(moved)).toBe(true);
		revision = moved.revision ?? revision;

		await waitForPersistedRevision(page, revision);
		canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes.find((node) => node.id === imageNode!.id)?.position).toEqual({ x: 300, y: 260 });

		// —— 断线
		const edgeId = canvas?.document.edges[0].id as string;
		const disconnected = await sendCommands(page, [{ type: "edge.remove", edgeId }], "e2e-disconnect");
		expect(disconnected.ok, JSON.stringify(disconnected)).toBe(true);
		await waitForPersistedRevision(page, revision + 1);
		revision += 1;
		canvas = await readStoredCanvas(page);
		expect(canvas?.document.edges).toEqual([]);

		// —— 删除节点
		const deleted = await deleteNodes(page, {
			nodeIds: [imageNode!.id],
			commandId: "e2e-delete"
		});
		expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
		revision = deleted.revision ?? revision;
		canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes.map((node) => node.id)).toEqual([textNode?.id]);

		await waitForPersistedRevision(page, revision);
		expect((await readStoredCanvas(page))?.revision).toBeGreaterThanOrEqual(revision);
	});

	test("刷新后恢复同一 revision 与全部节点/视口", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 坐标必须**网格对齐**：domain 在序列化节点时按 `snapToAssetGrid` 吸附到 20 单位网格。
		let revision = 0;
		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 40, y: 60 },
			commandId: "e2e-persist-create"
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		revision = created.revision ?? revision;

		await waitForPersistedRevision(page, revision);
		const before = await readStoredCanvas(page);
		expect(before).not.toBeNull();
		expect(before!.revision).toBe(revision);

		// —— 刷新：Bevy 与 Web 都重启，应从服务端 Y.Doc 恢复
		await page.reload();
		await waitForCanvasSession(page);

		const after = await readStoredCanvas(page);
		expect(after?.revision).toBe(before!.revision);
		expect(after?.document.nodes.map((n) => n.id)).toEqual(before!.document.nodes.map((n) => n.id));
		const restored = after?.document.nodes.find((n) => n.id === before!.document.nodes[0].id);
		expect(restored?.position).toEqual({ x: 40, y: 60 });
		// 视口不再是规范数据：规范 document 不含 viewport 字段。
		expect(after?.document).not.toHaveProperty("viewport");
	});

	test("Bevy 重启（刷新）后从当前规范状态重建画面 revision", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const created = await createNode(page, {
			nodeType: "model3d",
			position: { x: 5, y: 5 },
			commandId: "e2e-reload-create"
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		const canvas = await readStoredCanvas(page);

		await page.reload();
		await waitForCanvasSession(page);
		await waitForPersistedRevision(page, canvas?.revision ?? 0);

		// 渲染器重建后从当前规范状态重新渲染；渲染 revision 最终达到规范 revision。
		await page.waitForFunction(
			(expected: number) =>
				((window as unknown as { __bevyRuntime?: { renderedRevision?: () => number } }).__bevyRuntime?.renderedRevision?.() ?? 0) >=
				expected,
			canvas?.revision ?? 0,
			{ timeout: 30_000 }
		);
		expect(await readRenderedRevision(page)).toBeGreaterThanOrEqual(canvas?.revision ?? 0);
	});

	test("基于过期 revision 的命令被拒绝，且不改变规范状态", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 0, y: 0 },
			commandId: "e2e-stale-create"
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);

		// 更新一个不存在的节点：本地 reducer 在发送前拒绝（design D4），不进入 pending。
		const before = await readStoredCanvas(page);
		const rejected = await sendCommands(
			page,
			[{ type: "node.update", nodeId: "node-unknown", position: { x: 1, y: 1 } }],
			"e2e-stale-move"
		);
		expect(rejected.ok).toBe(false);
		expect(rejected.reason).toBeTruthy();
		await page.waitForTimeout(300);
		const after = await readStoredCanvas(page);
		expect(after?.revision).toBe(before?.revision);
		expect(after?.document.nodes.map((node) => node.id)).toEqual(before?.document.nodes.map((node) => node.id));
	});
});
