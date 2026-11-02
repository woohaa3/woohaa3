/**
 * 任务历史 / 模型参数查看页的交互验收
 * （change: add-showcase-history-model-panels，任务 4.2）。
 *
 * 在真实浏览器里驱动 `ladle build` 里的 story，验证内存 client、recorder 与
 * clipboard adapter 的可观察行为。不发任何真实服务请求。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const HISTORY = "画布组件--任务历史";
const MODEL = "画布组件--模型参数";

function storyUrl(story: string): string {
	return `/?story=${encodeURIComponent(story)}`;
}

/** 等待 story 渲染出根节点（Ladle 是客户端路由）。 */
async function openStory(page: Page, story: string) {
	await page.goto(storyUrl(story));
	await page.waitForSelector(".showcase__content", { state: "visible" });
	await page.waitForFunction(() => {
		const content = document.querySelector(".showcase__content");
		return Boolean(content && content.childElementCount > 0);
	});
}

/** 页面级横向溢出检测：任何元素都不应超出 body 的可视宽度。 */
async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const body = document.body;
		const docWidth = document.documentElement.clientWidth;
		const scrollWidth = Math.max(body.scrollWidth, document.documentElement.scrollWidth);
		return { docWidth, scrollWidth };
	});
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.docWidth + 1);
}

const PANEL_URL = `${HISTORY}--ready-列表`;

test.describe("任务历史查看页", () => {
	test("ready 列表含四类媒体与多状态，时间文本稳定", async ({ page }) => {
		await openStory(page, PANEL_URL);
		const rows = page.locator(".task-history__table tbody tr[data-task-key]");
		await expect(rows).toHaveCount(10);

		const text = await page.locator(".task-history__table").innerText();
		for (const token of ["运行中", "成功", "失败", "已取消", "等待中"]) {
			expect(text).toContain(token);
		}
		// 固定 timezone（Asia/Shanghai）后，创建时间应是相对/本地时间而非原始 UTC ISO。
		expect(text).not.toContain("2026-09-27T07:40:00.000Z");
		expect(text).toMatch(/分钟前|小时前|天前|刚刚/);
	});

	test("tab 过滤收敛失败任务，且不显示空状态", async ({ page }) => {
		await openStory(page, PANEL_URL);
		await page.getByRole("radio", { name: "失败" }).click();
		const rows = page.locator(".task-history__table tbody tr[data-task-key]");
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toHaveAttribute("data-state", "failed");
		await expect(page.locator(".task-history__table")).not.toContainText("没有匹配的执行记录");
	});

	test("草稿与应用分离：输入显示未应用，应用后才请求", async ({ page }) => {
		await openStory(page, PANEL_URL);
		const input = page.getByLabel("Provider 筛选");
		await input.fill("litellm");
		await expect(page.getByText("当前修改尚未应用")).toBeVisible();
		await page.getByRole("button", { name: "应用筛选" }).click();
		await expect(page.getByText("当前修改尚未应用")).toHaveCount(0);
		await expect(page.locator(".task-history__chip")).toContainText("Provider：litellm");
		// 清除全部后回到无筛选列表。
		await page.getByRole("button", { name: "清除全部" }).click();
		await expect(page.locator(".task-history__chip")).toHaveCount(0);
	});

	test("来源筛选区分插件任务，插件任务来源正常呈现", async ({ page }) => {
		await openStory(page, PANEL_URL);
		await page.getByLabel("来源筛选").selectOption("extension");
		await page.getByRole("button", { name: "应用筛选" }).click();
		const rows = page.locator(".task-history__table tbody tr[data-task-key]");
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toHaveAttribute("data-task-key", "task-plugin-succeeded");
		await expect(rows.first()).toContainText("sample-site");
	});

	test("加载失败显示错误与重试，重试后出现任务", async ({ page }) => {
		await openStory(page, `${HISTORY}--加载失败`);
		const alert = page.getByRole("alert");
		await expect(alert).toContainText("网关不可用");
		await expect(page.locator(".task-history__table")).not.toContainText("没有匹配的执行记录");
		await alert.getByRole("button", { name: "重试" }).click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.locator("tr[data-task-key]").first()).toBeVisible();
	});

	test("分页：下一页不清空既有结果且不重复", async ({ page }) => {
		await openStory(page, `${HISTORY}--分页`);
		const firstPage = await page.locator("tr[data-task-key]").evaluateAll((rows) =>
			rows.map((row) => row.getAttribute("data-task-key"))
		);
		expect(firstPage).toHaveLength(4);
		await page.getByRole("button", { name: "下一页" }).click();
		await expect(page.locator(".task-history__pager")).toContainText("第 2 页");
		const secondPage = await page.locator("tr[data-task-key]").evaluateAll((rows) =>
			rows.map((row) => row.getAttribute("data-task-key"))
		);
		expect(secondPage).toHaveLength(4);
		expect(secondPage.some((entry) => firstPage.includes(entry))).toBe(false);
	});

	test("实时更新：running → succeeded 原位收敛，新任务进入去重提示", async ({ page }) => {
		await openStory(page, `${HISTORY}--实时更新`);
		const before = await page.locator("tr[data-task-key]").count();

		// 插入一条新的 running 任务：进入去重提示，不插入当前页。
		await page.getByTestId("emit-insert").click();
		await expect(page.getByRole("button", { name: /有 1 条新任务/ })).toBeVisible();
		expect(await page.locator("tr[data-task-key]").count()).toBe(before);

		// 更新既有 running 任务：行数不变，状态原位收敛。
		await page.getByTestId("emit-complete").click();
		await expect(page.locator('tr[data-task-key="task-video-running"]')).toHaveAttribute("data-state", "succeeded");
		const keys = await page.locator("tr[data-task-key]").evaluateAll((rows) =>
			rows.map((row) => row.getAttribute("data-task-key"))
		);
		expect(new Set(keys).size).toBe(keys.length);
		await expect(page.getByTestId("history-log")).toContainText("已发送 2 次");
	});

	test("详情抽屉展示视频 metadata，可关闭", async ({ page }) => {
		await openStory(page, `${HISTORY}--详情`);
		const videoRow = page.locator('tr[data-task-key="task-video-succeeded"]');
		await videoRow.getByRole("button", { name: /查看任务/ }).click();
		const drawer = page.getByTestId("task-history-detail");
		await expect(drawer).toContainText("generation-outputs/112233445566.mp4");
		await expect(drawer).toContainText("时长 8s");
		await drawer.getByRole("button", { name: "关闭详情" }).click();
		await expect(page.getByTestId("task-history-detail")).toHaveCount(0);
	});

	test("详情失效显示稳定反馈", async ({ page }) => {
		await openStory(page, `${HISTORY}--详情-失效`);
		const failedRow = page.locator('tr[data-task-key="task-image-failed"]');
		await failedRow.getByRole("button", { name: /查看任务/ }).click();
		const drawer = page.getByTestId("task-history-detail");
		await expect(drawer).toContainText("上游网关超时");
	});

	test("画布跳转：可跳转项调用 recorder，不可跳转项显示原因且不导航", async ({ page }) => {
		await openStory(page, `${HISTORY}--画布跳转`);
		await page
			.locator('tr[data-task-key="task-text-succeeded"]')
			.getByRole("button", { name: "打开画布" })
			.click();
		await expect(page.getByTestId("history-navigation")).toContainText("canvas-main / node-text-1");

		const audioRow = page.locator('tr[data-task-key="task-audio-succeeded"]');
		await expect(audioRow.getByRole("button", { name: "打开画布" })).toBeDisabled();
		await expect(audioRow.locator('[data-jump-reason="missing-node"]')).toContainText("不可跳转");
		// 只有一次导航调用（不可跳转项没有触发）。
		await expect(page.getByTestId("history-navigation")).not.toContainText("node-audio");
	});

	test("键盘 Enter 打开详情，Escape 关闭并恢复焦点", async ({ page }) => {
		await openStory(page, PANEL_URL);
		const openButton = page.locator('tr[data-task-key="task-image-failed"]').getByRole("button", { name: /查看任务/ });
		await openButton.focus();
		await page.keyboard.press("Enter");
		const drawer = page.getByTestId("task-history-detail");
		await expect(drawer).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("task-history-detail")).toHaveCount(0);
		// 焦点回到触发元素。
		await expect(openButton).toBeFocused();
	});

	test("详情相邻记录导航在当前页内可用", async ({ page }) => {
		await openStory(page, PANEL_URL);
		const firstRow = page.locator(".task-history__table tbody tr[data-task-key]").first();
		const firstKey = await firstRow.getAttribute("data-task-key");
		await firstRow.getByRole("button", { name: /查看任务/ }).click();
		const drawer = page.getByTestId("task-history-detail");
		await expect(drawer).toBeVisible();
		await drawer.getByRole("button", { name: "下一条" }).click();
		await expect(drawer).toBeVisible();
		// 选中行随导航移动，且与首行不同。
		await expect(page.locator(".task-history__table tbody tr[data-selected]")).toHaveCount(1);
		const selected = await page.locator(".task-history__table tbody tr[data-selected]").getAttribute("data-task-key");
		expect(selected).not.toBe(firstKey);
	});
});

test.describe("模型参数查看页", () => {
	test("model3d 显示 MCP，已下线的 edit/shot 不渲染面板", async ({ page }) => {
		await openStory(page, `${MODEL}--model3d`);
		await expect(page.getByText("MCP 模型生成", { exact: true })).toBeVisible();
		await expect(page.getByLabel("MCP 服务器地址")).toBeVisible();
		await expect(page.getByText("模型摆放")).toHaveCount(0);

		await openStory(page, `${MODEL}--已下线的-edit`);
		await expect(page.getByText("MCP 模型生成", { exact: true })).toHaveCount(0);
		await expect(page.locator(".node-param-panel")).toHaveCount(0);

		await openStory(page, `${MODEL}--已下线的-shot`);
		await expect(page.getByText("MCP 模型生成", { exact: true })).toHaveCount(0);
		await expect(page.locator(".node-param-panel")).toHaveCount(0);
	});

	test("disabledReason 显示原因", async ({ page }) => {
		await openStory(page, `${MODEL}--被禁用`);
		await expect(page.getByRole("note")).toContainText("暂时无法读取模型");
	});

	test("复制成功/失败反馈可控，不触碰真实 clipboard", async ({ page }) => {
		await openStory(page, `${MODEL}--复制成功`);
		await page.getByRole("button", { name: "复制" }).first().click();
		await expect(page.locator('[data-copy-field="server"]')).toHaveAttribute("data-status", "copied");
		await expect(page.locator('[data-copy-field="server"]')).toContainText("复制成功");

		await openStory(page, `${MODEL}--复制失败`);
		await page.getByRole("button", { name: "复制" }).first().click();
		await expect(page.locator('[data-copy-field="server"]')).toHaveAttribute("data-status", "error");
		await expect(page.locator('[data-copy-field="server"]')).toContainText("复制失败");
		await expect(page.locator('[data-copy-field="server"]')).not.toContainText("复制成功");
	});
});

test.describe("窄屏 390px", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("历史列表、过滤器与抽屉在 390px 无页面级横向溢出且可关闭", async ({ page }) => {
		await openStory(page, `${HISTORY}--窄屏-390`);
		await expectNoHorizontalOverflow(page);

		const videoRow = page.locator('tr[data-task-key="task-video-succeeded"]');
		if ((await videoRow.count()) > 0) {
			await videoRow.getByRole("button", { name: /查看任务/ }).click();
			const drawer = page.getByTestId("task-history-detail");
			await expect(drawer).toBeVisible();
			await expectNoHorizontalOverflow(page);
			// 生产抽屉的窄屏形态：内容可纵向滚动，关闭后恢复。
			await drawer.getByRole("button", { name: "关闭详情" }).click();
			await expect(page.getByTestId("task-history-detail")).toHaveCount(0);
		}
	});

	test("模型参数在 390px 无裁切与横向溢出", async ({ page }) => {
		await openStory(page, `${MODEL}--窄屏-390`);
		await expectNoHorizontalOverflow(page);
		await expect(page.getByRole("note")).toContainText("窄屏验证");
	});
});

test.describe("模型参数 sidebar 360", () => {
	test.use({ viewport: { width: 360, height: 800 } });

	test("MCP 不裁切、不横向溢出", async ({ page }) => {
		await openStory(page, `${MODEL}--sidebar-360`);
		await expectNoHorizontalOverflow(page);
		await expect(page.locator(".node-param-panel")).toBeVisible();
		// MCP 提示词指引的完整文本可达（可滚动），不是被裁掉的死内容。
		const guide = page.getByLabel("MCP 模型提示词指引");
		const reachable = await guide.evaluate((element) => {
			const area = element as HTMLTextAreaElement;
			return area.scrollHeight > area.clientHeight && area.scrollHeight > 0;
		});
		expect(reachable).toBe(true);
		expect(await guide.inputValue()).toContain("submit_model_script");
	});
});
