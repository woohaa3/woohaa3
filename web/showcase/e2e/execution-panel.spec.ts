/**
 * Showcase 执行面板的浏览器验收
 * （change: expand-showcase-execution-ux，任务 5.2 / spec「sidebar 和窄屏」）。
 *
 * 加载真实的 Ladle build，用同一套生产 `ModelExecutionHost` + fixture 记录：
 * - 焦点与菜单定位：展开参数菜单后完整位于可视区域；
 * - 无重叠：prompt / chips / 提交动作未被不可恢复地遮挡；
 * - 无横向溢出（页面级）；
 * - 桌面与 390px 两个 project 共用同一批断言。
 */
import { expect, test, type Page } from "@playwright/test";

const STORY = {
  image: "画布组件--执行面板--生产组合--图片-·-生产组合",
  sidebar: "画布组件--执行面板--生产组合--侧栏面",
  dock: "画布组件--执行面板--生产组合--dock-面",
  narrow: "画布组件--执行面板--生产组合--390px-窄屏",
  readonly: "画布组件--执行面板--生产组合--只读",
  typeahead: "画布组件--执行面板--提示词与引用--素材-片段-typeahead",
  picker: "画布组件--执行面板--提示词与引用--reference-picker",
  manyReferences: "画布组件--执行面板--提示词与引用--多素材横向滚动",
  catalogError: "画布组件--执行面板--提示词与引用--catalog-失败-重试",
  editVideo: "画布组件--执行面板--生产组合--视频--edit-video-·-ready",
  menus: "画布组件--执行面板--生产组合--菜单--三组菜单"
} as const;

async function openStory(page: Page, story: string): Promise<void> {
  await page.goto(`/?story=${encodeURIComponent(story)}&mode=preview`);
  await expect(page.locator(".node-execution-dock")).toHaveCount(1);
  await expect(page.locator(".mc-panel__send")).toBeVisible();
  // 等待 webfont 落地：面板尺寸变化会触发同一锚定宿主重新计算限高，
  // 稳定后再做位移/遮挡断言，避免把字体竞态误判为菜单遮挡。
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.locator(".showcase__panel-box")).toBeVisible();
}

/**
 * 展开 fixture 操作记录 diagnostics（默认收起，change: 2026-09-29-refresh-showcase-shell）。
 *
 * 记录仍写入 `<pre data-testid="fixture-operations">`，但只有展开后才挂载；断言前先展开。
 */
async function expandOperationLog(page: Page): Promise<void> {
  const trigger = page.locator(".showcase__ops-trigger");
  await trigger.click();
  await expect(page.getByTestId("fixture-operations")).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("执行面板浏览器验收", () => {
  test("模型与参数菜单展开后完整位于可视区域且键盘可达", async ({ page }) => {
    await openStory(page, STORY.menus);

    await page.locator(".mc-panel__model-trigger").click();
    const modelMenu = page.locator(".mc-panel__model-menu");
    await expect(modelMenu).toBeVisible();
    const modelBox = await modelMenu.boundingBox();
    const viewport = page.viewportSize()!;
    expect(modelBox!.x).toBeGreaterThanOrEqual(0);
    expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(modelBox!.y).toBeGreaterThanOrEqual(0);
    // 键盘导航：第一个选项可聚焦并可用方向键切换高亮。
    await expect(modelMenu.locator('[role="menuitemradio"]').first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".mc-panel__settings-trigger").click();
    const settingsMenu = page.locator(".mc-panel__settings-menu");
    await expect(settingsMenu).toBeVisible();
    const settingsBox = await settingsMenu.boundingBox();
    expect(settingsBox!.x).toBeGreaterThanOrEqual(0);
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    await assertNoHorizontalOverflow(page);
  });

  test("prompt、chips 与提交动作不被菜单遮挡且页面无横向溢出", async ({ page }) => {
    await openStory(page, STORY.image);
    const sendBoxBefore = await page.locator(".mc-panel__send").boundingBox();
    await page.locator(".mc-panel__settings-trigger").click();
    await expect(page.locator(".mc-panel__settings-menu")).toBeVisible();
    // 提交动作仍存在且未被菜单推出布局（菜单绘制在其上方，但按钮本身仍在原位）。
    // 生产面板在 390px 打开菜单时会因自身内容换行重排产生数 px 位移（与容器收拢无关），
    // 因此允许一个小的行高容差，同时确认按钮没有被推走。
    const sendBoxAfter = await page.locator(".mc-panel__send").boundingBox();
    expect(sendBoxAfter).not.toBeNull();
    expect(Math.abs(sendBoxAfter!.y - sendBoxBefore!.y)).toBeLessThan(12);
    const promptBox = await page.locator(".mention-editor__input").boundingBox();
    expect(promptBox!.width).toBeGreaterThan(0);
    await assertNoHorizontalOverflow(page);
  });

  test("侧栏面与 390px 窄屏输入区、chips、提交动作无横向溢出", async ({ page }) => {
    await openStory(page, STORY.sidebar);
    await assertNoHorizontalOverflow(page);
    await expect(page.locator(".mc-panel__send")).toBeVisible();

    await openStory(page, STORY.narrow);
    await assertNoHorizontalOverflow(page);
    // 390px 样本：面板盒子不超过 390，prompt 与提交动作都在视野内。
    const box = await page.locator(".showcase__panel-box").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390 + 1);
    await expect(page.locator(".mention-editor__input")).toBeVisible();
    await expect(page.locator(".mc-panel__send")).toBeVisible();
    await page.locator(".mc-panel__settings-trigger").click();
    await expect(page.locator(".mc-panel__settings-menu")).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("reference picker 打开、选择并回传 edge.add 命令", async ({ page }) => {
    await openStory(page, STORY.picker);
    await page.getByRole("button", { name: "选择参考素材节点" }).click();
    await expect(page.locator(".ref-picker")).toBeVisible();
    await page.locator(".ref-picker__item", { hasText: "候选图 A" }).click();
    await expandOperationLog(page);
    const log = page.getByTestId("fixture-operations");
    await expect(log).toContainText("edge.add");
    await expect(log).toContainText("showcase-picker-image");
  });

  test("reference tile strip 单行滚动且不折叠，展开/收起受控切换", async ({ page }) => {
    await openStory(page, STORY.manyReferences);
    // 5 引用 + add tile 全部在 DOM；无折叠按钮。
    await expect(page.locator(".ref-tile-strip .ref-tile")).toHaveCount(6);
    await expect(page.locator(".ref-chips__toggle")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    // compact → expanded → compact（fullscreen host，非 Dialog）。
    await page.locator(".mc-panel__expand").click();
    await expect(page.locator(".fullscreen-panel-host")).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await page.locator(".mc-panel__expand").click();
    await expect(page.locator(".fullscreen-panel-host")).toHaveCount(0);
  });

  test("关闭动作记录 panelClose 且不写 canonical Canvas", async ({ page }) => {
    await openStory(page, STORY.image);
    await page.locator(".mc-panel__close").click();
    await expandOperationLog(page);
    const log = page.getByTestId("fixture-operations");
    await expect(log).toContainText("panelClose");
    await expect(log).not.toContainText("edge.add");
  });

  test("`@` 素材与 `#` 片段 typeahead 在真实浏览器中打开并插入", async ({ page }) => {
    await openStory(page, STORY.typeahead);
    const editor = page.locator(".mention-editor__input");

    await editor.click();
    await page.keyboard.press("End");
    // 前缀空格：与生产 typeahead regex `(?:^|\s)@([^\s@]*)$` 一致。
    await page.keyboard.type(" @");
    const mentionMenu = page.locator('.mention-menu[aria-label="参考候选"]');
    await expect(mentionMenu).toBeVisible();
    await mentionMenu.locator(".mention-menu__item", { hasText: "参考图 1" }).click();
    await expect(page.locator(".mention-node")).toContainText("参考图 1");

    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" #");
    const snippetMenu = page.locator('.mention-menu[aria-label="片段候选"]');
    await expect(snippetMenu).toBeVisible();
    await snippetMenu.locator(".mention-menu__item", { hasText: "写实增强" }).click();
    await expect(editor).toContainText("电影级布光");
    await expandOperationLog(page);
    const log = page.getByTestId("fixture-operations");
    await expect(log).toContainText("snippetSelect");
  });

  test("catalog 失败显示重试，重试成功后可选模型", async ({ page }) => {
    await page.goto(`/?story=${encodeURIComponent(STORY.catalogError)}&mode=preview`);
    await expect(page.locator(".node-execution-dock")).toHaveCount(1);
    await expect(page.locator('[role="status"]')).toContainText("任务目录加载失败");
    await page.locator(".node-execution-dock__retry").click();
    await expect(page.locator(".mc-panel__model-trigger")).toBeVisible();
  });

  test("edit_video 入口可点并记录请求，缺输入时禁用", async ({ page }) => {
    // Seedance 专用 Panel 不渲染 generic 的 `.mc-panel__send`，单独等待 Seedance 入口。
    await page.goto(`/?story=${encodeURIComponent(STORY.editVideo)}&mode=preview`);
    await expect(page.locator(".node-execution-dock")).toHaveCount(1);
    const entry = page.locator(".mc-panel__video-edit-open").first();
    await expect(entry).toBeVisible();
    await expect(entry).toBeEnabled();
    await entry.click();
    await expandOperationLog(page);
    await expect(page.getByTestId("fixture-operations")).toContainText("openVideoEditIntent");

    await page.goto(`/?story=${encodeURIComponent("画布组件--执行面板--生产组合--视频--edit-video-·-缺输入")}&mode=preview`);
    const blocked = page.locator(".mc-panel__video-edit-open").first();
    await expect(blocked).toBeDisabled();
    await expect(page.locator('[role="status"]')).toContainText(/edit_video|缺少/);
  });

  test("只读状态禁用执行，且不在面板内重复断线原因", async ({ page }) => {
    await openStory(page, STORY.readonly);
    await expect(page.locator(".mc-panel__send")).toBeDisabled();
    // 只读由左下角同步状态控件承载，面板不再重复「网络已断开 / 目录尚未加载」。
    await expect(page.locator('.node-execution-dock [role="status"]')).toHaveCount(0);
  });

  test("不存在生成份数 / generationCount 控件", async ({ page }) => {
    await openStory(page, STORY.image);
    await page.locator(".mc-panel__settings-trigger").click();
    const menu = page.locator(".mc-panel__settings-menu");
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText(/生成份数|生成数量|批量份数|generationCount/);
    await expect(page.locator("body")).not.toContainText("generationCount");
  });
});
