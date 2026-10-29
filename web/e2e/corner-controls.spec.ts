/**
 * 右下角控件面板视觉验收（change: unify-canvas-corner-controls）。
 *
 * 断言缩放图标、紧凑滑杆与同步状态同处一个面板，并保留截图。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	resetCanvasStorage,
	waitForCanvasSession
} from "./helpers.js";

const PANEL = ".canvas-control-panel";

test("右下角统一控件面板：缩放 + 适合屏幕 + 同步状态", async ({ page }) => {
	await installPageHelpers(page);
	await resetCanvasStorage(page);
	await waitForCanvasSession(page);

	const panel = page.locator(PANEL);
	await expect(panel).toBeVisible();
	// 顶部不再常驻同步/revision 胶囊（change: move-sync-status-to-corner-panel）。
	await expect(page.locator(".persist-status")).toHaveCount(0);
	// 上排：功能图标（靠左）+ 同步状态图标（靠右）。
	const actionRow = panel.locator(".canvas-control-panel__row--actions");
	await expect(actionRow.locator(".canvas-control-panel__status-icon")).toBeVisible();
	// 第二排：缩放 + 适合屏幕。
	const viewportRow = panel.locator(".canvas-control-panel__row--viewport");
	await expect(viewportRow.locator('button[aria-label="缩小"]')).toBeVisible();
	await expect(viewportRow.locator('button[aria-label="放大"]')).toBeVisible();
	await expect(viewportRow.locator('button[aria-label="适合屏幕"]')).toBeVisible();
	await expect(viewportRow.locator('input[type="range"]')).toBeVisible();
	await expect(viewportRow.locator(".canvas-zoom__value")).toBeVisible();
	// 两排垂直堆叠：功能排在缩放的上一排。
	const actionBox = await actionRow.boundingBox();
	const viewportBox = await viewportRow.boundingBox();
	expect(actionBox).not.toBeNull();
	expect(viewportBox).not.toBeNull();
	expect(actionBox!.y).toBeLessThan(viewportBox!.y);

	// 面板本身的紧凑外观截图（未打开任何弹窗、未悬停状态图标）。
	await panel.screenshot({ path: "test-results/corner-panel.png" });

	// 悬停/聚焦同步状态图标：气泡只给出同步信息（MCP 指引位于 AI 面板的 MCP tab）。
	const bubble = actionRow.locator(".canvas-control-panel__status-bubble");
	await actionRow.locator(".canvas-control-panel__status-icon").hover();
	await expect(bubble).toBeVisible();
	await expect(bubble).toContainText("revision");
	// 页面底部不再显示 MCP 连接或画布指引。
	await expect(page.locator(".canvas-bottom-hint")).toHaveCount(0);
	await panel.screenshot({ path: "test-results/corner-panel-status-tooltip.png" });

	// 缩放到适合屏幕可点击（不报错）。
	await viewportRow.locator('button[aria-label="适合屏幕"]').click();
	await page.screenshot({ path: "test-results/corner-controls.png", fullPage: false });
});
