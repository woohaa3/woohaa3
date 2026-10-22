/**
 * 右键菜单端到端验收（change: 后续 change 补齐右键菜单）。
 *
 * 用真实鼠标事件驱动浏览器交互控制器：
 * - 空白右键短点击 → 打开菜单 → 插入文本/图片/模型/视频/音频；
 * - 右键拖拽达到阈值 → 平移，不打开菜单；
 * - 节点右键 → 删除节点；
 * - 菜单「上传…」→ 真实上传到 Media Service → 提交 asset + 节点；
 * - 断线只读时插入项禁用。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

const MENU = ".canvas-context-menu";
const ITEM = `${MENU} .canvas-context-menu__item`;

/** 视口是各浏览器本地状态（localStorage）：每个用例清掉，让世界坐标 == 屏幕坐标。 */
async function resetLocalViewport(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		try {
			globalThis.localStorage?.clear();
		} catch {
			// 忽略。
		}
	});
}

async function openBlankMenu(page: import("@playwright/test").Page, x: number, y: number) {
	await page.mouse.move(x, y);
	await page.mouse.down({ button: "right" });
	await page.mouse.up({ button: "right" });
	await expect(page.locator(MENU)).toBeVisible();
}

test.describe("右键菜单", () => {
	test.beforeEach(async ({ page }) => {
		await resetLocalViewport(page);
	});

	test("空白右键插入五类节点都落盘且带默认 taskKind", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();

		const expectations: Array<{ label: string; type: string; taskKind?: string }> = [
			{ label: "文本", type: "text", taskKind: "text-generation" },
			{ label: "图片", type: "image", taskKind: "image-generation" },
			{ label: "模型", type: "model3d" },
			{ label: "视频", type: "video", taskKind: "video-generation" },
			{ label: "音频", type: "audio", taskKind: "audio-generation" }
		];

		// 节点默认 260x195；每个插入点间隔 > 宽度，保证下一次右键落在空白处。
    const baseY = box!.y + 160;
		let revision = 0;
		let offset = 0;
		for (const entry of expectations) {
			await openBlankMenu(page, box!.x + 40 + offset, baseY);
			await page.locator(ITEM, { hasText: entry.label }).click();
			await revision_check(page, ++revision, entry.type, entry.taskKind);
			offset += 300;
		}

		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.nodes).toHaveLength(5);
	});

	test("右键拖拽达到阈值平移且不打开菜单", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		const startX = box!.x + 400;
		const startY = box!.y + 300;

		await page.mouse.move(startX, startY);
		await page.mouse.down({ button: "right" });
		await page.mouse.move(startX + 80, startY + 40, { steps: 4 });
		await page.mouse.up({ button: "right" });

		await expect(page.locator(MENU)).toHaveCount(0);
	});

	test("节点右键删除节点", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 先建一个文本节点（用菜单插入），再右键它删除。
		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await openBlankMenu(page, box!.x + 200, box!.y + 200);
		await page.locator(ITEM, { hasText: "文本" }).click();
		await waitForPersistedRevision(page, 1);

		// 节点默认宽 260/高 195，落在节点中部右键。
		await page.mouse.move(box!.x + 200 + 120, box!.y + 200 + 100);
		await page.mouse.down({ button: "right" });
		await page.mouse.up({ button: "right" });
		await expect(page.locator(MENU)).toBeVisible();
		await page.locator(ITEM, { hasText: "删除作品" }).click();

		await page.waitForFunction(
			() => ((window as unknown as { __canvasCanonical?: { document?: { nodes?: unknown[] } } }).__canvasCanonical?.document?.nodes?.length ?? -1) === 0,
			undefined,
			{ timeout: 30_000 }
		);
	});

	test("菜单上传图片：先落资产再落节点", async ({ page }) => {		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await openBlankMenu(page, box!.x + 260, box!.y + 240);
		await page.locator(ITEM, { hasText: "上传…" }).click();

		// 1x1 PNG。
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64"
		);
		await page.locator('input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });

		await page.waitForFunction(
			() => {
				const canvas = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ type?: string }> }; assets?: unknown[] } }).__canvasCanonical;
				const hasImageNode = canvas?.document?.nodes?.some((node) => node.type === "image") ?? false;
				return hasImageNode && (canvas?.assets?.length ?? 0) >= 1;
			},
			undefined,
			{ timeout: 30_000 }
		);

		const canvas = await readStoredCanvas(page);
		const imageNode = canvas?.document.nodes.find((node) => node.type === "image");
		expect(imageNode).toBeDefined();
		expect(canvas?.nodeData[imageNode!.id]).toMatchObject({ resourceKind: "image", taskStatus: "successed" });
		expect(canvas?.assets[0]).toMatchObject({ mediaKind: "image", source: "uploaded", status: "ready" });
	});

	test("菜单上传文本：正文进资产 text 字段", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await openBlankMenu(page, box!.x + 260, box!.y + 240);
		await page.locator(ITEM, { hasText: "上传…" }).click();

		await page.locator('input[type="file"]').setInputFiles({
			name: "note.md",
			mimeType: "text/markdown",
			buffer: Buffer.from("# 标题\n正文内容", "utf8")
		});

		await page.waitForFunction(
			() => {
				const canvas = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ type?: string }> }; assets?: Array<{ text?: string }> } }).__canvasCanonical;
				const hasTextNode = canvas?.document?.nodes?.some((node) => node.type === "text") ?? false;
				return hasTextNode && (canvas?.assets?.some((asset) => asset.text === "# 标题\n正文内容") ?? false);
			},
			undefined,
			{ timeout: 30_000 }
		);

		const canvas = await readStoredCanvas(page);
		const textNode = canvas?.document.nodes.find((node) => node.type === "text");
		expect(canvas?.nodeData[textNode!.id]).toMatchObject({ resourceKind: "text", taskStatus: "successed" });
	});

	test("从输出端口拉线到空白复用同一菜单并建节点+连线", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 先插入一个图片节点作为拉线起点。
		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		await openBlankMenu(page, box!.x + 120, box!.y + 120);
		await page.locator(ITEM, { hasText: "图片" }).click();
		await waitForPersistedRevision(page, 1);
		const canvas = await readStoredCanvas(page);
		const sourceNode = canvas!.document.nodes.find((node) => node.type === "image")! as unknown as {
			id: string;
			position: { x: number; y: number };
			width?: number;
			height?: number;
		};
		const width = sourceNode.width ?? 260;
		const height = sourceNode.height ?? 195;

		// 输出端口在节点右中。视口已重置，世界坐标 == 屏幕坐标。
		const portX = box!.x + sourceNode.position.x + width;
		const portY = box!.y + sourceNode.position.y + height / 2;
		const dropX = box!.x + 760;
		const dropY = box!.y + 460;

		await page.mouse.move(portX, portY);
		await page.mouse.down();
		await page.mouse.move(dropX, dropY, { steps: 6 });
		await page.mouse.up();

		// 释放到空白 → 与空白右键共用同一个菜单（同一份目录、同一套菜单项）。
		await expect(page.locator(MENU)).toBeVisible();
		const connectLabels = await page.locator(ITEM).allTextContents();
		expect(connectLabels).toEqual(["文本", "图片", "3D 模型", "视频", "音频", "上传…"]);
		await page.locator(ITEM, { hasText: "视频" }).click();

		await page.waitForFunction(
			() => {
				const canvas = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ type?: string }>; edges?: unknown[] } } }).__canvasCanonical;
				return (canvas?.document?.nodes?.length ?? 0) === 2 && (canvas?.document?.edges?.length ?? 0) === 1;
			},
			undefined,
			{ timeout: 30_000 }
		);

		const after = await readStoredCanvas(page);
		const videoNode = after!.document.nodes.find((node) => node.type === "video")!;
		expect(after!.document.edges[0]).toMatchObject({ source: sourceNode.id, target: videoNode.id });
		expect(after!.nodeData[videoNode.id]).toMatchObject({ taskKind: "video-generation" });
		expect(after!.nodeData[videoNode.id]?.inputMapping).toHaveLength(1);
	});

	test("断线只读时插入项禁用", async ({ page }) => {		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await page.context().setOffline(true);
		// 等会话进入只读（offline 事件驱动）。
		await page.waitForFunction(
			() => (window as unknown as { __canvasSessionStatus?: { remote?: { mode?: string } } }).__canvasSessionStatus?.remote?.mode === "offline",
			undefined,
			{ timeout: 10_000 }
		);

		const box = await page.locator("#bevy-canvas").boundingBox();
		await openBlankMenu(page, box!.x + 200, box!.y + 200);
		const textItem = page.locator(ITEM, { hasText: "文本" });
		await expect(textItem).toBeDisabled();
		await page.context().setOffline(false);
	});
});

/** 等到规范状态出现目标类型节点且 nodeData 匹配。 */
async function revision_check(
	page: import("@playwright/test").Page,
	revision: number,
	type: string,
	taskKind?: string
) {
	await waitForPersistedRevision(page, revision);
	const canvas = await readStoredCanvas(page);
	const node = canvas?.document.nodes.find((candidate) => candidate.type === type);
	expect(node, `缺少 ${type} 节点`).toBeDefined();
	if (taskKind) {
		expect(canvas?.nodeData[node!.id]).toMatchObject({ taskKind, taskStatus: "idle" });
	} else {
		// 3D 模型节点不预填任务字段。
		expect(canvas?.nodeData[node!.id]?.taskKind).toBeUndefined();
	}
}
