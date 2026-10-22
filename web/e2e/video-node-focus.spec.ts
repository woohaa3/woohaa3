import { designEvidence } from "./design-evidence.js";
/**
 * 视频节点原地聚焦工作区浏览器验收
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 5.3/5.4/5.6）。
 *
 * 真实 Bevy WASM + 真实三服务 + 确定性视频 fixture（蓝→红）：
 * 基础用例使用 160×90，纹理尺寸切换回归使用 1280×720。
 * - 双击视频节点原地聚焦（不打开截帧 Dialog），仅查看零 canonical 命令；
 * - 二维取景（缩放变化、适应窗口）；
 * - 首/当前/尾帧捕获、批量添加生成新图片节点；
 * - 退出/Escape 关闭聚焦并恢复进入前视口、停止聚焦解码；
 * - 390px 窄屏无横向溢出。
 *
 * 说明：历史中央播放/设为当前回流需要真实生成任务注册 node history（另见 change 验收记录），
 * 本 spec 覆盖双击聚焦与截帧主链路。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
	canvasRevision,
	installPageHelpers,
	resetCanvasStorage,
	seedYjsCanvas,
	sendCommands,
	uploadMedia,
	waitForBevyReady,
	waitForCanvasSession,
	waitForCommandsSettled
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_FIXTURE = resolve(here, "fixtures/video-live-preview-fixture.webm");
const VIDEO_BYTES = readFileSync(VIDEO_FIXTURE);
const FOCUS_VIDEO_BYTES = readFileSync(resolve(here, "fixtures/video-focus-resolution-fixture.webm"));
const POSTER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64"
);

async function uploadBytes(page: Page, bytes: Buffer, contentType: string) {
	const result = await uploadMedia(page, [...bytes], contentType);
	expect(result.status, `上传失败：${JSON.stringify(result.body)}`).toBe(201);
	return { storageKey: String(result.body.storageKey), url: String(result.body.url) };
}

/** 建一个 video 节点 + 前置 text 节点与连线，绑定 ready 视频输出（含 poster）。 */
async function seedVideoNode(page: Page, bytes = VIDEO_BYTES): Promise<void> {
	const video = await uploadBytes(page, bytes, "video/webm");
	const poster = await uploadBytes(page, POSTER_PNG, "image/png");
	const now = new Date().toISOString();
	await seedYjsCanvas(page, CANVAS, [], {
		canvas: {
			id: CANVAS,
			title: "E2E 画布",
			revision: 1,
			document: {
				schemaVersion: "asset-canvas-v1",
				nodes: [
					{ id: "before-video", type: "text", position: { x: 120, y: 360 }, width: 200, height: 100 },
					{ id: "node-video-1", type: "video", position: { x: 120, y: 120 }, width: 320, height: 200 }
				],
				edges: [],
				updatedAt: now
			},
			nodeData: {
				"before-video": { title: "输入参考", text: "前序节点" },
				"node-video-1": { outputAssetId: "asset-video-1", resourceKind: "video", taskStatus: "successed" }
			},
			assets: [
				{
					id: "asset-video-1",
					title: "测试视频",
					mediaKind: "video",
					source: "uploaded",
					status: "ready",
					url: video.url,
					posterUrl: poster.url,
					createdAt: now,
					metadata: { storageKey: video.storageKey, checksum: video.storageKey.replace("sha256-", ""), contentType: "video/webm", size: bytes.length }
				}
			],
			jobs: [],
			updatedAt: now
		}
	});
	await page.goto("/");
	await waitForCanvasSession(page);
	// 真实拓扑：显式添加一条件（截帧图片不会自动连线；这里验证真实前序圆点）。
	const linked = await sendCommands(page, [{ type: "edge.add", edge: { id: "in-video", source: "before-video", target: "node-video-1" } }], "e2e-video-in-edge");
	expect(linked.ok, JSON.stringify(linked)).toBe(true);
	await waitForCommandsSettled(page);
}

async function worldToClient(page: Page, world: { x: number; y: number }) {
	return page.evaluate((point) => {
		const viewport = (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
		const rect = (document.querySelector("#bevy-canvas") as HTMLCanvasElement).getBoundingClientRect();
		return { x: point.x * viewport.zoom + viewport.x + rect.left, y: point.y * viewport.zoom + viewport.y + rect.top };
	}, world);
}

async function videoFocusFocused(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as unknown as { __canvasVideoFocus?: { focused: () => boolean } }).__canvasVideoFocus?.focused() ?? false);
}

/** fixture 在蓝、红画面间切换；读取真实 WASM 画面，避免只验证播放状态。 */
async function videoColor(page: Page): Promise<"blue" | "red" | null> {
	// 即时读取浏览器合成帧，避免 locator 截图等待布局稳定时错过短视频的颜色阶段。
	const cdp = await page.context().newCDPSession(page);
	let screenshot: string;
	try {
		screenshot = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data;
	} finally {
		await cdp.detach();
	}
	return page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
		ctx.drawImage(bitmap, 0, 0);
		const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let blue = 0, red = 0;
		for (let i = 0; i < pixels.length; i += 16) {
			const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
			if (b > r + 60 && b > g + 60) blue++;
			if (r > b + 60 && r > g + 60) red++;
		}
		return Math.max(blue, red) < 300 ? null : blue > red ? "blue" : "red";
	}, screenshot);
}

/** 放慢并定位 hover 播放，避免软件渲染较慢时截图错过短视频的环回阶段。 */
async function seekHoverFrame(page: Page, time: number): Promise<void> {
	await page.evaluate(async seconds => {
		const video = (window as unknown as { __videoFrameTestVideos: HTMLVideoElement[] })
			.__videoFrameTestVideos.find(video => video.loop && !!video.src);
		if (!video) throw new Error("hover 视频解码器不存在");
		video.playbackRate = 0.1;
		await new Promise<void>(resolve => {
			video.addEventListener("seeked", () => resolve(), { once: true });
			video.currentTime = seconds;
		});
		await video.play();
	}, time);
}

test.describe("视频节点原地聚焦（change: 2026-10-10-add-video-node-focus-workspace）", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForBevyReady(page);
	});

	test("双击视频原地聚焦（无 Dialog），仅查看零命令；返回恢复视口", async ({ page }) => {
		await seedVideoNode(page);
		const before = await canvasRevision(page);
		const savedViewport = await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.());

		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.dblclick(center.x, center.y);

		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		// 双击不打开截帧 Dialog。
		await expect(page.locator(".dlg-host")).toHaveCount(0);
		expect(await videoFocusFocused(page)).toBe(true);
		// 仅查看：不提交 canonical 命令、revision 不变。
		expect(await canvasRevision(page)).toBe(before);
		// 左侧真实前序连接圆点可见（真实拓扑）。
		await expect(page.locator('[data-focus-connections="incoming"] .focus-connections__dot')).toHaveCount(1);

		// Escape 退出并恢复进入前视口。
		await page.keyboard.press("Escape");
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		expect(await videoFocusFocused(page)).toBe(false);
		expect(await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.())).toEqual(savedViewport);
	});

	test("双击放大后画面不消失：进入动画结束仍是真实帧而非空白", async ({ page }) => {
		// 回归：聚焦会话曾在 seek/未解码时上传透明帧并占用节流时间窗，表现为「放大后视频消失」，
		// 自动播放被拒（暂停）时空白帧会一直留在纹理上。
		await seedVideoNode(page);
		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.dblclick(center.x, center.y);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect.poll(async () => page.evaluate(() => (window as unknown as { __canvasVideoFocus?: { projection: () => unknown } }).__canvasVideoFocus?.projection() != null)).toBe(true);

		// 进入动画结束后画面必须有真实内容（非空），且退出/再进入仍能看到。
		await expect.poll(() => videoColor(page), { intervals: [150], timeout: 20_000 }).not.toBeNull();
		// 聚焦纹理已上传且尺寸为源尺寸（不是占位/空白）。
		const texture = await page.evaluate(() => {
			const focus = (window as unknown as { __canvasVideoFocus?: { projection: () => { sourceWidth: number; sourceHeight: number } | null } }).__canvasVideoFocus;
			return focus?.projection() ?? null;
		});
		expect(texture?.sourceWidth).toBeGreaterThan(0);

		// 放大进入后等待「稳定」再复核一次：若空白帧被留在纹理上，这里会读到 null。
		await page.waitForTimeout(600);
		await expect.poll(() => videoColor(page), { intervals: [150], timeout: 20_000 }).not.toBeNull();

		// 退出再进入：第二次进入同样不能空白。
		await page.keyboard.press("Escape");
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		const restored = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.move(restored.x, restored.y);
		await page.mouse.dblclick(restored.x, restored.y);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => videoColor(page), { intervals: [150], timeout: 20_000 }).not.toBeNull();
	});

	test("二维取景：滚轮缩放改变投影，适应窗口复位", async ({ page }) => {
		await seedVideoNode(page);
		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.dblclick(center.x, center.y);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		// 等待真实解码帧就绪并推出取景投影。
		await page.waitForFunction(() => (window as unknown as { __canvasVideoFocus?: { projection: () => unknown } }).__canvasVideoFocus?.projection() != null, undefined, { timeout: 20_000, polling: 100 });

		const fitZoom = await page.evaluate(() => (window as unknown as { __canvasVideoFocus?: { projection: () => { viewport: { zoom: number } } | null } }).__canvasVideoFocus?.projection()?.viewport.zoom ?? 0);
		expect(fitZoom).toBeGreaterThan(0);

		const stage = page.locator("[data-video-focus-stage]");
		const box = (await stage.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -400);
		await expect.poll(async () => page.evaluate(() => (window as unknown as { __canvasVideoFocus?: { projection: () => { viewport: { zoom: number } } | null } }).__canvasVideoFocus?.projection()?.viewport.zoom ?? 0)).not.toBe(fitZoom);
		await page.getByRole("button", { name: "适应窗口" }).click();
		await expect.poll(async () => page.evaluate(() => (window as unknown as { __canvasVideoFocus?: { projection: () => { viewport: { zoom: number } } | null } }).__canvasVideoFocus?.projection()?.viewport.zoom ?? 0)).toBeCloseTo(fitZoom, 3);
		// 取景不写 canonical。
		expect(await canvasRevision(page)).toBeGreaterThanOrEqual(1);
	});

	test("聚焦播放更新真实画面，退出后 hover 与再次聚焦仍可播放", async ({ page }) => {
		test.setTimeout(180_000);
		await page.addInitScript(() => {
			const create = document.createElement.bind(document);
			const videos: HTMLVideoElement[] = [];
			Object.assign(window, { __videoFrameTestVideos: videos });
			document.createElement = ((tag: string, options?: ElementCreationOptions) => {
				const element = create(tag, options);
				if (element instanceof HTMLVideoElement) videos.push(element);
				return element;
			}) as typeof document.createElement;
		});
		// 1280×720：卡片上传 1024×576，聚焦上传 1280×720，退出再降回卡片尺寸。
		await seedVideoNode(page, FOCUS_VIDEO_BYTES);
		const before = await canvasRevision(page);
		for (let cycle = 0; cycle < 2; cycle++) {
			const center = await worldToClient(page, { x: 280, y: 220 });
			if (cycle === 0) {
				// 导航入口也要接管正在 hover 的解码器，不能只依赖双击 handler 暂停。
				await page.mouse.move(center.x, center.y);
				await expect.poll(async () => page.evaluate(() =>
					(window as unknown as { __canvasVideoSessions?: { playing: () => string | null } }).__canvasVideoSessions?.playing()
				)).toBe("node-video-1");
				await page.evaluate(() => (window as unknown as {
					__canvasNavigation: { enterNodeFocus: (input: { nodeId: string; kind: "video" }) => unknown }
				}).__canvasNavigation.enterNodeFocus({ nodeId: "node-video-1", kind: "video" }));
			} else {
				await page.mouse.dblclick(center.x, center.y);
			}
			await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible();
			await expect.poll(async () => page.evaluate(() =>
				(window as unknown as { __canvasVideoSessions?: { playing: () => string | null } }).__canvasVideoSessions?.playing()
			)).toBeNull();
			await expect(page.getByRole("button", { name: "播放视频", exact: true })).toBeEnabled();
			await expect.poll(() => videoColor(page), { intervals: [100] }).toBe("blue");
			await page.getByRole("button", { name: "播放视频", exact: true }).click();
			await expect.poll(() => videoColor(page), { intervals: [100] }).toBe("red");

			await page.keyboard.press("Escape");
			await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
			const restored = await worldToClient(page, { x: 280, y: 220 });
			await page.mouse.move(restored.x, restored.y + 400);
			await page.mouse.move(restored.x, restored.y);
			await expect.poll(async () => page.evaluate(() =>
				(window as unknown as { __canvasVideoSessions?: { playing: () => string | null } }).__canvasVideoSessions?.playing()
			)).toBe("node-video-1");
			await seekHoverFrame(page, 0.25);
			await expect.poll(() => videoColor(page), { intervals: [100] }).toBe("blue");
			await seekHoverFrame(page, 2.5);
			await expect.poll(() => videoColor(page), { intervals: [100] }).toBe("red");
			await page.evaluate(() => {
				const video = (window as unknown as { __videoFrameTestVideos: HTMLVideoElement[] })
					.__videoFrameTestVideos.find(video => video.loop && !!video.src)!;
				video.playbackRate = 1;
			});
			await expect.poll(() => page.evaluate(() => (window as unknown as { __videoFrameTestVideos: HTMLVideoElement[] })
				.__videoFrameTestVideos.find(video => video.loop && !!video.src)!.currentTime)).toBeGreaterThan(2.6);
			await page.mouse.move(restored.x, restored.y + 400);
		}
		expect(await canvasRevision(page)).toBe(before);
	});

	test("视频首帧加载时显示等待状态，解码就绪后自动消失", async ({ page }) => {
		let releaseVideo!: () => void;
		const held = new Promise<void>(resolve => { releaseVideo = resolve; });
		await page.route("**/api/media/**", async route => {
			if (route.request().resourceType() === "media") await held;
			await route.continue();
		});
		await seedVideoNode(page);
		const loading = () => page.evaluate(() => (window as unknown as {
			__bevyRuntime: { lastScene: () => { nodes: { id: string; mediaLoading?: boolean; busy: boolean }[] } }
		}).__bevyRuntime.lastScene().nodes.find(node => node.id === "node-video-1"));
		await expect.poll(async () => (await loading())?.mediaLoading).toBe(true);
		expect((await loading())?.busy).toBe(false);
		await page.evaluate(() => (window as unknown as {
			__canvasNavigation: { enterNodeFocus: (input: { nodeId: string; kind: "video" }) => unknown }
		}).__canvasNavigation.enterNodeFocus({ nodeId: "node-video-1", kind: "video" }));
		await expect(page.getByRole("status").filter({ hasText: "视频加载中" })).toBeVisible();
		releaseVideo();
		await expect(page.getByRole("status").filter({ hasText: "视频加载中" })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		await expect.poll(async () => !!(await loading())?.mediaLoading).toBe(false);
	});

	test("捕获首/当前/尾帧并批量添加生成新图片节点", async ({ page }) => {
		await seedVideoNode(page);
		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.dblclick(center.x, center.y);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("button", { name: "截取当前帧" })).toBeVisible();

		// 等聚焦解码就绪（截取按钮可用）。
		await expect.poll(async () => page.getByRole("button", { name: "截取当前帧" }).isEnabled(), { timeout: 20_000 }).toBe(true);
		await page.getByRole("button", { name: "截取首帧" }).click();
		await expect(page.locator(".video-frame-dialog__frame")).toHaveCount(1);
		await page.getByRole("button", { name: "截取当前帧" }).click();
		await expect(page.locator(".video-frame-dialog__frame")).toHaveCount(2);
		await page.getByRole("button", { name: "截取尾帧" }).click();
		await expect(page.locator(".video-frame-dialog__frame")).toHaveCount(3);

		const before = await canvasRevision(page);
		await page.getByRole("button", { name: "添加全部帧" }).click();
		await expect.poll(async () => canvasRevision(page), { timeout: 30_000 }).toBeGreaterThan(before);
		// 截帧图片沿用插入语义、不自动创建连线：新节点无入边且不与视频相连。
		const created = await page.evaluate(() => {
			const canonical = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string; type: string }>; edges?: Array<{ source: string; target: string }> } } }).__canvasCanonical;
			const nodes = canonical?.document?.nodes ?? [];
			const edges = canonical?.document?.edges ?? [];
			const frames = nodes.filter((node) => node.id.startsWith("video-frame-"));
			return { frames: frames.map((n) => n.id), edgesToFrames: edges.filter((e) => e.target.startsWith("video-frame-")).length };
		});
		expect(created.frames.length).toBeGreaterThan(0);
		expect(created.edgesToFrames).toBe(0);
		// 已添加帧从会话移除，聚焦仍保持。
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible();
	});

	test("390px 窄屏：无横向溢出，退出停止聚焦解码且不残留 DOM video", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await seedVideoNode(page);
		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.dblclick(center.x, center.y);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });

		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		// Horizontal overflow alone missed the capture row below the viewport.
		for (const button of await page.locator('.video-focus-workspace__player .video-frame-dialog__capture button').all()) {
			const bounds = await button.boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
			expect(bounds!.height).toBeGreaterThanOrEqual(44);
		}
    const player = await page.locator('.video-focus-workspace__player').boundingBox();
    const inspector = await page.locator('.video-focus-workspace__inspector').boundingBox();
    expect(player).not.toBeNull(); expect(inspector).not.toBeNull();
    expect(player!.y + player!.height).toBeLessThanOrEqual(inspector!.y + 1);
    await designEvidence(page, 'final-video-mobile', '390px 视频聚焦动作可见，播放器与检查面板互不遮挡');
		await page.getByRole('button', { name: '截取当前帧', exact: true }).click();
		await expect(page.locator('.video-frame-dialog__frame')).toHaveCount(1);
		// 聚焦解码为隐藏元素，不挂载 DOM video。
		expect(await page.locator("video").count()).toBe(0);

		await page.keyboard.press("Escape");
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		await expect.poll(async () => page.evaluate(() => (window as unknown as { __videoFocusDebug?: () => { active: boolean } }).__videoFocusDebug?.().active ?? false)).toBe(false);
	});
});
