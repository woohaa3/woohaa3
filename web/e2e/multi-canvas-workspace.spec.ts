/**
 * 多画布工作区 E2E
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 5.1）。
 *
 * 覆盖：空库启动只创建一个默认画布并写回 URL、创建多画布、切换后编辑隔离、刷新/URL 分享、
 * back/forward、重命名经 published projection 持久化。
 */
import { expect, test } from "./review-browser.js";
import {
	installPageHelpers,
	readStoredCanvas,
	resetAllCanvases,
	sendCommands,
	waitForCanvasSession,
	waitForCommandsSettled,
	waitForPersistedRevision
} from "./helpers.js";

test.describe("多画布工作区", () => {
	test("空库启动只创建一个默认画布并写入 URL；可创建并切换，back/forward 恢复", async ({ page }) => {
		await installPageHelpers(page);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

		await resetAllCanvases(page);
		// 无 canvasId 启动。
		await page.goto("/");
		await waitForCanvasSession(page);

		// URL 被规范化写入 canvasId。
		await expect(page).toHaveURL(/canvasId=/);
		const firstUrl = new URL(page.url());
		const firstId = firstUrl.searchParams.get("canvasId");
		expect(firstId).toBeTruthy();

		// 只创建一个默认画布（不是多个）。
		const list = await page.request.get("/api/canvases?limit=100");
		const listed = (await list.json()) as { items: Array<{ id: string }>; total: number };
		expect(listed.total).toBe(1);

		// 通过切换器新建第二个画布。
		await page.locator('[data-testid="canvas-switcher-trigger"]').click();
		await page.getByRole("button", { name: "新建画布" }).click();
		await expect(page).not.toHaveURL(new RegExp(`canvasId=${firstId}$`));
		await waitForCanvasSession(page);
		const secondId = new URL(page.url()).searchParams.get("canvasId");
		expect(secondId).toBeTruthy();
		expect(secondId).not.toBe(firstId);

		// 在第二个画布创建节点 → 只属于 B。
		const created = await sendCommands(page, [
			{ type: "node.add", node: { id: "b-node", type: "text", position: { x: 10, y: 20 } } }
		], "multi-add-b");
		expect(created.ok).toBe(true);
		await waitForCommandsSettled(page);
		await waitForPersistedRevision(page, 1);
		expect((await readStoredCanvas(page))?.document.nodes.map((node) => node.id)).toContain("b-node");

		// back 回 A：URL 与规范状态都回到 A（无 b-node）。
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`canvasId=${firstId}`));
		await waitForCanvasSession(page);
		const canvasA = await readStoredCanvas(page);
		expect(canvasA?.document.nodes.map((node) => node.id)).not.toContain("b-node");

		// forward 回 B：b-node 仍在。
		await page.goForward();
		await expect(page).toHaveURL(new RegExp(`canvasId=${secondId}`));
		await waitForCanvasSession(page);
		await waitForPersistedRevision(page, 1);
		expect((await readStoredCanvas(page))?.document.nodes.map((node) => node.id)).toContain("b-node");

		expect(errors).toEqual([]);
	});

	test("重命名经 published projection 持久化，刷新与重新打开切换器后仍显示新标题", async ({ page }) => {
		await installPageHelpers(page);
		await resetAllCanvases(page);
		await page.goto("/");
		await waitForCanvasSession(page);
		const canvasId = new URL(page.url()).searchParams.get("canvasId")!;
		expect(canvasId).toBeTruthy();

		await page.locator('[data-testid="canvas-switcher-trigger"]').click();
		const input = page.locator('input[id="canvas-switcher-rename"]');
		await input.fill("重命名后的画布");
		await page.getByRole("button", { name: "重命名" }).click();
		// 等待 dialog 不再 busy（命令 settled + 目录刷新）。
		await expect(page.getByText("重命名后的画布").first()).toBeVisible();
		await page.keyboard.press("Escape");

		// 服务端目录摘要取自 published projection。
		await expect
			.poll(async () => {
				const response = await page.request.get(`/api/canvases?limit=100`);
				const body = (await response.json()) as { items: Array<{ id: string; title: string }> };
				return body.items.find((item) => item.id === canvasId)?.title;
			}, { timeout: 15_000 })
			.toBe("重命名后的画布");

		// URL 分享/刷新后仍打开同一画布且标题来自权威状态。
		await page.reload();
		await waitForCanvasSession(page);
		expect(new URL(page.url()).searchParams.get("canvasId")).toBe(canvasId);
		await page.locator('[data-testid="canvas-switcher-trigger"]').click();
		await expect(page.getByText("重命名后的画布").first()).toBeVisible();
	});

	test("显式指定不存在的 canvasId 显示恢复页，不静默打开其它画布", async ({ page }) => {
		await installPageHelpers(page);
		await resetAllCanvases(page);
		await page.goto("/?canvasId=definitely-missing");
		await expect(page.getByTestId("canvas-recovery")).toBeVisible();
		// 不创建 Canvas Session / Bevy canvas。
		await expect(page.locator("canvas#bevy-canvas")).toHaveCount(0);
	});
});
