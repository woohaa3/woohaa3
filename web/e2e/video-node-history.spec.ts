/**
 * 视频节点历史中央预览浏览器验收
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 4.x / 5.5）。
 *
 * 真实 Bevy WASM + 真实三服务 + 确定性视频 fixture：
 * - 打开聚焦节点历史，选择旧版本 → 同一聚焦工作区只读播放该条目（history owner）；
 * - 快速切换两个历史条目 → 最终显示最新选择（迟到丢弃）；
 * - 点「当前版本」恢复 direct 现场；
 * - 「设为当前」→ 权威 canonical 回流，条目变为当前、历史面板保留；
 * - 当前无输出时回落到通用只读历史面板（不伪造当前输出）；
 * - 实时前后序连接与素材预览（共享 rail）。
 *
 * 历史版本由测试专用端点 `/__e2e_seed_node_history__` 直接经服务端 `registerTaskResult`
 * 登记（生产由 task projector / 编辑完成 outbox 触发），与生产走同一登记服务。
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
	waitForBevyReady,
	waitForCanvasSession
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_FIXTURE = resolve(here, "fixtures/video-live-preview-fixture.webm");
const HISTORY_FIXTURE = resolve(here, "fixtures/video-edit-fixture.webm");
const VIDEO_BYTES = readFileSync(VIDEO_FIXTURE);
const HISTORY_BYTES = readFileSync(HISTORY_FIXTURE);
const POSTER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64"
);

async function uploadBytes(page: Page, bytes: Buffer, contentType: string) {
	const result = await uploadMedia(page, [...bytes], contentType);
	expect(result.status, `上传失败：${JSON.stringify(result.body)}`).toBe(201);
	return { storageKey: String(result.body.storageKey), url: String(result.body.url) };
}

async function seedHistory(
	page: Page,
	input: { canvasId: string; nodeId: string; storageKey: string; posterStorageKey: string; runId: string; durationSeconds: number; size: number; posterSize: number }
): Promise<{ entryId: string }> {
	const response = await page.request.post("/__e2e_seed_node_history__", {
		data: {
			canvasId: input.canvasId,
			nodeId: input.nodeId,
			kind: "video",
			storageKey: input.storageKey,
			posterStorageKey: input.posterStorageKey,
			runId: input.runId,
			durationSeconds: input.durationSeconds,
			contentType: "video/webm",
			size: input.size,
			posterSize: input.posterSize
		}
	});
	expect(response.ok(), `登记历史失败：${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as { entryId: string };
}

/**
 * 建一个视频节点（真实前序 text 节点 + 连线），绑定 ready 当前视频输出（含 poster），
 * 登记两条历史视频版本（不同 storageKey）。
 */
async function seedVideoWithHistory(page: Page): Promise<{ currentKey: string; historyKeys: string[] }> {
	const current = await uploadBytes(page, VIDEO_BYTES, "video/webm");
	const historyA = await uploadBytes(page, HISTORY_BYTES, "video/webm");
	const historyB = await uploadBytes(page, HISTORY_BYTES, "video/webm");
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
				edges: [{ id: "in-video", source: "before-video", target: "node-video-1", data: {} }],
				updatedAt: now
			},
			nodeData: {
				"before-video": { title: "输入参考", text: "前序节点" },
				"node-video-1": { outputAssetId: "asset-video-current", resourceKind: "video", taskStatus: "successed" }
			},
			assets: [
				{
					id: "asset-video-current",
					title: "当前输出",
					mediaKind: "video",
					source: "generated",
					status: "ready",
					url: current.url,
					posterUrl: poster.url,
					createdAt: now,
					metadata: { storageKey: current.storageKey, checksum: current.storageKey.replace("sha256-", ""), contentType: "video/webm", size: VIDEO_BYTES.length }
				}
			],
			jobs: [],
			updatedAt: now
		}
	});
	await page.goto("/");
	await waitForCanvasSession(page);
	// 第一条历史（左红右蓝 fixture）；第二条历史（同源字节，不同 runId/storageKey）。
	await seedHistory(page, { canvasId: CANVAS, nodeId: "node-video-1", storageKey: historyA.storageKey, posterStorageKey: poster.storageKey, runId: "e2e-history-a", durationSeconds: 2, size: HISTORY_BYTES.length, posterSize: POSTER_PNG.length });
	await seedHistory(page, { canvasId: CANVAS, nodeId: "node-video-1", storageKey: historyB.storageKey, posterStorageKey: poster.storageKey, runId: "e2e-history-b", durationSeconds: 2, size: HISTORY_BYTES.length, posterSize: POSTER_PNG.length });
	return { currentKey: current.storageKey, historyKeys: [historyA.storageKey, historyB.storageKey] };
}

async function openHistory(page: Page, nodeId = "node-video-1"): Promise<void> {
	await page.evaluate((id) => {
		(window as unknown as { __openNodeHistory?: (nodeId: string) => void }).__openNodeHistory?.(id);
	}, nodeId);
}

async function historyItems(page: Page) {
	return page.evaluate(() => {
		const state = (window as unknown as {
			__nodeHistoryState?: () => { items?: Array<{ entryId: string; current: boolean }> } | null;
		}).__nodeHistoryState?.();
		return state?.items ?? [];
	});
}

async function videoHistoryUrl(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const state = (window as unknown as { __videoFocusDebug?: () => { state?: { historyUrl?: string | null } } }).__videoFocusDebug?.();
		return state?.state?.historyUrl ?? null;
	});
}

/** 扫描 `#bevy-canvas` 高饱和前景像素（历史来源切换必须改变中央画面）。 */
async function scanVideoForeground(page: Page) {
	const buffer = await page.locator("#bevy-canvas").screenshot();
	const base64 = buffer.toString("base64");
	return page.evaluate(async (data) => {
		const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
		ctx.drawImage(bitmap, 0, 0);
		const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let count = 0, sr = 0, sg = 0, sb = 0;
		for (let y = 0; y < bitmap.height; y += 2) {
			for (let x = 0; x < bitmap.width; x += 2) {
				const i = (y * bitmap.width + x) * 4;
				const r = px[i], g = px[i + 1], b = px[i + 2];
				const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
				if (mx - mn > 60 && mx > 80) { count += 1; sr += r; sg += g; sb += b; }
			}
		}
		return { count, avg: count ? { r: sr / count, g: sg / count, b: sb / count } : null };
	}, base64);
}

test.describe("视频节点历史中央预览（change: 2026-10-10-add-video-node-focus-workspace）", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForBevyReady(page);
	});

	test("选择旧版本 → 只读历史 owner；返回当前版本恢复 direct", async ({ page }) => {
		await seedVideoWithHistory(page);
		await openHistory(page);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });

		const items = await historyItems(page);
		expect(items.length).toBe(2);
		expect(items.every((item) => item.current === false)).toBe(true);

		// 当前 direct 画面（蓝主导）。
		await expect.poll(async () => (await scanVideoForeground(page)).count, { timeout: 20_000 }).toBeGreaterThan(500);
		const directScan = await scanVideoForeground(page);

		// 选择第一条历史 → history owner + 只读标识。
		const first = items[0]!.entryId;
		await page.locator(`[data-entry-id="${first}"] .node-history__select`).click();
		await expect(page.locator('.app[data-focus-owner="history"]')).toBeVisible({ timeout: 10_000 });
		// 历史 owner 时共享顶部标识为「历史预览 · 只读」。
		await expect(page.locator(".focus-workspace__version")).toContainText("历史预览");
		// 历史 override 指向受控同源媒体路径。
		await expect.poll(() => videoHistoryUrl(page), { timeout: 15_000 }).toContain(`/api/canvas-node-history/${CANVAS}/node-video-1/`);
		// 中央 Bevy 画面确实切换到历史来源（像素变化，非仅 override URL）。
		await expect.poll(async () => {
			const scan = await scanVideoForeground(page);
			return scan.avg ? Math.abs(scan.avg.b - (directScan.avg?.b ?? 0)) : 0;
		}, { timeout: 15_000 }).toBeGreaterThan(5);

		// 回到当前版本 → 清除 override、恢复 direct。
		await page.locator(".node-history__list--current .node-history__select").click();
		await expect(page.locator('.app[data-focus-owner="direct"]')).toBeVisible({ timeout: 10_000 });
		await expect.poll(() => videoHistoryUrl(page), { timeout: 10_000 }).toBeNull();
		// 历史面板保留（同节点 owner 切换不清 panel）。
		await expect(page.locator(".node-history--drawer")).toHaveCount(1);
		// 清除 override 后中央画面回到当前 direct 来源（再次上传）。
		await expect.poll(async () => (await scanVideoForeground(page)).count, { timeout: 15_000 }).toBeGreaterThan(500);
	});

	test("快速切换两个历史条目 → 最终显示最新选择", async ({ page }) => {		await seedVideoWithHistory(page);
		await openHistory(page);
		await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });
		const items = await historyItems(page);
		const [a, b] = items.map((item) => item.entryId) as [string, string];

		await page.locator(`[data-entry-id="${a}"] .node-history__select`).click();
		await page.locator(`[data-entry-id="${b}"] .node-history__select`).click();
		await expect.poll(async () => page.evaluate(() => {
			const state = (window as unknown as { __nodeHistoryState?: () => { selectedEntryId?: string | null } | null }).__nodeHistoryState?.();
			return state?.selectedEntryId ?? null;
		}), { timeout: 10_000 }).toBe(b);
		await expect.poll(() => videoHistoryUrl(page), { timeout: 15_000 }).toContain(b);
		await expect(page.locator('.app[data-focus-owner="history"]')).toBeVisible();
	});

	test("设为当前 → canonical 回流、条目变为当前且历史面板保留", async ({ page }) => {
		const { historyKeys } = await seedVideoWithHistory(page);
		await openHistory(page);
		await expect(page.locator(".node-history--drawer")).toHaveCount(1, { timeout: 15_000 });
		const target = (await historyItems(page))[0]!.entryId;

		await page.locator(`[data-entry-id="${target}"] .node-history__apply`).click();
		// 等待权威 canonical 回流：节点当前输出 storageKey 变为该历史版本。
		await expect.poll(async () => page.evaluate(() => {
			const canonical = (window as unknown as {
				__canvasCanonical?: { nodeData?: Record<string, { outputAssetId?: string }>; assets?: Array<{ id: string; metadata?: { storageKey?: string } }> };
			}).__canvasCanonical;
			const outputId = canonical?.nodeData?.["node-video-1"]?.outputAssetId;
			const asset = canonical?.assets?.find((candidate) => candidate.id === outputId);
			return asset?.metadata?.storageKey ?? null;
		}), { timeout: 30_000 }).toBe(historyKeys[0]);

		// 该条目现在标记为当前；历史面板保留；owner 回到 direct。
		await expect(page.locator(`[data-entry-id="${target}"]`)).toHaveAttribute("data-current", "true", { timeout: 15_000 });
		await expect(page.locator(".node-history--drawer")).toHaveCount(1);
		await expect(page.locator('.app[data-focus-owner="direct"]')).toBeVisible({ timeout: 10_000 });
	});

	test("当前无输出时打开历史 → 通用只读面板回落（不伪造当前输出）", async ({ page }) => {
		// 视频节点无 outputAssetId：聚焦目标不可用，历史入口回落到通用面板。
		await seedYjsCanvas(page, CANVAS, [], {
			canvas: {
				id: CANVAS,
				title: "E2E 画布",
				revision: 1,
				document: {
					schemaVersion: "asset-canvas-v1",
					nodes: [{ id: "node-video-empty", type: "video", position: { x: 120, y: 120 }, width: 320, height: 200 }],
					edges: [],
					updatedAt: new Date().toISOString()
				},
				nodeData: { "node-video-empty": { title: "空视频节点" } },
				assets: [],
				jobs: [],
				updatedAt: new Date().toISOString()
			}
		});
		await page.goto("/");
		await waitForCanvasSession(page);
		await openHistory(page, "node-video-empty");

		// 不进入视频聚焦；通用只读历史面板可见，且明确「当前暂无输出」。
		await expect(page.locator("[data-node-history-panel]")).toHaveCount(1, { timeout: 15_000 });
		await expect(page.locator('.app[data-focus-kind="video"]')).toHaveCount(0);
		await expect(page.locator(".node-history__card--current")).toContainText("当前暂无输出");
	});

	test("聚焦历史时共享 rail 展示真实前序连接与素材预览", async ({ page }) => {
		await seedVideoWithHistory(page);
		await openHistory(page);
		await expect(page.locator('.app[data-focus-kind="video"]')).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-focus-connections="incoming"] .focus-connections__dot')).toHaveCount(1);
		// 历史条目渲染视频预览占位（poster href 受控）。
		await expect(page.locator(".node-history--drawer .node-history__thumb[data-preview-kind='video']").first()).toBeVisible({ timeout: 10_000 });
	});
});
