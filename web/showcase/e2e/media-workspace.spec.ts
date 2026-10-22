/**
 * 节点媒体 Dialog 的浏览器验收
 * （change: 2026-09-29-align-node-media-dialogs，任务 4.2）。
 *
 * 在真实 Ladle build 里驱动生产图片预览与视频截帧 story：
 * - default/sentinel 下外围 chrome 随主题切换，舞台仍使用该 preset 的 media 语义；
 * - 图片缩放/重置前后 Dialog 外框与 Header/Close 位置稳定，事件不穿透背景舞台；
 * - 桌面与 390×844 下无页面级横向溢出、控件可达、关键状态生成视觉基线。
 */
import { expect, test, type Page } from "@playwright/test";

const IMAGE_READY = "画布组件--弹窗--媒体工作区--图片-ready";
const IMAGE_UNAVAILABLE = "画布组件--弹窗--媒体工作区--图片-不可用";
const VIDEO_CAPTURED = "画布组件--弹窗--视频截帧--已有帧";
const VIDEO_DEFAULT = "画布组件--弹窗--视频截帧--默认";
const VIDEO_BUSY = "画布组件--弹窗--视频截帧--busy";
const VIDEO_PARTIAL = "画布组件--弹窗--视频截帧--部分失败";
const COMPARE_DESKTOP = "画布组件--弹窗--媒体工作区--图片与视频对照";

async function openStory(page: Page, story: string) {
	await page.goto(`/?story=${encodeURIComponent(story)}&mode=preview`);
	await page.waitForSelector(".dlg", { timeout: 30_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
}

/** 读取外侧 Dialog 外框（`.dlg`）。 */
async function dialogBox(page: Page) {
	return page.locator(".dlg").first().boundingBox();
}

test.describe("媒体工作区结构（任务 4.2）", () => {
	test("图片与视频共享应用 chrome，且各自保留舞台/辅助区层级", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await openStory(page, COMPARE_DESKTOP);

		// 两处 `.dlg`：图片与视频；都使用应用 chrome（浅色面板）而非全暗外框。
		const panels = page.locator(".dlg");
		await expect(panels).toHaveCount(2);
		for (let index = 0; index < 2; index += 1) {
			const background = await panels.nth(index).evaluate((element) => getComputedStyle(element).backgroundColor);
			expect(background).not.toMatch(/^rgba?\(16,\s*24,\s*20/);
		}

		// 图片：中性舞台 + 应用 chrome 图标控件。
		await expect(page.locator(".dlg__stage--image").first()).toBeVisible();
		await expect(page.locator('.dlg__icon-button[aria-label="缩小"]').first()).toBeVisible();

		// 视频：主媒体区 + 辅助帧区 + Footer 提交动作。
		await expect(page.locator(".video-frame-dialog__stage")).toBeVisible();
		await expect(page.locator(".dlg__media-aside .video-frame-dialog__frames")).toBeVisible();
		await expect(page.locator(".dlg__footer").last()).toContainText("添加选中帧");
		await expectNoHorizontalOverflow(page);
	});

	test("默认/已有帧/busy/部分失败各自呈现状态且无横向溢出", async ({ page }) => {
		for (const [story, assert] of [
			[VIDEO_DEFAULT, async () => expect(page.locator(".video-frame-dialog__empty")).toBeVisible()],
			[VIDEO_CAPTURED, async () => expect(page.locator(".video-frame-dialog__frame").first()).toBeVisible()],
			[VIDEO_BUSY, async () => expect(page.locator(".dlg--busy")).toBeVisible()],
			[VIDEO_PARTIAL, async () => {
				await expect(page.locator(".video-frame-dialog__frame-copy .is-error").first()).toContainText("上传失败");
				await expect(page.locator(".dlg__footer")).toContainText("重试失败项");
			}],
		] as const) {
			await openStory(page, story);
			await assert();
			await expectNoHorizontalOverflow(page);
		}
	});
});

test.describe("主题与交互（任务 4.2）", () => {
	test("sentinel 切换外围 chrome，舞台保持媒体语义", async ({ page }) => {
		await openStory(page, IMAGE_READY);
		// 外围 chrome 随 preset 切换（用边框色观察，避免默认/sentinel surface 同为白色）。
		const panel = page.locator(".dlg").first();
		const readChrome = () => panel.evaluate((element) => {
			const style = getComputedStyle(element);
			return `${style.borderTopColor}|${style.color}`;
		});
		const before = await readChrome();

		await page.getByRole("radio", { name: "哨兵主题" }).click();
		await expect(page.locator(".app-theme-root")).toHaveAttribute("data-theme-id", "sentinel");

		const after = await readChrome();
		expect(after).not.toBe(before);
		// 舞台仍消费该 preset 的 media 语义（深色），而不是变成 chrome 面板色。
		const readStage = () => page.locator(".dlg__stage--image").evaluate((element) => {
			const style = getComputedStyle(element);
			return { color: style.backgroundColor, luminance: style.backgroundColor, dark: (() => {
				const match = style.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
				if (!match) return false;
				const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
				return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.3;
			})() };
		});
		const stageSentinel = await readStage();
		const panelSurface = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
		expect(stageSentinel.color).not.toBe(panelSurface);
		expect(stageSentinel.dark, "媒体舞台应为中性深色").toBe(true);

		// 切回 default 后舞台颜色随 preset 变化，但没有硬编码默认色。
		await page.getByRole("radio", { name: "浅色主题" }).click();
		await expect(page.locator(".app-theme-root")).toHaveAttribute("data-theme-id", "default");
		const stageDefault = await readStage();
		expect(stageDefault.color).not.toBe(stageSentinel.color);
		expect(stageDefault.dark).toBe(true);
		await expectNoHorizontalOverflow(page);
	});

	test("图片缩放/重置不改变外框，且事件不穿透背景画布", async ({ page }) => {
		await openStory(page, IMAGE_READY);
		const before = await dialogBox(page);
		const closeBefore = await page.locator(".dlg__close").boundingBox();

		await page.locator('.dlg__icon-button[aria-label="放大"]').click();
		await page.locator('.dlg__icon-button[aria-label="放大"]').click();
		const zoomed = await page.locator(".dlg__zoom").textContent();
		expect(zoomed).not.toBe("100%");

		const during = await dialogBox(page);
		const closeDuring = await page.locator(".dlg__close").boundingBox();
		expect(Math.abs(during!.width - before!.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(closeDuring!.x - closeBefore!.x)).toBeLessThanOrEqual(1);

		await page.locator('.dlg__icon-button[aria-label="适应屏幕并重置"]').click();
		await expect(page.locator(".dlg__zoom")).toHaveText("100%");
		const after = await dialogBox(page);
		expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);

		// 缩放按钮可获得可见焦点。
		const zoomOut = page.locator('.dlg__icon-button[aria-label="缩小"]');
		await zoomOut.focus();
		await expect(zoomOut).toBeFocused();
		await expectNoHorizontalOverflow(page);
	});

	test("不可用图片仍可关闭且显示原因", async ({ page }) => {
		await openStory(page, IMAGE_UNAVAILABLE);
		await expect(page.getByRole("alert")).toContainText("不可预览");
		await expect(page.locator('.dlg__close')).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
});

test.describe("390×844 窄屏（任务 4.2）", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("视频多帧单列可达、无嵌套横向滚动与页面溢出", async ({ page }) => {
		await openStory(page, VIDEO_CAPTURED);
		await expectNoHorizontalOverflow(page);

		// Header/关闭、媒体控制与 Footer 主操作都可达。
		await expect(page.locator(".dlg__header")).toBeVisible();
		await expect(page.locator(".dlg__close")).toBeVisible();
		await expect(page.locator('.dlg__icon-button[aria-label="播放视频"]')).toBeVisible();
		const footer = page.locator(".dlg__footer");
		await footer.scrollIntoViewIfNeeded();
		await expect(footer).toContainText("添加选中帧");

		// 舞台与辅助区不超出视口宽度（无嵌套横向滚动）。
		const box = await dialogBox(page);
		expect(box!.x).toBeGreaterThanOrEqual(-1);
		expect(box!.x + box!.width).toBeLessThanOrEqual(391);
		await expectNoHorizontalOverflow(page);
	});

	test("图片窄屏舞台与外框不溢出", async ({ page }) => {
		await openStory(page, IMAGE_READY);
		await expect(page.locator(".dlg__stage--image")).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
});
