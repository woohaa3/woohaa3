/**
 * 执行面板的浏览器验收（change: add-image-text-node-execution，任务 11.3 / 11.4 / 11.5）。
 *
 * 用真实页面 + 真实桥接协议驱动：Godot 只上报节点 ID（这里用 `selection.changed` 等价上报），
 * Web 从规范 Canvas Store 解析类型并决定面板。
 *
 * 断言的是**用户可见行为**：
 * - 图片节点只显示图片面板、文本节点只显示文本面板、其它类型/无选中/失效 ID 不显示；
 * - 参考输入不满足时显示 blocking reason 且主操作被真正禁用；
 * - 面板贴底且宽度不溢出；DOM 里不存在被删除的旧展示组件。
 */
import { expect, test } from "@playwright/test";
import { currentFrameRevision,
	createNode,
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	sendSelection,
	waitForCanvasSession } from "./helpers.js";

const DOCK = ".node-execution-dock";
const PANEL = `${DOCK} [data-task-kind]`;

test.describe("执行面板", () => {
	test("节点类型映射：图片/文本显示对应面板，其它类型与失效 ID 不显示", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 建三个节点：图片、文本、以及一个没有执行入口的 3D 模型节点。
		let revision = 0;
		for (const [operationId, nodeType] of [
			["e2e-panel-image", "image"],
			["e2e-panel-text", "text"],
			["e2e-panel-generate", "model3d"]
		] as const) {
			const created = await createNode(page, {
				nodeType,
				position: { x: 0, y: 0 },
				commandId: operationId
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			revision = created.revision ?? revision;
		}

		const canvas = await readStoredCanvas(page);
		const imageNode = canvas?.document.nodes.find((node) => node.type === "image");
		const textNode = canvas?.document.nodes.find((node) => node.type === "text");
		const generateNode = canvas?.document.nodes.find((node) => node.type === "model3d");
		expect(imageNode && textNode && generateNode).toBeTruthy();

		// 没有选中时：不显示面板。
		await expect(page.locator(DOCK)).toHaveCount(0);
		const revisionBeforeSelection = (await readStoredCanvas(page))?.revision ?? -1;

		// 选中图片节点 → 只显示图片面板。
		revision = await currentFrameRevision(page);
		const selectImage = await sendSelection(page, {
			nodeIds: imageNode?.id ?? "",
			operationId: "e2e-select-image",
			revision
		});
		expect(selectImage.rejected).toBeUndefined();
		await expect(page.locator(PANEL)).toHaveCount(1);
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "image-generation");

		// 选中文本节点 → 只显示文本面板。
		const selectText = await sendSelection(page, {
			nodeIds: textNode?.id ?? "",
			operationId: "e2e-select-text",
			revision
		});
		expect(selectText.rejected).toBeUndefined();
		await expect(page.locator(PANEL)).toHaveCount(1);
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "text-generation");

		// 选中不支持的节点类型 → 面板消失。
		const selectGenerate = await sendSelection(page, {
			nodeIds: generateNode?.id ?? "",
			operationId: "e2e-select-generate",
			revision
		});
		expect(selectGenerate.rejected).toBeUndefined();
		// 3D model3d 节点没有**执行**入口（无 [data-task-kind] 执行面板），但可以有模型参数面板。
		await expect(page.locator(PANEL)).toHaveCount(0);

		// 选中一个不存在的节点 ID → 同样清空。
		const selectMissing = await sendSelection(page, {
			nodeIds: "node-does-not-exist",
			operationId: "e2e-select-missing",
			revision
		});
		expect(selectMissing.rejected).toBeUndefined();
		await expect(page.locator(DOCK)).toHaveCount(0);

		// 重新选中图片节点，然后取消选中 → 面板消失。
		await sendSelection(page, {
			nodeIds: imageNode?.id ?? "",
			operationId: "e2e-select-image-again",
			revision
		});
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "image-generation");

		const cleared = await sendSelection(page, {
			nodeIds: null,
			operationId: "e2e-select-clear",
			revision
		});
		expect(cleared.rejected).toBeUndefined();
		await expect(page.locator(DOCK)).toHaveCount(0);

		// 选中变化不产生任何画布提交（选中不是规范状态）。
		const after = await readStoredCanvas(page);
		expect(after?.revision).toBe(revisionBeforeSelection);
	});

	test("面板由 catalog 驱动、贴底且不溢出，DOM 中不存在旧展示组件", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		const created = await createNode(page, {
			nodeType: "image",
			position: { x: 0, y: 0 },
			commandId: "e2e-layout-image"
		});
		expect(created.ok).toBe(true);
		revision = created.revision ?? revision;

		const canvas = await readStoredCanvas(page);
		const imageNode = canvas?.document.nodes[0];
		revision = await currentFrameRevision(page);
		await sendSelection(page, {
			nodeIds: imageNode?.id ?? "",
			operationId: "e2e-layout-select",
			revision
		});
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "image-generation");

		// 模型选项来自 catalog（站点不硬编码模型表）。
		await expect(page.locator(`${DOCK} .mc-panel__model-trigger`)).toContainText("Image 2");
		// 参数来自 schema 的 enum 投影。
		await page.locator(`${DOCK} .mc-panel__settings-trigger`).click();
		await expect(page.locator(".mc-panel__settings-menu")).toContainText("比例");

		// 布局：贴底（bottom = max(16px, safe-area-inset-bottom)）且宽度不超过 760 或视口-32。
		const box = await page.locator(DOCK).boundingBox();
		expect(box).not.toBeNull();
		const viewport = page.viewportSize();
		expect(box!.width).toBeLessThanOrEqual(Math.min(760, (viewport?.width ?? 0) - 32) + 1);
		const gap = (viewport?.height ?? 0) - (box!.y + box!.height);
		expect(gap).toBeGreaterThanOrEqual(15);
		// 不产生横向滚动。
		const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflowX).toBeLessThanOrEqual(0);

		// 旧展示组件已删除。
		expect(await page.locator(".focus-badge").count()).toBe(0);
		expect(await page.locator(".boot").count()).toBe(0);
		expect(await page.locator('[data-canvas-ui="tips"]').count()).toBe(0);

		// 窄屏同样不溢出。
		await page.setViewportSize({ width: 420, height: 720 });
		const narrow = await page.locator(DOCK).boundingBox();
		expect(narrow).not.toBeNull();
		expect(narrow!.width).toBeLessThanOrEqual(420 - 32 + 1);
		const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(narrowOverflow).toBeLessThanOrEqual(0);
	});

	test("上游图片未就绪时显示 blocking reason 且主操作被禁用", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 先建上游图片节点，再从它拉线建下游图片节点（连线即参考输入）。
		let revision = 0;
		const upstream = await createNode(page, {
			nodeType: "image",
			position: { x: 0, y: 0 },
			commandId: "e2e-block-upstream"
		});
		expect(upstream.ok).toBe(true);
		revision = upstream.revision ?? revision;

		const upstreamId = (await readStoredCanvas(page))?.document.nodes.find((node) => node.type === "image")?.id;
		const downstream = await createNode(page, {
			nodeType: "image",
			position: { x: 600, y: 0 },
			connect: { fromNodeId: upstreamId as string },
			commandId: "e2e-block-downstream"
		});
		expect(downstream.ok, JSON.stringify(downstream)).toBe(true);
		revision = downstream.revision ?? revision;

		const canvas = await readStoredCanvas(page);
		const downstreamId = canvas?.document.nodes.find((node) => node.id !== upstreamId)?.id;
		revision = await currentFrameRevision(page);
		await sendSelection(page, {
			nodeIds: downstreamId ?? "",
			operationId: "e2e-block-select",
			revision
		});

		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "image-generation");
		// 上游没有输出 ⇒ 明确阻止，而不是静默忽略这条连线。
		const reasons = page.locator(`${DOCK} [role="status"]`);
		await expect(reasons).toContainText("还没有可用输出");
		// 主操作被真正禁用，并且用 aria-describedby 关联到原因。
		const send = page.locator(`${DOCK} .mc-panel__send`);
		await expect(send).toBeDisabled();
		await expect(send).toHaveAttribute("aria-describedby", /.+/);
	});
});

test.describe("端到端执行（浏览器 → 网关 → COS → 画布 → 同源媒体）", () => {
	// 说明（change: split-web-runtime-services，任务 6.2）：
	// 浏览器不再有「本地等待终态并写结果」的同步链路。真实的端到端执行路径
	// （浏览器 run/cancel → Canvas Service → Task Service → Media 转存 → projector 写
	// 权威 Y.Doc → Yjs 广播）由 `e2e/run-cancel.spec.ts` 在 `playwright.yjs.config.ts`
	// 下覆盖。这里保留的是**面板与 catalog 的前端行为**用例（见上一个 describe）。
});
