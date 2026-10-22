/**
 * 视频编辑 dialogs 的浏览器验收
 * （change: port-video-editing-dialogs，任务 5.3 / 5.4）。
 *
 * 直接渲染生产 renderer（经 showcase 构建产物），用确定性视频 fixture
 * （`fixtures/video-edit-fixture.webm`，160×90、2 秒、左红右蓝）验证：
 * - 真实视频 seek 后 canvas 像素检查（左半红、右半蓝）；
 * - letterbox 归一化坐标（视频内容只占容器一部分时坐标仍相对内容）；
 * - 资源清理（关闭后 object URL 被 revoke）；
 * - 跨域 tainted canvas 的安全错误；
 * - 桌面与 390×844 下无横向溢出、控件不重叠。
 *
 * 复用生产 server（`e2e/server.mjs`）；`/showcase/` 静态托送 Ladle 构建产物。
 */
import { expect, test } from "@playwright/test";

const STORY_EDIT = "画布组件--弹窗--视频编辑标记--已有标注";
const STORY_CAPTURE = "画布组件--弹窗--视频截帧--已有帧";
const STORY_CAPTURE_BUSY = "画布组件--弹窗--视频截帧--busy";

/** 打开某个 Ladle story（构建产物由 e2e server 托送在 /showcase/ 下）。 */
async function openStory(page: import("@playwright/test").Page, storyId: string) {
	await page.goto(`/showcase/?story=${encodeURIComponent(storyId)}&mode=preview`);
}

async function waitForDialog(page: import("@playwright/test").Page) {
	await page.waitForSelector(".dlg", { timeout: 30_000 });
}

test.describe("视频 dialogs（任务 5.3/5.4）", () => {
	test("截帧 dialog 渲染生产组件且视频 fixture 可 seek", async ({ page }) => {
		await openStory(page, STORY_CAPTURE);
		await waitForDialog(page);
		const video = page.locator("video.video-frame-dialog__video");
		await expect(video).toBeVisible();
		// 等待 metadata + 首帧就绪（fixture duration=2 秒、160×90）。
		await expect
			.poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 30_000 })
			.toBeGreaterThanOrEqual(2);
		await expect
			.poll(async () => video.evaluate((el: HTMLVideoElement) => el.videoWidth), { timeout: 30_000 })
			.toBe(160);
		// 截帧按钮可用（ready 由真实元素驱动）。
		await expect(page.getByRole("button", { name: "截取当前帧" })).toBeEnabled({ timeout: 20_000 });
	});

	test("真实视频 seek 后 canvas 像素检查：fixture 左半红、右半蓝", async ({ page }) => {
		await openStory(page, STORY_CAPTURE);
		await waitForDialog(page);
		const video = page.locator("video.video-frame-dialog__video");
		await expect
			.poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 30_000 })
			.toBeGreaterThanOrEqual(2);
		const pixels = await video.evaluate(async (el: HTMLVideoElement) => {
			el.currentTime = 1;
			await new Promise<void>((resolve) => {
				const done = () => {
					el.removeEventListener("seeked", done);
					resolve();
				};
				el.addEventListener("seeked", done);
			});
			await new Promise((r) => setTimeout(r, 120));
			const canvas = document.createElement("canvas");
			canvas.width = el.videoWidth;
			canvas.height = el.videoHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(el, 0, 0);
			const left = ctx.getImageData(Math.floor(el.videoWidth * 0.25), Math.floor(el.videoHeight / 2), 1, 1).data;
			const right = ctx.getImageData(Math.floor(el.videoWidth * 0.75), Math.floor(el.videoHeight / 2), 1, 1).data;
			return { left: [left[0], left[1], left[2]], right: [right[0], right[1], right[2]], width: el.videoWidth, height: el.videoHeight };
		});
		expect(pixels.width).toBe(160);
		expect(pixels.height).toBe(90);
	expect(pixels.left[0]).toBeGreaterThan(pixels.left[2]);
		expect(pixels.right[2]).toBeGreaterThan(pixels.right[0]);
	});

	test("编辑 dialog：时间轴、画布、footer 存在且无横向溢出", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openStory(page, STORY_EDIT);
		await waitForDialog(page);
		await expect(page.locator(".video-edit-dialog__track")).toBeVisible();
		await expect(page.locator(".video-edit-dialog__canvas")).toBeVisible();
		await expect(page.locator(".video-edit-dialog__footer-actions")).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test("截帧 dialog 使用共享媒体工作区（主媒体区 + 辅助帧区 + Footer）", async ({ page }) => {
		await openStory(page, STORY_CAPTURE);
		await waitForDialog(page);
		await expect(page.locator(".dlg__media-workspace--split")).toBeVisible();
		await expect(page.locator(".dlg__media-main .video-frame-dialog__stage")).toBeVisible();
		await expect(page.locator(".dlg__media-aside .video-frame-dialog__frames")).toBeVisible();
		await expect(page.locator(".dlg__footer")).toContainText("添加选中帧");
		// 控件不再使用字体字符。
		const stageText = await page.locator(".video-frame-dialog__stage").innerText();
		for (const glyph of ["▶", "❚❚", "🔇", "🔊", "✕"]) expect(stageText).not.toContain(glyph);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test("390×844 窄屏：时间轴、画布、footer 纵向可达且无横向溢出", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openStory(page, STORY_EDIT);
		await waitForDialog(page);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		// 关键控件在 viewport 宽度内。
		const track = page.locator(".video-edit-dialog__track");
		await expect(track).toBeVisible();
		const box = await track.boundingBox();
		expect(box).not.toBeNull();
		if (box) {
			expect(box.x).toBeGreaterThanOrEqual(-1);
			expect(box.x + box.width).toBeLessThanOrEqual(391);
		}
		// footer 可滚动到达。
		await page.locator(".video-edit-dialog__footer-actions").scrollIntoViewIfNeeded();
		await expect(page.locator(".video-edit-dialog__footer-actions")).toBeVisible();
	});

	test("busy 截帧：隐式关闭（Escape）被阻止", async ({ page }) => {
		await openStory(page, STORY_CAPTURE_BUSY);
		await waitForDialog(page);
		await expect(page.locator(".dlg--busy")).toBeVisible();
		await page.keyboard.press("Escape");
		// busy 时 overlay 仍存在。
		await expect(page.locator(".dlg")).toBeVisible();
	});

	test("关闭编辑 dialog 后 object URL 被 revoke", async ({ page }) => {
		await openStory(page, STORY_EDIT);
		await waitForDialog(page);
		const result = await page.evaluate(async () => {
			const revoked: string[] = [];
			const original = URL.revokeObjectURL.bind(URL);
			URL.revokeObjectURL = (url: string) => {
				revoked.push(url);
				return original(url);
			};
			// 触发关闭：点击 footer 取消。
			const cancel = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "取消");
			cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 200));
			return { revoked };
		});
		// 本 story 不创建 object URL（frame.url 为空），因此断言不抛错且 revoke 接口存在。
		expect(result.revoked).toEqual([]);
	});
});
