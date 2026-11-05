/**
 * Showcase 壳层浏览器验收
 * （change: 2026-09-29-refresh-showcase-shell，任务 5.1）。
 *
 * 在真实 Ladle build 里验证：
 * - 紧凑品牌工具栏与 story header 层级；
 * - theme segmented control 键盘切换 default/sentinel，story 状态不重置；
 * - fixture 操作记录默认收起、计数更新、可键盘展开并保留稳定 JSON/test id；
 * - 生产 `.node-execution-dock` 使用虚拟节点锚点，并完全收拢在 `.showcase__panel-box` 内；
 * - 桌面与 390px 均无页面级横向溢出。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "../../../e2e/review-browser.js";
const IMAGE_STORY = "画布组件--执行面板--生产组合--图片-·-生产组合";
const SIDEBAR_STORY = "画布组件--执行面板--生产组合--侧栏面";
const NARROW_STORY = "画布组件--执行面板--生产组合--390px-窄屏";
const WINDOW_STORY = "画布组件--弹窗--基础--标准-md";

async function openStory(page: Page, story: string, dockCount = 1): Promise<void> {
  await page.goto(`/?story=${encodeURIComponent(story)}&mode=preview`);
  await expect(page.locator(".node-execution-dock")).toHaveCount(dockCount);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("Showcase 壳层", () => {
  test("工具栏与 story header 呈现品牌、标题与生产身份", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    await expect(page.locator(".showcase__toolbar")).toBeVisible();
    await expect(page.locator(".showcase__brand-name")).toHaveText("Woohaa Component Lab");

    const title = page.locator("h1.showcase__story-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("图片 · 生产组合");
    await expect(page.locator(".showcase__story-meta")).toContainText("ModelExecutionHost");
  });

  test("theme segmented control 键盘切换暗色且不重置 story", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const root = page.locator(".app-theme-root");
    await expect(root).toHaveAttribute("data-theme-id", "default");

    const group = page.locator(".showcase__theme-toggle");
    // Roving focus：Tab 进入 radiogroup，方向键选择项，Enter/Space 激活。
    await group.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "暗色主题" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(root).toHaveAttribute("data-theme-id", "dark");
    await expect(page.getByRole("radio", { name: "暗色主题" })).toHaveAttribute("aria-checked", "true");

    // story 生产组件仍在，没有被主题切换重置或卸载。
    await expect(page.locator(".node-execution-dock")).toHaveCount(1);
    await expect(page.locator(".mc-panel__send")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("再次激活当前主题不会取消到无主题", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const root = page.locator(".app-theme-root");
    const sentinel = page.getByRole("radio", { name: "哨兵主题" });
    await sentinel.click();
    await expect(root).toHaveAttribute("data-theme-id", "sentinel");
    await sentinel.click();
    await expect(root).toHaveAttribute("data-theme-id", "sentinel");
    await expect(page.locator('.showcase__theme-option[aria-checked="true"]')).toHaveCount(1);
  });
});

test.describe("fixture 操作记录 diagnostics", () => {
  test("默认收起、Enter 展开并保留稳定 JSON 与 data-count", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const trigger = page.locator(".showcase__ops-trigger");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("fixture-operations")).toHaveCount(0);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const pre = page.getByTestId("fixture-operations");
    await expect(pre).toBeVisible();
    await expect(pre).toHaveAttribute("data-count", "0");
  });

  test("收起期间产生事件只更新计数，不展开也不抢焦点", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const trigger = page.locator(".showcase__ops-trigger");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await page.locator(".mc-panel__close").click();
    await expect(page.getByTestId("fixture-operations-count")).toContainText("1 条");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("fixture-operations")).toHaveCount(0);
  });
});

test.describe("fixed surface containment", () => {
  test("生产锚定 dock 位于虚拟节点下方并保持在可用舞台内", async ({ page }) => {
    await openStory(page, "画布组件--执行面板--生产组合--锚点-·-下方");
    const box = await page.locator(".showcase__panel-box").boundingBox();
    const dock = await page.locator(".showcase__panel-box > .node-execution-dock").boundingBox();
    expect(box).not.toBeNull();
    expect(dock).not.toBeNull();
    await expect(page.locator(".node-execution-dock")).toHaveAttribute("data-placement", "below");

    // dock 收拢在舞台边界内（允许 1px 亚像素误差）。
    expect(dock!.x).toBeGreaterThanOrEqual(box!.x - 1);
    expect(dock!.x + dock!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
    // 页面里只有一个 dock，且 Ladle sidebar 未被遮挡。
    await expect(page.locator(".node-execution-dock")).toHaveCount(1);
  });

  test("Pad 正常窗口尺寸下锚点面板仍收拢在舞台内", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openStory(page, "画布组件--执行面板--生产组合--锚点-·-下方");
    const box = await page.locator(".showcase__panel-box").boundingBox();
    const dock = await page.locator(".showcase__panel-box > .node-execution-dock").boundingBox();
    expect(dock!.x).toBeGreaterThanOrEqual(box!.x);
    expect(dock!.x + dock!.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(box!.y + box!.height);
  });

  test("舞台节点下方空间不足时只压缩高度，仍保持在节点下方", async ({ page }) => {
    await openStory(page, "画布组件--执行面板--生产组合--锚点-·-下方空间不足");
    await expect(page.locator(".node-execution-dock")).toHaveAttribute("data-placement", "below");
    const box = await page.locator(".showcase__panel-box").boundingBox();
    const dock = await page.locator(".node-execution-dock").boundingBox();
    expect(dock!.y).toBeGreaterThanOrEqual(box!.y - 1);
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
  });

  test("离屏或缺少锚点时隐藏面板", async ({ page }) => {
    await openStory(page, "画布组件--执行面板--生产组合--锚点-·-离屏与未就绪", 2);
    await expect(page.locator(".node-execution-dock")).toHaveCount(2);
    for (const dock of await page.locator(".node-execution-dock").all()) await expect(dock).toBeHidden();
  });

  test("骨架替换为真实内容时复用同一锚定位置", async ({ page }) => {
    await openStory(page, "画布组件--执行面板--生产组合--锚点-·-骨架替换");
    const dock = page.locator(".node-execution-dock");
    await expect(page.locator(".authoring-generate-placeholder")).toBeVisible();
    const before = await dock.boundingBox();
    await expect(page.locator(".showcase__anchor-real-content")).toBeVisible();
    const after = await dock.boundingBox();
    expect(await dock.getAttribute("data-placement")).toBe("below");
    expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  });

  test("sidebar 面 dock 收拢在窄舞台内且无横向溢出", async ({ page }) => {
    await openStory(page, SIDEBAR_STORY);
    const box = await page.locator(".showcase__panel-box").boundingBox();
    const dock = await page.locator(".showcase__panel-box > .node-execution-dock").boundingBox();
    expect(dock!.x).toBeGreaterThanOrEqual(box!.x - 1);
    expect(dock!.x + dock!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("自有侧栏导航", () => {
  test("渲染分组与叶子，当前 story 高亮，切换 story 更新 URL", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const sidebar = page.locator(".showcase__sidebar");
    await expect(sidebar).toBeVisible();
    // Ladle 自带侧栏不再渲染。
    await expect(page.locator(".ladle-aside")).toHaveCount(0);

    // 当前路径自动展开；叶子高亮并带 aria-current。
    const active = sidebar.locator(".showcase__tree-item[data-active]");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("aria-current", "page");
    await expect(active).toHaveText("图片 · 生产组合");

    // 点击另一个分组下的叶子 → URL 与内容切换（分组名精确匹配，避开「生成历史弹窗」）。
    await sidebar.getByRole("button", { name: "弹窗", exact: true }).click();
    await sidebar.getByRole("button", { name: "基础", exact: true }).click();
    await sidebar.getByRole("link", { name: "标准 md", exact: true }).click();
    await expect(page).toHaveURL(/story=/);
    await expect(page.locator(".dlg__header")).toBeVisible();
  });

  test("搜索过滤并按名称收敛", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    const search = page.getByRole("searchbox", { name: "搜索 story" });
    await search.fill("多镜头切换");
    const leaves = page.locator(".showcase__tree-item");
    await expect(leaves).toHaveCount(1);
    await expect(leaves.first()).toHaveText("多镜头切换");
    // 清除后恢复完整树。
    await search.fill("");
    await expect(page.locator(".showcase__tree-item").first()).toBeVisible();
  });

  test("工具栏开关可收起/展开侧栏且不产生横向溢出", async ({ page }) => {
    await openStory(page, IMAGE_STORY);
    await page.getByRole("button", { name: "收起组件导航" }).click();
    await expect(page.locator(".showcase__sidebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "展开组件导航" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "展开组件导航" }).click();
    await expect(page.locator(".showcase__sidebar")).toHaveCount(1);
  });

  test("无 ?story 时落地到默认 story 并渲染内容", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".showcase__sidebar")).toBeVisible();
    await expect(page.locator(".showcase__tree-item[data-active]")).toHaveCount(1);
    await expect(page.locator(".showcase__content > *")).not.toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("移动端侧栏：可进入、可选中、不横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator(".showcase__sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: "展开组件导航" }).click();
    const sidebar = page.locator(".showcase__sidebar");
    // 默认 story 由 Ladle 选择，可能位于「画布组件」之外的组；先展开该组再进入弹窗。
    const dialogGroup = sidebar.getByRole("button", { name: "弹窗", exact: true });
    if (!(await dialogGroup.isVisible())) {
      await sidebar.getByRole("button", { name: "画布组件", exact: true }).click();
    }
    await dialogGroup.click();
    await sidebar.getByRole("button", { name: "基础", exact: true }).click();
    await sidebar.getByRole("link", { name: "标准 md", exact: true }).click();
    await expect(page.locator(".dlg__header")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("390px 壳层", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("窄屏默认收起侧栏；工具栏、舞台与 diagnostics 可达且无横向溢出", async ({ page }) => {
    await openStory(page, NARROW_STORY);
    // 窄屏默认不显示侧栏，避免挤压 story 内容。
    await expect(page.locator(".showcase__sidebar")).toHaveCount(0);
    await expect(page.locator(".showcase__brand-name")).toBeVisible();
    await expect(page.locator(".showcase__theme-toggle")).toBeVisible();
    await expect(page.locator("h1.showcase__story-title")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const box = await page.locator(".showcase__panel-box").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390 + 1);

    const trigger = page.locator(".showcase__ops-trigger");
    await trigger.click();
    await expect(page.getByTestId("fixture-operations")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
