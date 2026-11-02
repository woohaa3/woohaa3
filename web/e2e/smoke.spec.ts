/**
 * 启动链路冒烟（change: replace-godot-canvas-runtime-with-bevy，任务 8.2）。
 *
 * 验证：Bevy WASM 运行时就绪 → 画布会话就绪 → 浏览器命令出口已安装 →
 * 首次启动持久化了一个**空**规范画布 → 生产物不含 Godot/PCK。
 */
import { expect, test } from "./review-browser.js";
import { installPageHelpers, readStoredCanvas, resetCanvasStorage, waitForCanvasSession, waitForBevyReady } from "./helpers.js";

test.describe("启动链路", () => {
	test("页面加载 + Bevy ready + 画布会话就绪", async ({ page }) => {
		await installPageHelpers(page);
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		// frontend 只有 Yjs 一条路径：先建立服务端权威空画布，再进入应用。
		await resetCanvasStorage(page);

		await waitForBevyReady(page);
		await waitForCanvasSession(page);

		// 浏览器命令出口已安装（交互控制器完成手势后的提交点）。
		expect(
			await page.evaluate(() => typeof (window as never as { __canvasSubmitCommands?: unknown }).__canvasSubmitCommands)
		).toBe("function");
		// Bevy 运行时状态镜像可用。
		expect(
			await page.evaluate(() => typeof (window as never as { __bevyRuntime?: { isReady?: unknown } }).__bevyRuntime?.isReady)
		).toBe("function");

		// 首次启动创建并持久化了空画布。
		const canvas = await readStoredCanvas(page);
		expect(canvas?.document.schemaVersion).toBe("asset-canvas-v1");
		expect(canvas?.document.nodes).toEqual([]);
		expect(canvas?.document.edges).toEqual([]);
		expect(canvas?.assets).toEqual([]);
		expect(canvas?.revision).toBe(0);

		expect(pageErrors).toEqual([]);
	});

	test("静态资源缺失时返回 404 而不是 SPA shell（运行时不会拿到 HTML）", async ({ request }) => {
		const missing = await request.get("/bevy/does-not-exist.wasm");
		expect(missing.status()).toBe(404);
	});

	test("生产入口不再引用 Godot/PCK 资源", async ({ request }) => {
		const engine = await request.get("/game/index.js");
		expect(engine.status()).toBe(404);
		const pck = await request.get("/game/index.pck");
		expect(pck.status()).toBe(404);
	});
});
