/**
 * 设置「通知」分区 E2E（change: 2026-10-17-move-settings-into-canvas-dialog）
 *
 * 断言（浏览器语义）：
 * - 设置弹窗是四分区：核心服务 / 插件配置 / 外观 / 通知；
 * - 通知分区说明「仅后台提醒」，成功/失败默认开；
 * - Web 只有标题渠道，不出现系统通知与测试按钮（不伪装平台能力）；
 * - 开关是本地偏好，立即生效且没有保存按钮；
 * - 偏好写入独立键，不写宿主共享配置。
 */
import { expect, test } from "./review-browser.js";
async function openNotifications(page: import("@playwright/test").Page) {
  await page.goto("/settings");
  await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="settings-nav-notifications"]').click();
  await expect(page.locator('[data-testid="notification-settings"]')).toBeVisible();
}

test.describe("画布内设置 · 通知分区", () => {
  test("四分区导航，通知与外观同级", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible({ timeout: 60_000 });
    for (const id of ["backend", "plugins", "appearance", "notifications"]) {
      await expect(page.locator(`[data-testid="settings-nav-${id}"]`)).toBeVisible();
    }
  });

  test("Web 语义：成功/失败默认开 + 标题渠道，无系统通知与测试按钮", async ({ page }) => {
    await openNotifications(page);
    await expect(page.locator('[data-testid="notification-settings-hint"]')).toContainText("仅在应用处于后台时提醒");
    await expect(page.locator('[data-testid="notification-category-succeeded"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-testid="notification-category-failed"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-testid="notification-channel-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="notification-channel-system"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="notification-send-test"]')).toHaveCount(0);
  });

  test("开关即时生效、无保存按钮，写入独立偏好键而非宿主配置", async ({ page }) => {
    await openNotifications(page);
    const toggle = page.locator('[data-testid="notification-category-succeeded"]');
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // 没有逐项保存按钮（通知偏好不是配置草稿）。
    await expect(page.locator('[data-testid^="setting-save-"]')).toHaveCount(0);

    // 偏好写进版本化独立键：`woohaa:task-notifications:v1|<instance>|<basePath>|<dataScope>`。
    // 键里带挂载路径与数据范围，因此同源不同 worktree 挂载互不串扰；不含任何任务内容。
    const keys = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith("woohaa:task-notifications:v1|"))
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]!.split("|")).toHaveLength(4);
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), keys[0]!);
    expect(raw).toContain('"succeeded":false');
    // 不写宿主共享配置端点（该端点由后端文件承载，浏览器本地不应出现）。
    expect(raw).not.toContain("api/settings");

    // 关闭再打开仍是保存值（关闭设置不影响 App 级偏好）。
    // 无 GPU 环境不等待画布控件渲染，直接经兼容地址重新打开同一设置实例。
    await page.locator('[aria-label="关闭设置"]').click();
    await expect(page.locator('[data-testid="settings-workspace"]')).toHaveCount(0);
    await page.goto("/settings");
    await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('[data-testid="settings-nav-notifications"]').click();
    await expect(page.locator('[data-testid="notification-category-succeeded"]')).toHaveAttribute("aria-checked", "false");

    // 复原，避免影响其它用例。
    await page.locator('[data-testid="notification-category-succeeded"]').click();
  });
});
