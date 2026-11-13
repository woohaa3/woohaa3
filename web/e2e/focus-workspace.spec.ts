import { createModel3DNodeData, model3DNodeDataFields } from "@woohaa3/contracts";
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { installPageHelpers, resetCanvasStorage, sendCommands, uploadMedia, waitForCanvasSession } from "./helpers.js";

async function createTargets(page: Page) {
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    const g = c.getContext("2d")!; g.fillStyle = "#286cb0"; g.fillRect(0, 0, 640, 480);
    g.fillStyle = "#f6d64e"; g.fillRect(80, 80, 240, 160);
    return [...new Uint8Array(await (await new Promise<Blob>(resolve => c.toBlob(blob => resolve(blob!), "image/png"))).arrayBuffer())];
  });
  const upload = await uploadMedia(page, png, "image/png");
  expect(upload.status).toBe(201);
  const key = String((upload.body as { storageKey: string }).storageKey);
  const result = await sendCommands(page, [
    { type: "asset.upsert", asset: { id: "focus-image-asset", title: "参考图片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: new Date().toISOString(), url: `/api/media/${key}`, metadata: { storageKey: key, checksum: key.slice(7), contentType: "image/png", size: png.length, width: 640, height: 480 } } },
    { type: "node.add", node: { id: "before", type: "text", position: { x: 0, y: 0 } }, nodeData: { title: "输入参考", text: "共享前序预览" } },
    { type: "node.add", node: { id: "after", type: "text", position: { x: 1000, y: 0 } }, nodeData: { title: "输出说明", text: "共享后序预览" } },
    { type: "node.add", node: { id: "focus-image", type: "image", position: { x: 240, y: 200 } } },
    { type: "node.add", node: { id: "focus-model", type: "model3d", position: { x: 620, y: 200 } }, nodeData: model3DNodeDataFields(createModel3DNodeData({ title: "设计模型", model: { modelScript: 'scene.box({id:"box",size:[1,2,1],position:[0,1,0],color:"#c06030"});', modelScriptVersion: "woohaa-model-js-v2" } })) }
  ], "focus-create");
  expect((await sendCommands(page, ["image", "model"].flatMap(kind => [
    { type: "edge.add" as const, edge: { id: `in-${kind}`, source: "before", target: `focus-${kind}` } },
    { type: "edge.add" as const, edge: { id: `out-${kind}`, source: `focus-${kind}`, target: "after" } }
  ]), "focus-edges")).ok).toBe(true);
  expect(result.ok).toBe(true);
  expect((await sendCommands(page, [{ type: "nodeData.patch", nodeId: "focus-image", value: { outputAssetId: "focus-image-asset", resourceKind: "image", taskStatus: "successed" } }], "focus-image-data")).ok).toBe(true);
  const seed = await page.request.post("/api/model-mcp/scripts", { data: { canvasId: "woohaa3-default-canvas", nodeId: "focus-model", source: 'scene.box({id:"box",size:[1,2,1],position:[0,1,0],color:"#286cb0"});', version: "woohaa-model-js-v2", requestId: "focus-model-seed" } });
  expect(seed.ok(), await seed.text()).toBe(true);
  const model = await page.request.post("/api/model-mcp/scripts", { data: { canvasId: "woohaa3-default-canvas", nodeId: "focus-model", source: 'scene.box({id:"box",size:[1,2,1],position:[0,1,0],color:"#c06030"});', version: "woohaa-model-js-v2", requestId: "focus-model-script" } });
  expect(model.ok(), await model.text()).toBe(true);
  await page.waitForFunction(() => (window as any).__canvasCanonical?.nodeData?.["focus-model"]?.modelScriptStatus === "ok");
}

async function assertNoOverlap(page: Page) {
  const result = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>(".app[data-focus-kind]")!;
    const css = getComputedStyle(app);
    const canvas = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    const content = { x: canvas.left + parseFloat(css.getPropertyValue("--focus-content-x")), y: canvas.top + parseFloat(css.getPropertyValue("--focus-content-y")), width: parseFloat(css.getPropertyValue("--focus-content-width")), height: parseFloat(css.getPropertyValue("--focus-content-height")) };
    const selectors = [".model-focus-chrome", ".focus-connections-header", ".photo-editor", ".model-editor-dock", ".node-history--drawer", ".focus-workspace__view-controls"];
    const overlaps = selectors.filter(selector => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || getComputedStyle(el).display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && Math.min(r.right, content.x + content.width) - Math.max(r.left, content.x) > 1 && Math.min(r.bottom, content.y + content.height) - Math.max(r.top, content.y) > 1;
    });
    return { content, overlaps, kind: app.dataset.focusKind, panel: app.dataset.focusPanel };
  });
  expect(result.content.width).toBeGreaterThan(100);
  expect(result.content.height).toBeGreaterThan(100);
  expect(result.overlaps).toEqual([]);
}

for (const width of [1440, 390]) {
  test(`图片与模型共享无重叠布局和历史返回（${width}px）`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page);
    await createTargets(page);
    for (const kind of ["image", "model"] as const) {
      const saved = await page.evaluate(() => (window as any).__canvasViewport());
      const before = await page.evaluate(() => JSON.stringify((window as any).__canvasCanonical.document.nodes));
      await page.evaluate(kind => (window as any).__canvasNavigation.enterNodeFocus({ nodeId: `focus-${kind}`, kind }), kind);
      await expect(page.locator(`.app[data-focus-kind="${kind}"]`)).toBeVisible();
      if (kind === "image") await page.waitForFunction(() => (window as any).__imageEditDebug?.().loaded);
      await page.waitForTimeout(700);
      await assertNoOverlap(page);
      await expect(page.locator('.model-focus-chrome [data-focus-connections="incoming"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "前序节点（1）", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "后序节点（1）", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "前序节点（1）", exact: true }).click();
      await page.locator(".focus-connections__list").getByRole("button", { name: "输入参考（text）" }).click();
      await expect(page.getByRole("group", { name: "输入参考 预览", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("group", { name: "输入参考 预览", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(`.app[data-focus-kind="${kind}"]`)).toBeVisible();
      if (kind === "model") {
        // 普通模型聚焦只保留 AI 修改与模型信息（change: 2026-10-18-simplify-model-focus-panel）：
        // 不出现镜头工具、镜头预览或截图，内容区仍不被右侧检查器遮挡。
        await expect(page.getByRole("button", { name: "添加镜头", exact: true })).toHaveCount(0);
              await expect(page.locator(".model-info")).toBeVisible();
        await assertNoOverlap(page);
      }
      await page.locator(".model-focus-history").click();
      await expect(page.locator('.app[data-focus-panel="history"]')).toBeVisible();
      await expect(page.locator(".node-history--drawer")).toBeVisible();
      await expect(page.locator(".focus-workspace__version")).toHaveText("当前版本");
      await assertNoOverlap(page);
      if (kind === "model") {
        await expect(page.locator(".model-editor-dock")).toBeHidden();
        await page.locator('.node-history__card[data-current="false"] .node-history__select').last().click();
        await expect(page.locator('.app[data-focus-owner="history"]')).toBeVisible();
              await assertNoOverlap(page);
        await page.locator(".node-history__list--current .node-history__select").click();
        await expect(page.locator('.app[data-focus-owner="direct"][data-focus-panel="history"]')).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath(`${kind}-${width}-history.png`) });
      await page.locator(".model-focus-history").click();
      await expect(page.locator('.app[data-focus-panel="history"]')).toHaveCount(0);
      await assertNoOverlap(page);
      await page.screenshot({ path: info.outputPath(`${kind}-${width}-tools.png`) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      await expect(page.locator(".app[data-focus-kind]")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__canvasViewport())).toEqual(saved);
      expect(await page.evaluate(() => JSON.stringify((window as any).__canvasCanonical.document.nodes))).toEqual(before);
    }
  });
}

for (const width of [1440, 390]) {
  test(`标题栏连接数量溢出与键盘预览（${width}px）`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page);
    await createTargets(page);
    const commands = Array.from({ length: 18 }, (_, i) => [
      { type: "node.add" as const, node: { id: `extra-${i}`, type: "text", position: { x: i * 100, y: 800 } }, nodeData: { title: `参考 ${i + 1} · 很长的节点名称用于验证窄屏列表不会撑破标题栏` } },
      { type: "edge.add" as const, edge: { id: `extra-edge-${i}`, source: `extra-${i}`, target: "focus-image" } }
    ]).flat();
    expect((await sendCommands(page, commands, "focus-many-connections")).ok).toBe(true);
    await page.evaluate(() => (window as any).__canvasNavigation.enterNodeFocus({ nodeId: "focus-image", kind: "image" }));
    await page.waitForFunction(() => (window as any).__imageEditDebug?.().loaded);
    await assertNoOverlap(page);
    const trigger = page.getByRole("button", { name: "前序节点（19）", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".focus-connections__list .focus-connections__row")).toHaveCount(19);
    const last = page.locator(".focus-connections__list .focus-connections__row").last();
    await last.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".focus-connections__detail")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(last).toBeFocused();
    await page.screenshot({ path: info.outputPath(`connections-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const bounds = await page.locator(".focus-connections-header").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await expect(page.locator(".app[data-focus-kind]")).toBeVisible();
    await page.locator(".model-focus-back").click();
    await expect(page.locator(".app[data-focus-kind]")).toHaveCount(0);
    await page.evaluate(() => (window as any).__canvasNavigation.enterNodeFocus({ nodeId: "focus-model", kind: "model" }));
    await expect(page.locator('.app[data-focus-kind="model"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "前序节点（1）", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "后序节点（1）", exact: true })).toBeVisible();
    await assertNoOverlap(page);
    await page.screenshot({ path: info.outputPath(`model-header-${width}.png`) });
  });
}
