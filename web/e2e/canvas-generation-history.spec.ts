/** Real GPU acceptance: AI center history at desktop and Pad sizes, never a second browser. */
import { expect, test } from "@playwright/test";
import { installPageHelpers, readStoredCanvas, resetCanvasStorage, waitForCanvasSession } from "./helpers.js";

test("能力中心展示当前画布只读生成历史", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);

  const revisionBefore = (await readStoredCanvas(page))?.revision ?? 0;

  const panel = page.locator(".canvas-control-panel");
  await expect(panel.locator('button[aria-label="作品生成历史"]')).toHaveCount(0);
  await panel.locator('button[aria-label="AI 助手"]').click();
  await page.locator('.agent-assistant__sidebar [data-page="generation-history"]').click();
  const dialog = page.locator(".dlg");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "生成历史" })).toBeVisible();
  const browser = page.locator('[data-testid="canvas-history-browser"]');
  await expect(browser).toBeVisible();

  // 筛选：全部/文本/图片/视频/音频/模型。
  const filters = browser.locator('[role="radio"]');
  await expect(filters).toHaveCount(6);
  await expect(filters.first()).toHaveText(/全部/);

  // 只读：不含恢复/添加写入动作。
  await expect(browser.getByText("设为当前")).toHaveCount(0);
  await expect(browser.getByText("添加到画布")).toHaveCount(0);

  // 打开弹窗不推进 canvas revision。
  expect((await readStoredCanvas(page))?.revision ?? 0).toBe(revisionBefore);

  await page.screenshot({ path: "test-results/canvas-generation-history.png", fullPage: false });

  // 关闭弹窗后焦点恢复（Dialog Host 负责）。
  await dialog.locator(".dlg__close").click();
  await expect(dialog).toBeHidden();
});

test("Pad 能力中心生成历史可用", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);

  await page.locator('.canvas-control-panel button[aria-label="AI 助手"]').click();
  await page.locator('.agent-assistant__sidebar [data-page="generation-history"]').click();
  const browser = page.locator('[data-testid="canvas-history-browser"]');
  await expect(browser).toBeVisible();
  await expect(browser.locator('[role="radio"]').first()).toBeVisible();

  await page.screenshot({ path: "test-results/canvas-generation-history-pad.png", fullPage: false });
});
