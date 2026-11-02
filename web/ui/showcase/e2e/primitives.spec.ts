/**
 * 生产 UI primitives 的 Showcase 浏览器验收
 * （change: adopt-radix-lucide-canvas-ui，任务 8.4）。
 *
 * 在真实 Ladle build 里验证生产 primitives 的 keyboard/focus、portal containment、
 * 无重叠与无横向 overflow；story 直接消费生产 export，fixture 只控制公开 state。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const PRIMITIVES = "画布组件--生产-ui-primitives";

async function openStory(page: Page, story: string): Promise<void> {
	await page.goto(`/?story=${encodeURIComponent(story)}&mode=preview`);
	await expect(page.locator(".showcase__content")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("生产 UI primitives", () => {
	test("Button/IconButton：icon-only 有可访问名，键盘 focus 可见", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--按钮`);
		const zoom = page.getByRole("button", { name: "放大" });
		await expect(zoom).toBeVisible();
		await zoom.focus();
		await expect(zoom).toBeFocused();
		// 禁用按钮不可激活（Button 文案 + IconButton aria-label 各一个）。
		await expect(page.locator("button.ui-button", { hasText: "禁用" })).toBeDisabled();
		await expect(page.getByRole("button", { name: "禁用", exact: true })).toHaveCount(2);
		await expectNoHorizontalOverflow(page);
	});

	test("Tooltip：hover 打开后 portal 收拢在 theme root 内", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--按钮`);
		await page.getByRole("button", { name: "复制" }).hover();
		const tooltip = page.locator(".ui-tooltip").first();
		await expect(tooltip).toBeVisible();
		// 提示进入 shadow root 内的 theme root，而非直接挂在 body 顶层。
		const insideTheme = await tooltip.evaluate((element) => Boolean(element.closest(".app-theme-root")));
		expect(insideTheme).toBe(true);
	});

	test("DropdownMenu：方向键与 Escape 键盘行为", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--浮层`);
		await page.getByRole("button", { name: "菜单" }).click();
		const menu = page.locator('[role="menu"]');
		await expect(menu).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByRole("menuitem", { name: "复制" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
	});

	test("Tabs 与 SegmentedControl：ARIA 与方向键", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--tabs-与分段控件`);
		const tablist = page.getByRole("tablist", { name: "视图" });
		await expect(tablist).toBeVisible();
		await page.getByRole("tab", { name: "视图 A" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "视图 B" })).toBeFocused();
		// single segmented 为 radiogroup，且始终有一个选中项。
		const group = page.getByRole("radiogroup", { name: "主题", exact: true });
		await expect(group).toBeVisible();
		await expect(group.getByRole("radio", { checked: true })).toHaveCount(1);
	});

	test("Collapsible：Enter 切换 aria-expanded", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--折叠与滚动`);
		const trigger = page.getByRole("button", { name: "展开详情" });
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		await trigger.focus();
		await page.keyboard.press("Enter");
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
	});

	test("DialogSurface：Escape 关闭受控弹窗，焦点恢复到 opener", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--弹窗`);
		const opener = page.getByRole("button", { name: "打开弹窗" });
		await opener.click();
		const dialog = page.getByRole("dialog", { name: "示例弹窗" });
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(opener).toBeFocused();
	});
});

test.describe("390px primitive 契约", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("浮层与分段控件不产生横向溢出且保持可达", async ({ page }) => {
		await openStory(page, `${PRIMITIVES}--浮层`);
		await expectNoHorizontalOverflow(page);
		await page.getByRole("button", { name: "菜单" }).click();
		await expect(page.locator('[role="menu"]')).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
});
