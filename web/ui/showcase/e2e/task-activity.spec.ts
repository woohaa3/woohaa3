/** Desktop acceptance for the production canvas activity feed and in-page DialogHost. */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const ACTIVITY = "画布组件--任务活动栈";
async function openStory(page: Page, story: string) {
  await page.goto(`/?story=${encodeURIComponent(`${ACTIVITY}--${story}`)}`);
  await page.waitForSelector(".task-activity-feed, .task-activity-feed__entry");
}
test.use({ viewport: { width: 1440, height: 900 } });

test("活动项保持单行，标题和状态不会横向溢出", async ({ page }) => {
  for (const story of ["默认", "状态覆盖", "成功结果", "失效目标"]) {
    await openStory(page, story);
    const feed = page.locator(".task-activity-feed");
    await expect(feed).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(feed.locator("summary, audio, video, .task-activity-feed__model, .task-activity-feed__thumb")).toHaveCount(0);
    for (const row of await feed.locator(".task-activity-feed__card").all()) {
      const box = await row.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(36);
      const title = row.locator(".task-activity-feed__primary");
      await expect(title).toHaveCSS("white-space", "nowrap");
      const titleBox = await title.boundingBox();
      const stateBox = await row.locator(".task-activity-feed__state").boundingBox();
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(stateBox!.x);
      expect(Math.abs(titleBox!.y + titleBox!.height / 2 - (stateBox!.y + stateBox!.height / 2))).toBeLessThan(2);
    }
  }
});

test("悬停和键盘聚焦直接显示模型与失败原因，无需点击", async ({ page }) => {
  await openStory(page, "默认");
  const failed = page.locator('.task-activity-feed__card[data-state="failed"]');
  const pop = page.locator(".task-activity-feed__pop");
  await expect(pop).toHaveCount(0);
  await failed.hover();
  await expect(pop).toContainText("上游 provider 超时");
  await expect(pop).toContainText("gemini-2.5-flash");
  await page.mouse.move(0, 0);
  await expect(pop).toHaveCount(0);
  await failed.locator(".task-activity-feed__primary").focus();
  await expect(pop).toContainText("上游 provider 超时");
});

test("点击在当前页复用作品生成历史弹窗，Escape 关闭并恢复焦点", async ({ page }) => {
  await openStory(page, "默认");
  const url = page.url();
  const title = page.locator('.task-activity-feed__card[data-state="failed"] .task-activity-feed__primary');
  await title.click();
  const dialog = page.getByRole("dialog", { name: "作品生成历史" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("canvas-history-browser")).toBeVisible();
  await expect(dialog.getByRole("radiogroup", { name: "生成历史筛选" })).toBeVisible();
  await expect(dialog.locator(".task-activity-dialog__task")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(title).toBeFocused();
  expect(page.url()).toBe(url);
});

test("弹窗展示全部当前画布记录，活动栈优先保留旧运行任务", async ({ page }) => {
  await openStory(page, "超出展示上限");
  const feed = page.locator(".task-activity-feed");
  await expect(feed.locator(".task-activity-feed__card")).toHaveCount(10);
  await expect(feed.locator(".task-activity-feed__card").first()).toHaveAttribute("data-state", "running");
  await expect(feed.locator(".task-activity-feed__overflow")).toHaveCount(0);
  await feed.getByRole("button", { name: "作品生成历史", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".canvas-history__item")).toHaveCount(12);
});

test("媒体预览不占用画布行，不创建额外播放器", async ({ page }) => {
  await openStory(page, "成功结果");
  const feed = page.locator(".task-activity-feed");
  const image = feed.locator(".task-activity-feed__card").filter({ hasText: "图片" }).first();
  await image.hover();
  await expect(page.locator(".task-activity-feed__pop img")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator(".task-activity-feed__pop")).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await feed.getByRole("button", { name: "作品生成历史", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "作品生成历史" }).getByTestId("canvas-history-browser")).toBeVisible();
  await expect(feed.locator("audio")).toHaveCount(0);
});

test("关闭、清除已结束与收起均保持运行任务", async ({ page }) => {
  await openStory(page, "默认");
  const feed = page.locator(".task-activity-feed");
  const failed = feed.locator('[data-state="failed"]');
  await failed.hover();
  await failed.getByRole("button", { name: "关闭该记录" }).click();
  await expect(failed).toHaveCount(0);
  await feed.getByRole("button", { name: "收起任务活动" }).click();
  await expect(feed).toHaveCount(0);
  await page.locator(".task-activity-feed__entry").click();
  await feed.getByRole("button", { name: "清除已结束" }).click();
  await expect(feed.locator(".task-activity-feed__card")).toHaveCount(1);
  await expect(feed.locator('[data-state="running"]')).toBeVisible();
});

test("实时事件及断线补偿保持同一任务幂等", async ({ page }) => {
  await openStory(page, "实时更新");
  await page.getByTestId("activity-insert").click();
  await expect(page.locator('.task-activity-feed__card[data-state="running"]')).toHaveCount(1);
  await page.getByTestId("activity-complete").click();
  await expect(page.locator('.task-activity-feed__card[data-state="succeeded"]')).toHaveCount(1);
  await page.getByTestId("activity-recover").click();
  await page.getByTestId("activity-recover").click();
  await expect(page.locator(".task-activity-feed__card")).toHaveCount(4);
});
