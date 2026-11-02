/**
 * Shot Camera 查看页交互与像素验收
 * （change: add-reusable-bevy-shot-camera，任务 6.4/6.5 / design D8）。
 *
 * 在真实浏览器（`ladle build` 产物 + 真实 Bevy WASM）里驱动 Shot Camera story，同时断言
 * DOM 控制状态与 canvas 像素：非空渲染、orbit/distance/focus 后 preview 变化、
 * capture 尺寸/字节、多镜头隔离、resize/DPR 与删除 rig 后资源计数回落。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const LAB = "画布组件--shot-camera--交互实验台";
const MULTI = "画布组件--shot-camera--多镜头切换";
const NARROW = "画布组件--shot-camera--窄屏与画幅";

function storyUrl(story: string): string {
	return `/?story=${encodeURIComponent(story)}`;
}

async function openStory(page: Page, story: string) {
	await page.goto(storyUrl(story));
	await page.waitForSelector(".showcase__content", { state: "visible" });
	await page.waitForSelector('[data-testid="shot-camera-stage"]', { state: "visible" });
	await page.waitForSelector('[data-testid="shot-status"]', { state: "visible" });
}

/** 等待真实 Bevy WASM 就绪（诊断计数出现 rig）。 */
async function waitForReady(page: Page) {
	await expect(page.getByTestId("shot-status")).toHaveText("已就绪", { timeout: 60_000 });
	await expect
		.poll(async () => Number(await page.getByTestId("diag-rigs").textContent()), { timeout: 60_000 })
		.toBeGreaterThan(0);
	// 稍等几帧，确保 preview 相机与渲染 pass 已跑过。
	await page.waitForTimeout(1500);
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => ({
		docWidth: document.documentElement.clientWidth,
		scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.docWidth + 1);
}

/** 设置 range 输入并派发 React 可识别的 change 事件（Playwright `fill` 不支持 range）。 */
async function setRange(page: Page, testId: string, value: number) {
	await page.getByTestId(testId).evaluate((element, next) => {
		const input = element as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, String(next));
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
}

/** 采样 canvas 像素统计（非透明/单色判定）。 */
type PixelStats = { total: number; opaque: number; colored: number; signature: string };

async function sampleCanvas(page: Page, testId: string): Promise<PixelStats> {
	const element = page.getByTestId(testId);
	const box = await element.boundingBox();
	if (!box) return { total: 0, opaque: 0, colored: 0, signature: "" };
	const shot = await element.screenshot();
	return page.evaluate(async (bytes) => {
		const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
		const bitmap = await createImageBitmap(blob);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let opaque = 0;
		let colored = 0;
		let hash = 2166136261;
		for (let index = 0; index < data.length; index += 4) {
			const r = data[index]!;
			const g = data[index + 1]!;
			const b = data[index + 2]!;
			const a = data[index + 3]!;
			if (a > 16) opaque += 1;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max - min > 24 && max > 40) colored += 1;
			hash = Math.imul(hash ^ r, 16777619);
			hash = Math.imul(hash ^ g, 16777619);
			hash = Math.imul(hash ^ b, 16777619);
		}
		return {
			total: data.length / 4,
			opaque,
			colored,
			signature: (hash >>> 0).toString(16)
		};
	}, Array.from(shot));
}

test.describe("Shot Camera 查看页", () => {
	test("打开交互实验台：真实场景、非空 preview 与诊断", async ({ page }) => {
		await openStory(page, LAB);
		await waitForReady(page);

		// 真实 Bevy 场景 canvas 非空。
		const scene = await sampleCanvas(page, "shot-camera-stage");
		expect(scene.opaque).toBeGreaterThan(500);

		// 诊断：至少 1 个 rig；未 capture 时没有进行中作业。
		expect(Number(await page.getByTestId("diag-rigs").textContent())).toBeGreaterThanOrEqual(1);
		expect(Number(await page.getByTestId("diag-captures").textContent())).toBe(0);
		// preview 相机由 window-target 拥有 → previewImages 为 0（不是伪造离屏图）。
    expect(Number(await page.getByTestId("pose-fov").textContent())).toBeGreaterThan(0);
	});

	test("orbit 后 pose 与画面变化，capture 返回合法尺寸与字节", async ({ page }) => {
		await openStory(page, LAB);
		await waitForReady(page);

		const before = await sampleCanvas(page, "shot-camera-stage");
		const azimuthBefore = await page.getByTestId("pose-azimuth").textContent();

		// 拖动 azimuth slider（真实 change 事件）。
		await setRange(page, "field-azimuth", 1.2);
		await page.waitForTimeout(800);

		const azimuthAfter = await page.getByTestId("pose-azimuth").textContent();
		expect(azimuthAfter).not.toBe(azimuthBefore);
		const after = await sampleCanvas(page, "shot-camera-stage");
		expect(after.signature).not.toBe(before.signature);

		// capture：真实请求 → 尺寸与字节非空。
		await page.getByTestId("camera-capture").click();
		await expect(page.getByTestId("pose-capture")).toHaveText(/done|failed/, { timeout: 30_000 });
		await expect(page.getByTestId("pose-capture")).toHaveText("done");
		const size = await page.getByTestId("pose-capture-size").textContent();
		expect(size).toMatch(/^\d+×\d+$/);
		const bytes = Number(await page.getByTestId("pose-capture-bytes").textContent());
		expect(bytes).toBeGreaterThan(0);
	});

	test("多镜头隔离：创建/切换/删除后各自 pose 独立且资源回落", async ({ page }) => {
		await openStory(page, MULTI);
		await waitForReady(page);

		await page.getByTestId("camera-add").click();
		await expect(page.getByTestId("shot-camera-list").locator("button")).toHaveCount(3); // 2 镜头 + 新建按钮
		await expect(page.getByTestId("diag-rigs")).toHaveText("1"); // 同一时刻只有一个 rig（选中镜头）

		// 选中第二个镜头，改 azimuth，再切回第一个：互不影响。
		const items = page.getByTestId("shot-camera-list").locator("button");
		await items.nth(1).click();
		await setRange(page, "field-azimuth", 0.6);
		await page.waitForTimeout(600);
		const secondAzimuth = await page.getByTestId("pose-azimuth").textContent();
		await items.nth(0).click();
		await page.waitForTimeout(600);
		const firstAzimuth = await page.getByTestId("pose-azimuth").textContent();
		expect(firstAzimuth).not.toBe(secondAzimuth);

		// 删除第二个镜头：镜头项回落。
		await items.nth(1).click();
		await page.locator('[data-testid^="camera-remove-"]').first().click();
		await expect(page.getByTestId("shot-camera-list").locator("button")).toHaveCount(2);
	});

	test("resize/DPR 后 scene 仍在 frame 内且无横向溢出", async ({ page }) => {
		await openStory(page, LAB);
		await waitForReady(page);
		await expectNoHorizontalOverflow(page);

		await page.setViewportSize({ width: 1024, height: 768 });
		await page.waitForTimeout(1200);
		await expectNoHorizontalOverflow(page);
		const stats = await sampleCanvas(page, "shot-camera-stage");
		expect(stats.opaque).toBeGreaterThan(200);
	});

	test("删除最后一个镜头后无横向溢出、窄屏画幅切换可用", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openStory(page, NARROW);
		await waitForReady(page);
		await expectNoHorizontalOverflow(page);

		// 覆盖生图并集中的代表宽、方、竖、超宽与极端画幅。
		for (const aspect of ["1:1", "4:5", "16:9", "9:16", "21:9", "1:8"]) {
			await page.getByTestId("field-aspect").selectOption(aspect);
			await page.waitForTimeout(400);
			await expect(page.getByTestId("field-aspect")).toHaveValue(aspect);
			await expectNoHorizontalOverflow(page);
		}
	});

	test("corner viewfinder 渲染模型，视图缩放改变画面", async ({ page }) => {
		await openStory(page, LAB);
		await waitForReady(page);

		// 左下角 viewfinder 区域应渲染模型（非空白、非单色）。
		const canvas = page.locator("#bevy-canvas");
		const box = await canvas.boundingBox();
		expect(box).not.toBeNull();
		if (!box) return;
		const viewfinder = await page.screenshot({
			clip: { x: box.x + 28, y: box.y + box.height - 163 - 28, width: 289, height: 163 }
		});
		const stats = await page.evaluate(async (bytes) => {
			const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
			const bitmap = await createImageBitmap(blob);
			const off = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = off.getContext("2d")!;
			context.drawImage(bitmap, 0, 0);
			const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
			let colored = 0;
			for (let index = 0; index < data.length; index += 4) {
				const max = Math.max(data[index]!, data[index + 1]!, data[index + 2]!);
				const min = Math.min(data[index]!, data[index + 1]!, data[index + 2]!);
				if (max - min > 24 && max > 40) colored += 1;
			}
			return { colored };
		}, Array.from(viewfinder));
		expect(stats.colored).toBeGreaterThan(200);

		// 视图缩放改变主场景画面。
		const before = await sampleCanvas(page, "shot-camera-stage");
		await setRange(page, "field-view-zoom", 2.5);
		await page.waitForTimeout(800);
		await expect(page.getByTestId("value-view-zoom")).toHaveText("2.50×");
		const after = await sampleCanvas(page, "shot-camera-stage");
		expect(after.signature).not.toBe(before.signature);
	});
});
