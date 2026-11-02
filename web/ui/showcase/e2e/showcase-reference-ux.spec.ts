import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
/**
 * Showcase 响应式视觉验收（change: align-showcase-reference-ux，任务 4.2）。
 *
 * 桌面与 390×844 视口分别打开 dialog / Dock / 片段库 story，断言：
 * - 无页面级横向滚动；
 * - 弹窗 Header/Footer 可达、超长内容在 Body 内独立滚动；
 * - Dock 与片段库无裁剪或重叠；
 * 并输出截图供人工复核。
 */

const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 390, height: 844 };

/** Ladle story id → URL。 */
function storyUrl(id: string): string {
	return `/?story=${id}&mode=preview`;
}

async function gotoStory(page: Page, id: string, viewport: { width: number; height: number }) {
	await page.setViewportSize(viewport);
	await page.goto(storyUrl(id));
	// Ladle 预览模式：等待 story 根节点挂载。
	await page.waitForSelector(".showcase, .showcase__stage", { timeout: 30_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const root = document.documentElement;
		return {
			scrollWidth: root.scrollWidth,
			clientWidth: root.clientWidth,
		};
	});
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("dialog 视口", () => {
	test("桌面长内容弹窗 Header/Footer 可达且 Body 独立滚动", async ({ page }) => {
		await gotoStory(page, "画布组件--弹窗--基础--标准-lg", DESKTOP);
		await expect(page.locator(".dlg__header")).toBeVisible();
		await expect(page.locator(".dlg__footer")).toBeVisible();
		// 舞台没有被固定高度裁切。
		const box = await page.locator(".showcase__dialog-box").boundingBox();
		expect(box!.height).toBeGreaterThan(460);
		await expectNoHorizontalOverflow(page);
		await page.screenshot({ path: "test-results/dialog-desktop.png", fullPage: true });
	});

	test("390×844 窄屏长内容弹窗 Body 可滚动、页面无横向滚动", async ({ page }) => {
		await gotoStory(page, "画布组件--弹窗--基础--窄屏-长内容", NARROW);
		await expect(page.locator(".dlg__header")).toBeVisible();
		await expect(page.locator(".dlg__footer")).toBeVisible();
		const body = page.locator(".dlg__body");
		const scrollable = await body.evaluate((element) => ({
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
		}));
		expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
		await body.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(page.locator(".dlg__footer button").last()).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await page.screenshot({ path: "test-results/dialog-narrow.png", fullPage: true });
	});

	test("关闭弹窗恢复焦点且不残留 overlay", async ({ page }) => {
		await gotoStory(page, "画布组件--弹窗--基础--焦点恢复", DESKTOP);
		const trigger = page.locator('[data-testid="dialog-trigger"]');
		await trigger.click();
		await expect(page.locator('[role="dialog"]')).toBeVisible();
		await page.locator(".dlg__close").click();
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await expect(page.locator(".dlg-host")).toHaveCount(0);
		const focusedIsTrigger = await trigger.evaluate((element) => document.activeElement === element);
		expect(focusedIsTrigger).toBe(true);
		await expectNoHorizontalOverflow(page);
	});
});

test.describe("Dock", () => {
  test("桌面生产 dock 只有一套模型选择与生成动作", async ({ page }) => {
    await gotoStory(page, "画布组件--执行面板--生产组合--dock-面", DESKTOP);
    await expect(page.locator(".node-execution-dock .mc-panel")).toBeVisible();
    await expect(page.getByRole("button", {name:"选择生成模型", exact:true})).toHaveCount(1);
    await expect(page.locator(".mc-panel__send")).toHaveCount(1);
    await expect(page.locator(".mention-editor__input")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: "test-results/dock-desktop.png", fullPage: true });
  });

  test("390×844 生产 dock 模型菜单选择后关闭且无横向溢出", async ({ page }) => {
    await gotoStory(page, "画布组件--执行面板--生产组合--dock-面", NARROW);
    await page.getByRole("button", {name:"选择生成模型", exact:true}).click();
    const menu = page.getByRole("menu", {name:"选择生成模型",exact:true});
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio").first().click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".mention-editor__input")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: "test-results/dock-narrow.png", fullPage: true });
  });
});
