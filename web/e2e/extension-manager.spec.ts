/**
 * 插件管理入口收敛 E2E
 * （change: 2026-10-16-consolidate-canvas-settings-entries；取代 add-frontend-plugin-manager 的
 *   Canvas 左下角弹窗入口；change: 2026-10-17-move-settings-into-canvas-dialog：管理面是画布内
 *   设置弹窗的「插件配置」，不再是独立页面）。
 *
 * 断言：画布左下角不再有「插件管理器」「Provider 凭据」入口，管理面在设置弹窗「插件配置」的卡片上；
 * 改动写入 browser-local 目标配置后，关闭设置并在下一次 Canvas 启动时按目标配置装配；重新启用可恢复。
 * 用例只验证 DOM chrome，不依赖 Bevy 渲染（无 GPU 环境不等待 `__bevyRuntime.isReady()`）。
 */
import { expect, test } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage } from "./helpers.js";

const PREF_KEY = "woohaa:frontend-extensions:v1";
const SETTINGS_ENTRY = 'button[aria-label="设置"]';
const MANAGER_ENTRY = 'button[aria-label="插件管理器"]';
const CREDENTIALS_ENTRY = 'button[aria-label="Provider 凭据"]';
const NODE_HISTORY_ACTION = 'button[aria-label="作品生成历史"]';
const PANEL = ".canvas-control-panel";

async function waitForShell(page: import("@playwright/test").Page) {
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 60_000 });
}

/** 从画布左下角「设置」进入画布内设置弹窗的「插件配置」。 */
async function openPluginSettings(page: import("@playwright/test").Page) {
  await page.locator(SETTINGS_ENTRY).click();
  await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible();
  await page.locator('[data-testid="settings-nav-plugins"]').click();
  await expect(page.locator('[data-plugin-section="此浏览器插件"]')).toBeVisible();
}

/**
 * 关闭设置并让新的 Canvas scope 按目标配置装配。
 *
 * 设置不再提供「回到画布并应用」：关闭弹窗不刷新页面，目录/功能改动在下一次启动生效
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D7）。
 */
async function closeSettingsAndReassemble(page: import("@playwright/test").Page) {
  await page.locator('[aria-label="关闭设置"]').click();
  await expect(page.locator('[data-testid="settings-workspace"]')).toHaveCount(0);
  await page.reload();
  await waitForShell(page);
}

test.describe("插件管理入口收敛", () => {
  test.beforeEach(async ({ page }) => {
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForShell(page);
  });

  test("画布不再有插件管理与凭据入口，管理面在设置页插件配置", async ({ page }) => {
    const panel = page.locator(PANEL);
    await expect(panel.locator(MANAGER_ENTRY)).toHaveCount(0);
    await expect(panel.locator(CREDENTIALS_ENTRY)).toHaveCount(0);
    await expect(panel.locator(SETTINGS_ENTRY)).toHaveCount(1);

    await openPluginSettings(page);
    // 浏览器功能插件（browser-local optional）在卡片网格里，开关挂在卡片上。
    await expect(page.locator('[data-testid="settings-plugin-node-history"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-plugin-switch-node-history"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-plugin-switch-task-activity"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-plugin-switch-prompt-snippets"]')).toBeVisible();
  });

  test("设置页关闭 optional → 回到画布应用 → contribution 消失并可恢复", async ({ page }) => {
    await expect(page.locator(NODE_HISTORY_ACTION)).toHaveCount(1);

    // 关闭 node-history：写入 browser-local 目标配置并出现待生效提示。
    await openPluginSettings(page);
    const toggle = page.locator('[data-testid="settings-plugin-switch-node-history"]');
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(page.locator('[data-testid="settings-plugins-pending"]')).toBeVisible();
    const pending = await page.evaluate((key) => window.localStorage.getItem(key), PREF_KEY);
    expect(pending).toContain('"node-history":false');

    // 撤销改动 → 待生效提示消失（目标状态与启动状态一致）。
    await toggle.click();
    await expect(page.locator('[data-testid="settings-plugins-pending"]')).toHaveCount(0);

    // 再次关闭并回到画布应用：新 Canvas scope 不再装配 node-history contribution。
    await toggle.click();
    await closeSettingsAndReassemble(page);
    await expect(page.locator(NODE_HISTORY_ACTION)).toHaveCount(0);

    // 重新启用并应用 → contribution 恢复。
    await openPluginSettings(page);
    await page.locator('[data-testid="settings-plugin-switch-node-history"]').click();
    await closeSettingsAndReassemble(page);
    await expect(page.locator(NODE_HISTORY_ACTION)).toHaveCount(1);
  });
});
