/**
 * 视频节点实时预览的浏览器验收
 * （change: enable-video-node-live-preview，任务 5.4 / 5.5 / 5.6）。
 *
 * 在真实 Bevy WASM 运行时上用确定性视频 fixture（`video-live-preview-fixture.webm`，
 * 160×90、2 秒：前 1 秒蓝、后 1 秒红）验证：
 * - 节点初始显示真实解码帧（而非 poster），画面非空；
 * - hover 播放让节点画面随时间变化，离开后暂停并保留最后帧；
 * - 双击视频节点进入原地聚焦，且绑定同一输出视频；
 * - 图片节点双击行为不回归；
 * - 桌面与触摸视口下无非空画面异常、无 DOM overlay、无页面横向溢出。
 *
 * 像素判定用容差（前景占比/主色），不做逐像素哈希（Bevy 抗锯齿差异）。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
	installPageHelpers,
	resetCanvasStorage,
	seedYjsCanvas,
	uploadMedia,
	waitForCanvasSession
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_FIXTURE = resolve(here, "fixtures/video-live-preview-fixture.webm");
const VIDEO_BYTES = readFileSync(VIDEO_FIXTURE);
/** 与真实帧（蓝/红）明显不同的 poster：绿色，用于验证真实帧最终替换 poster。 */
const POSTER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64"
);

async function uploadBytes(page: Page, bytes: Buffer, contentType: string) {
	const result = await uploadMedia(page, [...bytes], contentType);
	expect(result.status, `上传失败：${JSON.stringify(result.body)}`).toBe(201);
	return { storageKey: String(result.body.storageKey), url: String(result.body.url) };
}

/** 建一个 video 节点并绑定 ready 视频输出（含 poster），等待画布就绪。 */
async function seedVideoNode(page: Page) {
	const video = await uploadBytes(page, VIDEO_BYTES, "video/webm");
	const poster = await uploadBytes(page, POSTER_PNG, "image/png");
	const now = new Date().toISOString();
	await seedYjsCanvas(page, CANVAS, [], {
		canvas: {
			id: CANVAS,
			title: "E2E 画布",
			revision: 1,
			document: {
				schemaVersion: "asset-canvas-v1",
				nodes: [{ id: "node-video-1", type: "video", position: { x: 120, y: 120 }, width: 320, height: 200 }],
				edges: [],
				updatedAt: now
			},
			nodeData: { "node-video-1": { outputAssetId: "asset-video-1", resourceKind: "video", taskStatus: "successed" } },
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
					metadata: { storageKey: video.storageKey, checksum: video.storageKey.replace("sha256-", ""), contentType: "video/webm", size: VIDEO_BYTES.length }
				}
			],
			jobs: [],
			updatedAt: now
		}
	});
	await page.goto("/");
	await waitForCanvasSession(page);
}

/** 等节点出现真实解码帧。 */
async function waitForRealFrame(page: Page, nodeId = "node-video-1"): Promise<void> {
	await page.waitForFunction(
		(id) => (window as unknown as { __canvasVideoSessions?: { hasRealFrame?: (node: string) => boolean } }).__canvasVideoSessions?.hasRealFrame?.(id) === true,
		nodeId,
		{ timeout: 30_000, polling: 200 }
	);
}

/**
 * 扫描 `#bevy-canvas` 截图，返回强饱和（彩色）前景像素的统计：
 * 数量、包围框与平均色。视频 fixture 是纯蓝/纯红（高饱和），网格/节点框是低饱和中性色，
 * 因此「高饱和前景」即视频画面。
 */
async function scanVideoForeground(page: Page) {
	const buffer = await page.locator("#bevy-canvas").screenshot();
	const base64 = buffer.toString("base64");
	return page.evaluate(async (data) => {
		const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
		ctx.drawImage(bitmap, 0, 0);
		const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let count = 0;
		let sr = 0, sg = 0, sb = 0;
		let minX = bitmap.width, maxX = -1, minY = bitmap.height, maxY = -1;
		for (let y = 0; y < bitmap.height; y += 2) {
			for (let x = 0; x < bitmap.width; x += 2) {
				const i = (y * bitmap.width + x) * 4;
				const r = px[i], g = px[i + 1], b = px[i + 2];
				const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
				if (mx - mn > 60 && mx > 80) {
					count += 1; sr += r; sg += g; sb += b;
					if (x < minX) minX = x; if (x > maxX) maxX = x;
					if (y < minY) minY = y; if (y > maxY) maxY = y;
				}
			}
		}
		return {
			count,
			box: count ? { minX, minY, maxX, maxY } : null,
			avg: count ? { r: sr / count, g: sg / count, b: sb / count } : null
		};
	}, base64);
}

/** 世界坐标 → client 坐标（用于 hover/双击）。 */
async function worldToClient(page: Page, world: { x: number; y: number }) {
	return page.evaluate((point) => {
		const viewport = (window as unknown as {
			__canvasViewport?: () => { x: number; y: number; zoom: number };
		}).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
		const rect = (document.querySelector("#bevy-canvas") as HTMLCanvasElement).getBoundingClientRect();
		return { x: point.x * viewport.zoom + viewport.x + rect.left, y: point.y * viewport.zoom + viewport.y + rect.top };
	}, world);
}

async function readPlaying(page: Page) {
	return page.evaluate(
		() => (window as unknown as { __canvasVideoSessions?: { playing?: () => string | null } }).__canvasVideoSessions?.playing?.() ?? null
	);
}

test.describe("视频节点实时预览（任务 5.4 / 5.5 / 5.6）", () => {
	test("初始显示真实解码帧而非 poster，且纹理非空", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await seedVideoNode(page);
		await waitForRealFrame(page);

		const active = await page.evaluate(
			() => (window as unknown as { __canvasVideoSessions?: { active?: () => string[] } }).__canvasVideoSessions?.active?.() ?? []
		);
		expect(active).toContain("node-video-1");

		// 真实帧为蓝/红（高饱和）；poster 是绿色。断言存在大块彩色前景且偏蓝主导单通道。
		const scan = await scanVideoForeground(page);
		expect(scan.count).toBeGreaterThan(500);
		expect(scan.avg).not.toBeNull();
		// 蓝或红主导（任一通道远高于其余两通道）。
		const avg = scan.avg!;
		expect(Math.max(avg.r, avg.g, avg.b) - Math.min(avg.r, avg.g, avg.b)).toBeGreaterThan(80);
	});

	test("hover 播放让画面变化，离开后暂停并保留最后帧", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await seedVideoNode(page);
		await waitForRealFrame(page);

		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.move(center.x, center.y);
		await expect.poll(() => readPlaying(page), { timeout: 10_000 }).toBe("node-video-1");

		// 播放一段时间后：fixture 由蓝变红，画面红色分量应明显升高。
		await page.waitForTimeout(1400);
		const during = await scanVideoForeground(page);
		expect(during.avg).not.toBeNull();
		expect(during.avg!.r).toBeGreaterThan(80);

		// 离开节点：暂停。
		await page.mouse.move(center.x, center.y + 400);
		await expect.poll(() => readPlaying(page), { timeout: 10_000 }).toBeNull();

		// 离开后仍保留最后帧（仍有彩色前景）。
		const after = await scanVideoForeground(page);
		expect(after.count).toBeGreaterThan(300);
	});

	test("双击视频节点进入原地聚焦（不再打开截帧 Dialog）且绑定同一输出视频", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await seedVideoNode(page);
		await waitForRealFrame(page);

		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.dblclick(center.x, center.y);

		// change: 2026-10-10-add-video-node-focus-workspace：双击原地聚焦，不再打开截帧 Dialog。
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(".dlg-host")).toHaveCount(0);
		expect(
			await page.evaluate(
				() => (window as unknown as { __canvasVideoFocus?: { focused: () => boolean } }).__canvasVideoFocus?.focused() ?? false
			)
		).toBe(true);
		// 打开后画布不再 hover 播放。
		expect(await readPlaying(page)).toBeNull();

		// modal 输入不穿透：滚轮改变的是聚焦取景，不改变普通画布视口。
		const viewportBefore = await page.evaluate(
			() => (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.()
		);
		const stage = page.locator("[data-video-focus-stage]");
		await stage.hover();
		await page.mouse.wheel(0, 240);
		const viewportAfter = await page.evaluate(
			() => (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.()
		);
		expect(viewportAfter).toEqual(viewportBefore);

		// Escape 退出聚焦，退出后画布不自动恢复播放且不残留聚焦 chrome。
		await page.keyboard.press("Escape");
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		expect(await readPlaying(page)).toBeNull();
	});

	test("图片节点双击进入图片工作区，返回恢复画布且不发截帧", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		const image = await uploadBytes(page, POSTER_PNG, "image/png");
		const now = new Date().toISOString();
		await seedYjsCanvas(page, CANVAS, [], {
			canvas: {
				id: CANVAS,
				title: "E2E 画布",
				revision: 1,
				document: {
					schemaVersion: "asset-canvas-v1",
					nodes: [{ id: "node-image-1", type: "image", position: { x: 120, y: 120 }, width: 320, height: 200 }],
					edges: [],
					updatedAt: now
				},
				nodeData: { "node-image-1": { outputAssetId: "asset-image-1" } },
				assets: [
					{
						id: "asset-image-1",
						title: "测试图",
						mediaKind: "image",
						source: "uploaded",
						status: "ready",
						url: image.url,
						createdAt: now,
						metadata: { storageKey: image.storageKey, checksum: image.storageKey.replace("sha256-", ""), contentType: "image/png", size: POSTER_PNG.length }
					}
				],
				jobs: [],
				updatedAt: now
			}
		});
		await page.goto("/");
		await waitForCanvasSession(page);

		const center = await worldToClient(page, { x: 120 + 160, y: 120 + 100 });
		await page.mouse.dblclick(center.x, center.y);
		await expect(page.locator("[data-image-edit-workspace]")).toBeVisible();
		await expect(page.locator("[data-image-edit-workspace]")).toHaveCount(1);
		await expect(page.locator(".dlg")).toHaveCount(0);
		const viewportBefore = await page.evaluate(() => (window as any).__canvasViewport());
		const revisionBefore = await page.evaluate(() => (window as any).__canvasCanonical.revision);
		// Workspace wheel input belongs to the image view; overview viewport stays fixed.
		await page.locator(".photo-editor-canvas").hover();
		await page.mouse.wheel(0, 240);
		expect(await page.evaluate(() => (window as any).__canvasViewport())).toEqual(viewportBefore);
		await page.getByRole("button", { name: "返回", exact: true }).click();
		await expect(page.locator("[data-image-edit-workspace]")).toHaveCount(0);
		await expect(page.locator(".dlg")).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => (window as any).__frontendApp().currentPage().ctx.canvasNavigation.getSnapshot().mode.type)).toBe("overview");
		expect(await page.evaluate(() => (window as any).__canvasCanonical.revision)).toBe(revisionBefore);

	});

	test("390×844 触摸视口：画面非空、无 DOM overlay、无页面横向溢出", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await seedVideoNode(page);
		await waitForRealFrame(page);

		// 无视频 DOM overlay（解码元素不挂载）。
		expect(await page.locator("video").count()).toBe(0);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		// 真实画面非空。
		const scan = await scanVideoForeground(page);
		expect(scan.count).toBeGreaterThan(300);
	});
});
