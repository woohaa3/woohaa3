/**
 * 画布内设置 · 扩展层级导航 E2E
 * （change: 2026-10-17-move-settings-into-canvas-dialog 起；2026-10-28 扩展层级导航）
 *
 * 设置不再是 `/settings` 独立页，而是画布壳内的一张大型弹窗：
 * - 旧 `/settings` 仍可用，解析为 Canvas + 一次性打开意图（地址被 replace 规范化）；
 * - 左栏永远是右栏内容的父级：分区 → 插件列表 → 插件子页；
 * - 点插件在同一弹窗从插件列表进入概览，再进「配置 / 模型 / 管理」，不叠加第二张弹窗；
 * - 配置项、模型与扩展面板都在子页里（同一份权威状态）；
 * - 停用态显式说明「保存后要等启用才生效」，hot 项也不许再标「即时生效」。
 *
 * 右栏正文是唯一滚动容器：Ark 有十几个配置项，滚不动就等于后面的项看不到。
 */
import { expect, test } from "./review-browser.js";
/** 打开画布内设置（支持从旧地址进入与从画布入口进入）。 */
async function openSettings(page: import("@playwright/test").Page, fromLegacyPath = true) {
  await page.goto(fromLegacyPath ? "/settings" : "/");
  await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible({ timeout: 60_000 });
}

test.describe("画布内设置 · 插件详情", () => {
  test("旧 /settings 进入画布设置弹窗，地址被替换为规范 Canvas 地址", async ({ page }) => {
    await openSettings(page);
    // 兼容地址规范化：URL 不再有 /settings。
    await expect(page).not.toHaveURL(/\/settings$/);
    // 三个分区都在同一弹窗左栏；关闭按钮固定在 Header。
    await expect(page.locator('[data-testid="settings-nav-backend"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-nav-backend"]')).toHaveText("核心服务");
    await expect(page.locator('[data-testid="settings-nav-plugins"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-nav-appearance"]')).toBeVisible();
    await expect(page.locator('[aria-label="关闭设置"]')).toBeVisible();
    // 核心服务按服务分页签：有宿主配置的有存储 / 遥测，被 Provider 影响的生成也出现。
    await expect(page.locator('[data-testid="host-service-tabs"]')).toBeVisible();
    await expect(page.locator('[data-testid="host-service-tab-storage"]')).toBeVisible();
    await expect(page.locator('[data-testid="host-service-tab-telemetry"]')).toBeVisible();
    await expect(page.locator('[data-testid="host-service-tab-generation"]')).toBeVisible();
    // 静态远端同步配置已移除，画布服务不再有宿主级配置；不配置也不被插件影响的服务不出现页签。
    await expect(page.locator('[data-testid="host-service-tab-canvas"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="host-service-tab-task"]')).toHaveCount(0);

    // 生成页签汇总 Provider 插件：至少一个 Provider 可直达配置。
    await page.locator('[data-testid="host-service-tab-generation"]').click();
    await expect(page.locator('[data-testid="generation-providers"]')).toBeVisible();
    await expect(page.locator('[data-testid^="generation-provider-open-"]').first()).toBeVisible();
  });

  test("点卡片在同一弹窗进入层级：列表 → 概览 → 配置，只有一张弹窗", async ({ page }) => {
    await openSettings(page);

    // 「插件配置」按分层归组：这里只断言扩展插件节的行（内置插件节取决于部署目录）。
    await page.locator('[data-testid="settings-nav-plugins"]').click();
    await expect(page.getByRole("heading", { name: "插件配置" })).toBeVisible();
    // 行自带权威启停状态（站点插件行）。
    await expect(page.locator('[data-testid^="settings-plugin-switch-"]').first()).toBeVisible();

    await page.locator('[data-testid^="settings-plugin-open-"]').first().click();

    // L2：左栏换成插件列表（分区导航让位给父级），右栏是概览，仍是一张弹窗。
    await expect(page.locator('[data-testid="plugin-rail-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-nav-backend"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="settings-breadcrumbs"]')).toContainText("插件配置");

    // 概览不直接摊开长表单，而是给下一级入口；进入配置后才有配置项。
    await page.locator('[data-testid="plugin-entry-config"]').click();
    await expect(page.locator('[data-testid^="plugin-page-nav-"]')).toBeVisible();
    await expect(page.locator('[data-setting-key]').first()).toBeVisible();

    // 返回插件列表：同一实例，左栏仍是那份列表。
    await page.locator('[data-testid="plugin-page-back"]').click();
    await expect(page.locator('[data-testid="plugin-rail-list"]')).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);

    // 再返回一级回到分区导航。
    await page.locator('[data-testid="plugin-rail-back"]').click();
    await expect(page.locator('[data-testid="settings-nav-backend"]')).toBeVisible();
  });

  test("未保存草稿的关闭被保护：Escape 先确认，继续编辑保留输入", async ({ page }) => {
    // change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2：所有关闭来源共用 guard。
    await openSettings(page);
    // 核心服务 · 遥测里填一个未保存的值（不点保存）。
    await page.locator('[data-testid="host-service-tab-telemetry"]').click();
    const firstInput = page.locator('[data-testid="setting-input-telemetry.local.retentionDays"]');
    await expect(firstInput).toBeVisible();
    await firstInput.fill("9");

    await page.keyboard.press("Escape");
    // 出现共享 AlertDialog 的「继续编辑 / 放弃修改」。
    await expect(page.getByRole("button", { name: "继续编辑" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑" }).click();

    // 设置仍在，输入未丢。
    await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible();
    await expect(firstInput).toHaveValue("9");
  });

  test("右栏正文自己滚动：长配置能滚到（标题与左栏保持可见）", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-plugins"]').click();
    // 选一个在当前部署里确实可打开的插件（有配置项的 Provider），进「配置」页。
    await page.locator('[data-testid^="settings-plugin-open-"]').first().click();
    const entry = page.locator('[data-testid="plugin-entry-config"]');
    if (await entry.count()) {
      await entry.click();
    } else {
      // 这个插件没有配置项时退到模型页，仍然验证长列表能滚。
      await page.locator('[data-testid="plugin-page-models"]').click();
    }

    // 长列表按项渲染；验证最后一项能滚进视口。
    const rows = page.locator('[data-setting-key], [data-testid^="plugin-config-models-"] > li');
    const last = rows.last();
    await expect(last).toHaveCount(1);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();

    // 关闭与左栏仍在视口内（不是整页滚动把 chrome 推走）。
    await expect(page.locator('[aria-label="关闭设置"]')).toBeInViewport();
    await expect(page.locator('[data-testid="plugin-rail-list"], [data-testid^="plugin-page-nav-"]')).toBeVisible();
  });
});
  test("安装入口是右下角悬浮 +，进入独立的「添加扩展」页", async ({ page }) => {
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-plugins"]').click();
    // 顶部不再常驻「从文件安装 / 从市场安装」两个按钮。
    await expect(page.locator('[data-testid="plugin-install-market"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="plugin-install-file"]')).toHaveCount(0);

    const fab = page.locator('[data-testid="plugin-install-open"]');
    await expect(fab).toBeVisible();
    await fab.click();

    await expect(page.locator('[data-testid="plugin-install-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-breadcrumbs"]')).toContainText("添加扩展");
    // 同层页：左栏仍是插件列表（父级），不是分区导航。
    await expect(page.locator('[data-testid="plugin-rail-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-nav-plugins"]')).toHaveCount(0);

    // 返回一级页。
    await page.locator('[data-testid="plugin-rail-back"]').click();
    await expect(page.locator('[data-testid="plugin-settings"]')).toBeVisible();
  });
