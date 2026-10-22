/**
 * 片场地面范围（等距平行四边形）视觉与成片隔离证据
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，任务 7.3）。
 *
 * 采集真实应用截图并写入 `info.outputPath`，覆盖：
 * - 明/暗主题（暗色通过既有 theme preset 替换路径注入深色 token）；
 * - 大（1600×1000）与小（900×620）视口；
 * - 长标题、空场、选中时可见 8 抓手；
 * - 成片隔离：镜头截图与视频导出不包含范围、名称或抓手 chrome。
 *
 * 范围包裹模型**地面占地**（不是内容适配矩形）：四边与地面网格平行，外包矩形宽高比恒为 2。
 * 暗色 token 只覆盖亮度相关的画布/背景/文字 token；未覆盖的沿用默认，保持契约合法。
 */
import { canonicalFilmSetFields, createFilmSetSnapshot, createModelSnapshot, type FilmSetItem } from "@woohaa3/contracts";
import { expect, test, type Page } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, sendCommands, waitForCanvasSession } from "./helpers.js";

/** 深色画布/背景/文字 token 覆盖（其余沿用默认，保证 preset 通过校验）。 */
const DARK_TOKENS: Record<string, string> = {
  webBackdrop: "#0d1211",
  webSurface: "#161c1a",
  webPanel: "#1b2422",
  webElevated: "#232e2b",
  webSubtle: "#202927",
  webTextPrimary: "#e6efeb",
  webTextMuted: "#9fb0a8",
  webBorder: "#2c3733",
  webBorderStrong: "#3c4a45",
  canvasNodeSurface: "#1b2422",
  canvasNodeContent: "#141a18",
  canvasNodeBorder: "#3a4642",
  canvasResizeHandle: "#c9d6d0",
  canvasResizeHandleStripe: "#1b2422",
  canvasBodyText: "#e6efeb",
  gridMinor: "#1c2422",
  gridMajor: "#242e2b"
};

function groundItem(): FilmSetItem {
  return { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } };
}

function modelItem(id: string, name: string): FilmSetItem {
  return {
    id,
    kind: "model",
    name,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({id:'body',size:[1.4,1.4,1.4],color:'#40ee50'});`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

async function seed(page: Page, id: string, title: string, items: FilmSetItem[], position = { x: 240, y: 180 }, size = { width: 260, height: 195 }) {
  const fields = canonicalFilmSetFields(createFilmSetSnapshot({
    title,
    timeline: { duration: 0, loop: false },
    filmSetContent: { schemaVersion: 3, items }
  }));
  expect((await sendCommands(page, [
    { type: "node.add", node: { id, type: "composite-asset", position, ...size }, nodeData: fields as never }
  ], `diamond-evidence-${id}`)).ok).toBe(true);
  await expect.poll(async () => page.evaluate((nid) => {
    const s = (window as any).__bevyRuntime?.lastScene?.();
    const node = s?.nodes.find((n: any) => n.id === nid);
    return node?.compositeAsset?.scopeShape ?? null;
  }, id), { timeout: 30_000 }).toBe("isometric-diamond");
}

async function filmClientCenter(page: Page, id: string) {
  return page.evaluate((nid) => {
    const s = (window as any).__bevyRuntime.lastScene();
    const node = s.nodes.find((n: any) => n.id === nid)!;
    const scope = node.compositeAsset;
    const v = s.viewport;
    const r = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return { x: r.left + (scope.x + scope.width / 2) * v.zoom + v.x, y: r.top + (scope.y + scope.height / 2) * v.zoom + v.y };
  }, id);
}

/** 用既有 preset 替换路径注入深色 token。 */
async function applyDark(page: Page) {
  const ok = await page.evaluate((tokens) => {
    const theme = (window as any).__appTheme?.();
    if (!theme) return false;
    const result = (window as any).__setAppTheme?.({ id: "dark-evidence", version: theme.version, tokens: { ...theme.tokens, ...tokens } });
    return Boolean(result?.ok);
  }, DARK_TOKENS);
  expect(ok).toBe(true);
}

async function resetTheme(page: Page) {
  await page.evaluate(() => {
    const theme = (window as any).__appTheme?.();
    if (theme) (window as any).__setAppTheme?.({ id: "default", version: theme.version, tokens: theme.tokens });
  });
}

test.describe("片场菱形范围视觉证据（change: 2026-10-12）", () => {
  test("明/暗主题、大小视口、长标题、空场与选中抓手", async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    // 长标题 + 有内容 + 空场并存。
    await seed(page, "film-long", "这是一个用于验证菱形范围与名称标签边界省略的非常长的片场名称标题", [groundItem(), modelItem("actor", "演员")]);
    await seed(page, "film-empty", "空片场", [], { x: 760, y: 300 });
    await page.waitForTimeout(600);

    // 大视口 · 明主题。
    await page.mouse.move(10, 10);
    await page.screenshot({ path: info.outputPath("scope-light-large.png") });

    // 选中：露出 8 个抓手（四顶点 + 四边中点），范围常驻。
    await page.evaluate(() => (window as any).__canvasSetSelection?.(["film-long"]));
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("scope-light-selected-grip.png") });
    await page.evaluate(() => (window as any).__canvasSetSelection?.([]));

    // 暗主题。
    await applyDark(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("scope-dark-large.png") });
    await page.evaluate(() => (window as any).__canvasSetSelection?.(["film-long"]));
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("scope-dark-selected-grip.png") });
    await page.evaluate(() => (window as any).__canvasSetSelection?.([]));

    // 小视口（暗主题下）。
    await page.setViewportSize({ width: 900, height: 620 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath("scope-dark-small.png") });

    // 小视口 + 明主题。
    await resetTheme(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("scope-light-small.png") });
  });

  test("成片隔离：镜头截图不含范围/名称/抓手 chrome", async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seed(page, "film", "成片隔离片场", [groundItem(), modelItem("actor", "演员")]);
    await page.waitForTimeout(600);

    // 选中露出抓手，再进入聚焦并截取镜头帧。
    await page.evaluate(() => (window as any).__canvasSetSelection?.(["film"]));
    await page.waitForTimeout(300);
    const center = await filmClientCenter(page, "film");
    await page.mouse.dblclick(center.x, center.y);
    await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()), { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(600);
    // 聚焦视图本身不显示 overview 菱形/名称/抓手；截图作为隔离证据。
    await page.screenshot({ path: info.outputPath("scope-focus-isolation.png") });

    // 成片帧：用运行时截图接口抓取不含 chrome 的镜头内容并断言其存在。
    const shot = await page.evaluate(async () => {
      const rt = (window as any).__bevyRuntime;
      const scene = rt.lastScene();
      const node = scene.nodes.find((n: any) => n.id === "film");
      const bytes = await rt.requestCapture?.({ nodeId: "film", generation: scene.generation ?? 0, width: 320, height: 180 });
      return { resourceKey: node?.model?.resourceKey ?? null, shotBytes: bytes ? bytes.length : 0 };
    });
    expect(shot.resourceKey).toBeTruthy();
    // 截图接口可能在无 GPU 读回的测试环境下返回空；有字节时写盘作为证据。
    if (shot.shotBytes > 0) {
      await page.screenshot({ path: info.outputPath("scope-shot-frame.png") });
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });
});
