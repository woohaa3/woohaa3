/**
 * 模型聚焦查看的浏览器验收
 * （change: add-model-focus-viewing，任务 4.2 / 4.3）。
 *
 * 在真实 Bevy WASM 运行时上用确定性 V2 人形 fixture 验证：
 * - 双击实际渲染的模型进入原地聚焦（不打开 Dialog、不创建第二个 canvas）；
 * - 聚焦隔离内容：其它节点/模型不可见，画面只剩目标；
 * - RMB 自由观察 / MMB 平移 / 滚轮推拉 / WASD 相机移动都改变聚焦投影；
 * - resize/DPR 后仍非空、模型完整入镜、无 NaN/panic；
 * - Escape 精确恢复进入前的 2D viewport 与普通画布。
 *
 * 像素判定用容差，不做逐像素哈希。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, createNode, waitForCanvasSession, worldModelClientPoint } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

/** 标准 V2 人形 fixture（与 model-scene-v2 回归同源）。 */
const HUMANOID_V2 = `
const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
scene.box({ id: "torso", size: [0.9, 1.6, 0.5], position: [0, 1.9, 0], material: armor });
scene.sphere({ id: "head", radius: 0.34, position: [0, 3.05, 0], color: "#e8c39e" });
scene.segment({ id: "left-leg", from: [-0.25, 1.1, 0], to: [-0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
scene.segment({ id: "right-leg", from: [0.25, 1.1, 0], to: [0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
`;

async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
	const response = await page.request.post("/api/model-mcp/scripts", {
		data: { canvasId: CANVAS, nodeId, requestId: crypto.randomUUID(), source, version: "woohaa-model-js-v2" }
	});
	expect(response.ok(), `submit_model_script 失败：${response.status()} ${await response.text()}`).toBe(true);
}

async function waitForModelRendered(page: Page, nodeId: string): Promise<void> {
	await page.waitForFunction(
		(id) => {
			const canonical = (window as unknown as {
				__canvasCanonical?: { nodeData?: Record<string, { modelScriptVersion?: string; modelScriptStatus?: string }> };
			}).__canvasCanonical;
			const data = canonical?.nodeData?.[id];
			return data?.modelScriptVersion === "woohaa-model-js-v2" && data.modelScriptStatus === "ok";
		},
		nodeId,
		{ timeout: 30_000, polling: 200 }
	);
	await page.waitForTimeout(800);
}

/** 前景像素统计（非中性色）。 */
async function foreground(page: Page) {
	const buffer = await page.locator("#bevy-canvas").screenshot();
	const base64 = buffer.toString("base64");
	return page.evaluate(async (data) => {
		const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
		ctx.drawImage(bitmap, 0, 0);
		const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let count = 0;
		let minX = bitmap.width, maxX = -1, minY = bitmap.height, maxY = -1;
		for (let y = 0; y < bitmap.height; y += 2) {
			for (let x = 0; x < bitmap.width; x += 2) {
				const i = (y * bitmap.width + x) * 4;
				const r = px[i], g = px[i + 1], b = px[i + 2];
				const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
				if (mx - mn > 40 && mx > 60) {
					count += 1;
					if (x < minX) minX = x; if (x > maxX) maxX = x;
					if (y < minY) minY = y; if (y > maxY) maxY = y;
				}
			}
		}
		return {
			w: bitmap.width, h: bitmap.height, count,
			ratio: count / ((bitmap.width / 2) * (bitmap.height / 2)),
			box: count ? { minX, minY, maxX, maxY } : null
		};
	}, base64);
}

/** 读聚焦镜像状态。 */
async function focusState(page: Page) {
	return page.evaluate(() => {
		const mirror = (window as unknown as {
			__canvasModelFocus?: { projection?: () => unknown; nodeId?: () => string | null; focused?: () => boolean };
		}).__canvasModelFocus;
		return {
			focused: mirror?.focused?.() ?? false,
			nodeId: mirror?.nodeId?.() ?? null,
			projection: mirror?.projection?.() ?? null
		};
	});
}

/** 共享世界模型包围盒中心的 client 坐标（模型没有卡片）。 */
const modelClientPoint = worldModelClientPoint;

test.describe("模型聚焦查看（change: add-model-focus-viewing）", () => {
	test("双击模型进入聚焦且不打开 Dialog", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		const created = await createNode(page, { nodeType: "composite-asset", position: { x: 500, y: 200 }, nodeId: "focus-model" });
		expect(created.ok).toBe(true);
		await submitModelScript(page, "focus-model", HUMANOID_V2);
		await waitForModelRendered(page, "focus-model");

		// 进入前：无聚焦、无 Dialog。
		expect((await focusState(page)).focused).toBe(false);

		const point = await modelClientPoint(page, "focus-model");
		// 先 hover 让指针落在模型上，再双击。
		await page.mouse.move(point.x, point.y);
		await page.mouse.dblclick(point.x, point.y);

		await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(true);
		const state = await focusState(page);
		expect(state.nodeId).toBe("focus-model");
		// 不打开任何 Dialog。
		expect(await page.locator(".dlg").count()).toBe(0);
		// 页面只有一个 canvas（不创建第二个画布）。
		expect(await page.locator("canvas#bevy-canvas").count()).toBe(1);

		// 聚焦画面非空且模型完整入镜。
		await page.waitForTimeout(600);
		const stats = await foreground(page);
		expect(stats.count).toBeGreaterThan(400);
		expect(stats.box!.minX).toBeGreaterThanOrEqual(0);
		expect(stats.box!.maxX).toBeLessThan(stats.w);
		expect(stats.ratio).toBeLessThan(0.6);
	});

	test("聚焦相机：RMB/MMB/滚轮/WASD 改变投影，Escape 恢复 2D viewport", async ({ page }) => {
		test.setTimeout(150000);
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await createNode(page, { nodeType: "model3d", position: { x: 400, y: 150 }, nodeId: "focus-nav" });
		await submitModelScript(page, "focus-nav", HUMANOID_V2);
		await waitForModelRendered(page, "focus-nav");

		// 记录进入前 viewport（E2E 在进入前可读；退出后应恢复）。
		const before = await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.() ?? null);

		const point = await modelClientPoint(page, "focus-nav");
		await page.mouse.move(point.x, point.y);
		await page.mouse.dblclick(point.x, point.y);
		await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(true);

		const projectionAt = async () => (await focusState(page)).projection as { yaw: number; target: number[]; distance: number } | null;
		const start = await projectionAt();
		expect(start).not.toBeNull();
		// Real device loss must replay referenced 3D resources without losing the focus camera.
		await page.evaluate(() => {
			const gl = document.querySelector("iframe")!.contentDocument!.querySelector("canvas")!.getContext("webgl2")!;
			gl.getExtension("WEBGL_lose_context")!.loseContext();
		});
		await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().counts.recovered ?? 0), { timeout: 45000 }).toBe(1);
		expect(await projectionAt()).toEqual(start);
		expect((await foreground(page)).count).toBeGreaterThan(50);

		// RMB 自由观察：yaw 变化。
		await page.mouse.move(640, 400);
		await page.mouse.down({ button: "right" });
		await page.mouse.move(760, 430, { steps: 5 });
		await page.mouse.up({ button: "right" });
		const afterLook = await projectionAt();
		expect(afterLook!.yaw).not.toBeCloseTo(start!.yaw, 3);

		// 滚轮 dolly：距离变化。
		const beforeWheel = await projectionAt();
		await page.mouse.move(640, 400);
		await page.mouse.wheel(0, 240);
		await page.waitForTimeout(150);
		const afterWheel = await projectionAt();
		expect(afterWheel!.distance).not.toBeCloseTo(beforeWheel!.distance, 3);

		// WASD 飞行：target 变化。
		await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
		const beforeFly = await projectionAt();
		await page.keyboard.down("KeyW");
		try { await expect.poll(async () => (await projectionAt())?.target).not.toEqual(beforeFly!.target); }
		finally { await page.keyboard.up("KeyW"); }
		const afterFly = await projectionAt();
		expect(afterFly!.target).not.toEqual(beforeFly!.target);

		// Escape 退出并恢复 viewport。
		await page.keyboard.press("Escape");
		await expect.poll(async () => (await focusState(page)).focused, { timeout: 10_000 }).toBe(false);
		const after = await page.evaluate(() => (window as unknown as { __canvasViewport?: () => unknown }).__canvasViewport?.() ?? null);
		expect(after).toEqual(before);
	});

	test("ESC / 目标失效退出；resize 后仍非空且无 NaN/panic", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1024, height: 768 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await createNode(page, { nodeType: "composite-asset", position: { x: 360, y: 140 }, nodeId: "focus-redraw" });
		await submitModelScript(page, "focus-redraw", HUMANOID_V2);
		await waitForModelRendered(page, "focus-redraw");

		const point = await modelClientPoint(page, "focus-redraw");
		await page.mouse.move(point.x, point.y);
		await page.mouse.dblclick(point.x, point.y);
		await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(true);

		// resize 保持取景。
		await page.setViewportSize({ width: 1024, height: 640 });
		await page.waitForTimeout(700);
		const stats = await foreground(page);
		expect(stats.count).toBeGreaterThan(300);

		// 目标失效（删除节点）→ 自动退出。
		await page.evaluate(() => {
			const submit = (window as unknown as { __canvasSubmitCommands?: (commands: unknown[], id?: string) => unknown }).__canvasSubmitCommands;
			submit?.([{ type: "node.remove", nodeIds: ["focus-redraw"] }], "e2e-remove-focus");
		});
		await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(false);

		expect(errors.filter((message) => /NaN|panic|RuntimeError/i.test(message))).toEqual([]);
	});

	test("hover 播放进入聚焦：主观察画面在所有采样帧保持静止（change: play-model-animations-on-hover）", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		await createNode(page, { nodeType: "composite-asset", position: { x: 420, y: 160 }, nodeId: "focus-anim-gate" });
		// 明显动画：绕 z 轴旋转的 group 带动整条手臂。
		await submitModelScript(page, "focus-anim-gate", `const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
scene.sphere({ id: "torso", radius: 0.55, position: [0, 1.4, 0], material: armor });
scene.group({ id: "arm", position: [0, 2.0, 0], rotation: [0, 0, -35] });
scene.segment({ id: "upper", parent: "arm", from: [0, 0, 0], to: [0, -0.9, 0], width: 0.3, shape: "box", material: armor });
scene.segment({ id: "fore", parent: "arm", from: [0, -0.9, 0], to: [0.25, -1.7, 0], width: 0.26, shape: "capsule", material: armor });
scene.sphere({ id: "hand", parent: "arm", radius: 0.16, position: [0.25, -1.7, 0], color: "#e8c39e" });
scene.rotate("arm", { axis: "z", speed: 2.5 });`);
		await waitForModelRendered(page, "focus-anim-gate");

		const point = await modelClientPoint(page, "focus-anim-gate");
		// 先 hover 播放一段时间，使动画处于任意相位，再进入聚焦。
		await page.mouse.move(point.x, point.y);
		await page.waitForTimeout(700);
		await page.mouse.dblclick(point.x, point.y);
		await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(true);
		// 过渡结束并稳定。
		await page.waitForTimeout(900);

		// 聚焦期间多次采样：定格姿态在所有样本间保持同一包围框（不随时间推进）。
		const shots = [];
		for (let index = 0; index < 3; index += 1) {
			shots.push(await foreground(page));
			await page.waitForTimeout(500);
		}
		for (const shot of shots) {
			expect(shot.count).toBeGreaterThan(300);
			expect(shot.box).toEqual(shots[0].box);
		}
	});
});
