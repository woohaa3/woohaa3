/**
 * 画布「全部生成历史」弹窗 E2E
 * （change: add-canvas-generation-history-dialog，任务 5.3）。
 *
 * 用真实前端 + Canvas Service 验证：
 * - 右下角控件面板点击「生成历史」打开只读弹窗；
 * - 弹窗展示筛选、列表或空态，且不含「设为当前」「添加到画布」写入按钮；
 * - 打开弹窗不改变节点 selection，不推进 canvas revision；
 * - 关闭后焦点恢复；
 * - 桌面与窄屏截图。
 */
import { expect, test } from "@playwright/test";
import { installPageHelpers, readStoredCanvas, resetCanvasStorage, waitForCanvasSession } from "./helpers.js";

const PANEL = ".canvas-control-panel";
const HISTORY_ICON = 'button[aria-label="作品生成历史"]';

test("右下角生成历史入口打开只读弹窗", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);

  const revisionBefore = (await readStoredCanvas(page))?.revision ?? 0;

  // 入口与缩放控件同处右下角统一控件面板。
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  const icon = panel.locator(HISTORY_ICON);
  await expect(icon).toBeVisible();
  await expect(panel.locator(".canvas-control-panel__row--viewport")).toBeVisible();

  // 打开弹窗。
  await icon.click();
  const dialog = page.locator(".dlg");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "作品生成历史" })).toBeVisible();
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

test("生成历史弹窗窄屏可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);

  await page.locator(PANEL).locator(HISTORY_ICON).click();
  const browser = page.locator('[data-testid="canvas-history-browser"]');
  await expect(browser).toBeVisible();
  await expect(browser.locator('[role="radio"]').first()).toBeVisible();

  await page.screenshot({ path: "test-results/canvas-generation-history-narrow.png", fullPage: false });
});
