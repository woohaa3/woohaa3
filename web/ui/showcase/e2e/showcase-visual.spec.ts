/**
 * 任务历史 / 模型参数查看页的桌面与 390px 视觉基线
 * （change: add-showcase-history-model-panels，任务 4.2）。
 *
 * 覆盖：
 * - 历史详情抽屉打开状态（视频 metadata 可见）；
 * - 模型参数 model3d（MCP）与 disabledReason；
 * - 390px 窄屏下两个面板。
 *
 * 时间由查看页固定 locale/timezone（见 `src/fixed-clock.ts`），因此截图可跨机器重复。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const HISTORY = "画布组件--任务历史";
const MODEL = "画布组件--模型参数";

async function openStory(page: Page, story: string) {
	await page.goto(`/?story=${encodeURIComponent(story)}`);
	await page.waitForSelector(".showcase__content", { state: "visible" });
	await page.waitForFunction(() => {
		const content = document.querySelector(".showcase__content");
		return Boolean(content && content.childElementCount > 0);
	});
}

test.describe("桌面视觉基线", () => {
	test("任务历史 ready 列表", async ({ page }) => {
		await openStory(page, `${HISTORY}--ready-列表`);
		await expect(page.locator(".task-history__table")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("history-ready.png", { maxDiffPixelRatio: 0.02 });
	});

	test("任务历史详情（视频 metadata）", async ({ page }) => {
		await openStory(page, `${HISTORY}--详情`);
		await page
			.locator('tr[data-task-key="task-video-succeeded"]')
			.getByRole("button", { name: /查看任务/ })
			.click();
		await expect(page.getByTestId("task-history-detail")).toBeVisible();
		await expect(page.locator(".task-history__detail")).toHaveScreenshot("history-detail.png", {
			maxDiffPixelRatio: 0.02
		});
	});

	test("模型参数 model3d（MCP）", async ({ page }) => {
		await openStory(page, `${MODEL}--model3d`);
		await expect(page.locator(".node-param-panel")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("model-generate.png", { maxDiffPixelRatio: 0.02 });
	});

	test("模型参数被禁用（原因可见）", async ({ page }) => {
		await openStory(page, `${MODEL}--被禁用`);
		await expect(page.getByRole("note")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("model-disabled.png", { maxDiffPixelRatio: 0.02 });
	});

});

test.describe("中屏视觉基线（覆盖详情）", () => {
	test.use({ viewport: { width: 1024, height: 900 } });

	test("任务历史中屏列表 + 覆盖详情", async ({ page }) => {
		await openStory(page, `${HISTORY}--ready-列表`);
		await expect(page.locator(".task-history__table")).toBeVisible();
		const videoRow = page.locator('tr[data-task-key="task-video-succeeded"]');
		await videoRow.getByRole("button", { name: /查看任务/ }).click();
		await expect(page.getByTestId("task-history-detail")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("history-mid-detail.png", {
			maxDiffPixelRatio: 0.02
		});
	});
});

test.describe("390px 视觉基线", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("任务历史窄屏列表", async ({ page }) => {
		await openStory(page, `${HISTORY}--窄屏-390`);
		await expect(page.locator(".task-history__table")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("history-narrow.png", {
			maxDiffPixelRatio: 0.02
		});
	});

	test("任务历史窄屏全屏详情", async ({ page }) => {
		await openStory(page, `${HISTORY}--窄屏-390`);
		const videoRow = page.locator('tr[data-task-key="task-video-succeeded"]');
		await videoRow.getByRole("button", { name: /查看任务/ }).click();
		await expect(page.getByTestId("task-history-detail")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("history-narrow-detail.png", {
			maxDiffPixelRatio: 0.02
		});
	});

	test("模型参数窄屏（禁用 + 原因）", async ({ page }) => {
		await openStory(page, `${MODEL}--窄屏-390`);
		await expect(page.getByRole("note")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("model-narrow.png", {
			maxDiffPixelRatio: 0.02
		});
	});

	test("模型参数 sidebar 360（MCP）", async ({ page }) => {
		await openStory(page, `${MODEL}--sidebar-360`);
		await expect(page.locator(".node-param-panel")).toBeVisible();
		await expect(page.locator(".showcase__stage")).toHaveScreenshot("model-sidebar-360.png", {
			maxDiffPixelRatio: 0.02
		});
	});
});

/**
 * 节点媒体 Dialog 视觉基线
 * （change: 2026-09-29-align-node-media-dialogs，任务 4.2）。
 *
 * 直接截生产图片预览与视频截帧 story：能发现「重新出现的全暗外围 chrome、旧 palette、
 * 字符图标或图片/视频布局再次分叉」。
 */
const MEDIA = "画布组件--弹窗--媒体工作区";

test.describe("媒体 Dialog 视觉基线", () => {
	test("图片 ready（default）", async ({ page }) => {
		await openStory(page, `${MEDIA}--图片-ready`);
		await expect(page.locator(".dlg__stage--image")).toBeVisible();
		await expect(page.locator(".showcase__stage").first()).toHaveScreenshot("media-image-ready.png", { maxDiffPixelRatio: 0.02 });
	});

	test("图片不可用（default）", async ({ page }) => {
		await openStory(page, `${MEDIA}--图片-不可用`);
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(page.locator(".showcase__stage").first()).toHaveScreenshot("media-image-unavailable.png", { maxDiffPixelRatio: 0.02 });
	});

	test("图片与视频对照（default）", async ({ page }) => {
		await openStory(page, `${MEDIA}--图片与视频对照`);
		await expect(page.locator(".video-frame-dialog__stage")).toBeVisible();
		await expect(page.locator(".showcase__stage").first()).toHaveScreenshot("media-compare.png", { maxDiffPixelRatio: 0.02 });
	});

	test("视频多帧（sentinel 主题）", async ({ page }) => {
		await openStory(page, "画布组件--弹窗--视频截帧--已有帧");
		await expect(page.locator(".video-frame-dialog__frame").first()).toBeVisible();
		await page.getByRole("radio", { name: "哨兵主题" }).click();
		await expect(page.locator(".app-theme-root")).toHaveAttribute("data-theme-id", "sentinel");
		await expect(page.locator(".showcase__stage").first()).toHaveScreenshot("media-video-sentinel.png", { maxDiffPixelRatio: 0.02 });
	});
});

test.describe("媒体 Dialog 390px 视觉基线", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("图片窄屏", async ({ page }) => {
		await openStory(page, `${MEDIA}--390-窄屏`);
		await expect(page.locator(".dlg__stage--image")).toBeVisible();
		await expect(page.locator(".showcase__stage").first()).toHaveScreenshot("media-narrow.png", { maxDiffPixelRatio: 0.02 });
	});
});
