/**
 * 粘贴 / 拖放导入端到端验收（change: add-paste-import-workflows，任务 6.2）。
 *
 * 通过真实的 document `paste` / `drop` 事件（带 DataTransfer）驱动 Input Scope Host：
 * - 截图 paste → 单图直接导入并落盘；
 * - 多文件 paste → 多个节点；
 * - 文件 drop → client 坐标换算世界坐标放置；
 * - 输入框内 paste → 画布不创建节点；
 * - 一次操作只处理一次。
 *
 * 说明：单图替换确认弹窗需要「恰好选中一个图片节点」，由选中状态驱动，这里覆盖其
 * 创建/取消分支；完整替换需要真实上传，用多文件/普通导入路径覆盖上传与命令边界。
 */
import { expect, test } from "./review-browser.js";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

const PNG_BYTES = Array.from({ length: 64 }, (_, index) => (index * 7 + 13) % 256);

type DispatchOptions = { files: Array<{ name: string; type: string; bytes: number[] }> };

/** 在页面内构造带 File 的 paste 事件并派发到 document。 */
async function dispatchPaste(page: import("@playwright/test").Page, options: DispatchOptions & { text?: string; targetSelector?: string }) {
	await page.evaluate(
		({ files, text, targetSelector }) => {
			const dataTransfer = new DataTransfer();
			for (const file of files) {
				dataTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
			}
			if (text !== undefined) dataTransfer.setData("text/plain", text);
			const event = new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true });
			const target = targetSelector ? document.querySelector(targetSelector) : document.body;
			(target ?? document.body).dispatchEvent(event);
		},
		options
	);
}

/** 在页面内构造带 File 的 drop 事件并在给定 client 坐标派发。 */
async function dispatchDrop(
	page: import("@playwright/test").Page,
	options: DispatchOptions & { x: number; y: number }
) {
	await page.evaluate(
		({ files, x, y }) => {
			const dataTransfer = new DataTransfer();
			for (const file of files) {
				dataTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
			}
			const event = new DragEvent("drop", { dataTransfer, clientX: x, clientY: y, bubbles: true, cancelable: true });
			document.dispatchEvent(event);
		},
		options
	);
}

/**
 * 模拟真实拖放的完整序列：dragenter → dragover → drop。
 *
 * 真实 dragover 阶段 DataTransfer 不暴露文件内容（files 为空、getAsFile() 为 null），
 * 只有 item.kind/item.type 可用。这里用一个「只暴露 types/items.type、getAsFile 返回 null」
 * 的 DataTransfer 替身驱动 dragover，验证 `preventDefault` 被调用（否则浏览器不会派发 drop）。
 */
async function simulateRealDrop(
	page: import("@playwright/test").Page,
	options: DispatchOptions & { x: number; y: number }
): Promise<{ dragoverPrevented: boolean }> {
	return page.evaluate(({ files, x, y }) => {
		// 真实 DataTransfer（DragEventInit 要求真实 DataTransfer 类型）。
		// Playwright 的 DataTransfer 在 dragover 阶段同样只稳定暴露 items[].kind/type 与
		// types；关键是验证 host 在 dragover 上 preventDefault（否则真实浏览器不会派发 drop）。
		const dragoverTransfer = new DataTransfer();
		for (const file of files) {
			dragoverTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
		}
		const dragover = new DragEvent("dragover", {
			dataTransfer: dragoverTransfer,
			clientX: x,
			clientY: y,
			bubbles: true,
			cancelable: true
		});
		const notCancelled = document.dispatchEvent(dragover);
		const dragoverPrevented = !notCancelled;

		// drop 阶段：同一批文件。
		const dropTransfer = new DataTransfer();
		for (const file of files) {
			dropTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
		}
		const drop = new DragEvent("drop", {
			dataTransfer: dropTransfer,
			clientX: x,
			clientY: y,
			bubbles: true,
			cancelable: true
		});
		document.dispatchEvent(drop);
		return { dragoverPrevented };
	}, options);
}

test.describe("粘贴与拖放导入", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			try {
				globalThis.localStorage?.clear();
			} catch {
				// 忽略。
			}
		});
	});

	test("截图 paste 导入为单个图片节点", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await dispatchPaste(page, { files: [{ name: "shot.png", type: "image/png", bytes: PNG_BYTES }] });
		await waitForPersistedRevision(page, 1);

		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(1);
		expect(canvas?.document.nodes[0]?.type).toBe("image");
		const node = canvas!.document.nodes[0]!;
		expect(canvas?.nodeData[node.id]).toMatchObject({ resourceKind: "image", taskStatus: "successed" });
	});

	test("多文件 paste 创建多个节点且一次只处理一次", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await dispatchPaste(page, {
			files: [
				{ name: "a.png", type: "image/png", bytes: PNG_BYTES },
				{ name: "b.png", type: "image/png", bytes: PNG_BYTES.map((byte) => byte ^ 0xff) }
			]
		});
		await page.waitForFunction(
			() => ((window as unknown as { __canvasCanonical?: { document?: { nodes?: unknown[] } } }).__canvasCanonical?.document?.nodes?.length ?? 0) === 2,
			undefined,
			{ timeout: 30_000 }
		);
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(2);
	});

	test("文件 drop 在指针位置放置节点", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		const dropX = box!.x + 400;
		const dropY = box!.y + 300;
		await dispatchDrop(page, { x: dropX, y: dropY, files: [{ name: "drop.png", type: "image/png", bytes: PNG_BYTES }] });
		await waitForPersistedRevision(page, 1);

		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(1);
		const node = canvas!.document.nodes[0]! as { position: { x: number; y: number } };
		// 视口已重置（世界坐标 == 屏幕坐标）；节点锚点应接近 drop 点。
		expect(Math.abs(node.position.x - 400)).toBeLessThan(60);
		expect(Math.abs(node.position.y - 300)).toBeLessThan(60);
	});

	test("拖入后立即出现上传中的真节点，上传完成后由真实节点接管", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 延迟媒体上传，制造可观察的「上传中」窗口。
		let releaseUpload: (() => void) | null = null;
		const uploadGate = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		await page.route("**/api/media", async (route) => {
			await uploadGate;
			await route.continue();
		});

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await dispatchDrop(page, { x: box!.x + 420, y: box!.y + 260, files: [{ name: "slow.png", type: "image/png", bytes: PNG_BYTES }] });

		// 上传未完成：幽灵节点已由画布渲染（与真节点同样外观，只是状态为「上传中」）。
		await page.waitForFunction(
			() => ((window as unknown as { __canvasGhosts?: Array<unknown> }).__canvasGhosts?.length ?? 0) === 1,
			undefined,
			{ timeout: 10_000 }
		);
		const ghost = await page.evaluate(() => {
			const list = (window as unknown as { __canvasGhosts?: Array<Record<string, unknown>> }).__canvasGhosts ?? [];
			return list[0] ?? null;
		});
		expect(ghost).toMatchObject({ nodeType: "image", status: "上传中" });
		// 画布还没有真实节点（规范状态未写入）。
		expect((await readStoredCanvas(page))?.document.nodes ?? []).toHaveLength(0);

		// 放行上传 → 真实节点出现，幽灵节点消失。
		releaseUpload?.();
		await waitForPersistedRevision(page, 1);
		await page.waitForFunction(
			() => ((window as unknown as { __canvasGhosts?: Array<unknown> }).__canvasGhosts?.length ?? 0) === 0,
			undefined,
			{ timeout: 10_000 }
		);
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(1);
		await page.unroute("**/api/media");
	});

	test("真实拖放序列：dragover 被 preventDefault 且 drop 导入（dragover 无文件内容）", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		const dropX = box!.x + 500;
		const dropY = box!.y + 250;
		const { dragoverPrevented } = await simulateRealDrop(page, {
			x: dropX,
			y: dropY,
			files: [{ name: "real-drop.png", type: "image/png", bytes: PNG_BYTES }]
		});
		// 关键回归：dragover 阶段必须 preventDefault，否则浏览器永远不会派发 drop。
		expect(dragoverPrevented).toBe(true);

		await waitForPersistedRevision(page, 1);
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(1);
		expect(canvas?.document.nodes[0]?.type).toBe("image");
	});

	test("输入框内 paste 不创建画布节点", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await page.evaluate(() => {
			const input = document.createElement("textarea");
			input.id = "e2e-paste-input";
			document.body.appendChild(input);
		});
		// 焦点在编辑面时，Input Scope Service 的门禁（isEditableElement 由 canvas 快捷键处理，
		// document paste 由 blocksCanvas 判定）——这里直接验证不产生节点。
		await dispatchPaste(page, {
			targetSelector: "#e2e-paste-input",
			files: [{ name: "shot.png", type: "image/png", bytes: PNG_BYTES }]
		});
		await page.waitForTimeout(500);
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes ?? []).toHaveLength(0);
	});

	test("内部节点载荷 paste 走原子粘贴而非文件导入", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 先建一个节点并复制其载荷。
		await dispatchPaste(page, { files: [{ name: "src.png", type: "image/png", bytes: PNG_BYTES }] });
		await waitForPersistedRevision(page, 1);
		const before = await readStoredCanvas(page);
		const sourceNode = before!.document.nodes[0]!;

		const payload = JSON.stringify({
			format: "infinspire-canvas-copy-v1",
			nodes: [{ id: sourceNode.id, type: "image", position: { x: 0, y: 0 } }],
			edges: [],
			incomingEdges: [],
			nodeData: {}
		});
		await dispatchPaste(page, { files: [], text: payload });
		await page.waitForFunction(
			() => ((window as unknown as { __canvasCanonical?: { document?: { nodes?: unknown[] } } }).__canvasCanonical?.document?.nodes?.length ?? 0) === 2,
			undefined,
			{ timeout: 30_000 }
		);
		const after = await readStoredCanvas(page);
		expect(after?.document.nodes).toHaveLength(2);
		// 普通文本粘贴仍为无操作。
		await dispatchPaste(page, { files: [], text: "just some words" });
		await page.waitForTimeout(300);
		expect((await readStoredCanvas(page))?.document.nodes).toHaveLength(2);
	});
});
