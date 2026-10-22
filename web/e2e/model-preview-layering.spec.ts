/**
 * 模型卡片预览的层级与投影验收
 * （change: 2026-10-09-fix-model-preview-layering-and-projection；卡片已改为透视投影）。
 *
 * 两条真实 Chromium 断言：
 * - 两个重叠 model3d 卡片中，文档顺序更靠后的卡片整体遮挡更靠前的卡片：重叠区不得出现
 *   下层卡片的预览像素（回归「预览 Sprite 永远盖在所有卡片外壳之上」的层级缺陷）。
 * - 卡片预览使用透视投影：同一高塔的顶部明显宽于底部（正交投影下两者等宽）。
 */
import { defaultSelfContained3DNodeData } from "@woohaa3/contracts";
import { expect, test, type Page } from "@playwright/test";
import {
  resetCanvasStorage,
  waitForCanvasSession,
  sendCommands,
  readStoredCanvas,
} from "./helpers.js";

async function rect(page: Page, id: string) {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((n: any) => n.id === id);
    const view = scene.viewport;
    const canvas = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return {
      x: canvas.left + node.x * view.zoom + view.x,
      y: canvas.top + node.y * view.zoom + view.y,
      width: node.width * view.zoom,
      height: node.height * view.zoom,
    };
  }, id);
}

/** 采样某矩形内红/蓝像素数（用于判断遮挡）。 */
async function colors(page: Page, region: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip: region })).toString("base64");
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > pixels[i + 2] + 30) red++;
      if (pixels[i + 2] > pixels[i] + 30) blue++;
    }
    return { red, blue };
  }, png);
}

const script = (color: string) =>
  `scene.box({id:'body',size:[1,2,.5],color:'${color}'});scene.box({id:'side',position:[.8,0,.5],size:[.7,.5,1],color:'${color}'});`;

test("重叠模型卡片层级：后创建者遮挡先创建者的预览", async ({ page }) => {
  test.setTimeout(120000);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  expect(
    (
      await sendCommands(page, [
        { type: "node.add", nodeData: defaultSelfContained3DNodeData("model3d"), node: { id: "a-model", type: "model3d", position: { x: 80, y: 60 }, width: 224, height: 300 } },
        { type: "node.add", nodeData: defaultSelfContained3DNodeData("model3d"), node: { id: "b-model", type: "model3d", position: { x: 200, y: 140 }, width: 224, height: 300 } },
      ])
    ).ok,
  ).toBe(true);
  await expect.poll(async () => (await readStoredCanvas(page))!.document.nodes.length).toBe(2);
  for (const [nodeId, color] of [["a-model", "#ee3520"], ["b-model", "#2080ff"]] as const) {
    const response = await page.request.post("/api/model-mcp/scripts", {
      data: { canvasId: "woohaa3-default-canvas", nodeId, requestId: `lay-${nodeId}`, source: script(color), version: "woohaa-model-js-v2" },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await expect
    .poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes.filter((n: any) => n.model).length), { timeout: 30000 })
    .toBe(2);
  await page.waitForTimeout(2000);

  const a = await rect(page, "a-model");
  const b = await rect(page, "b-model");
  // 重叠区：a 与 b 的矩形交集
  const overlap = {
    x: Math.max(a.x, b.x),
    y: Math.max(a.y, b.y),
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
  console.log("A", JSON.stringify(a), "B", JSON.stringify(b), "OVERLAP", JSON.stringify(overlap));
  expect(overlap.width).toBeGreaterThan(60);
  expect(overlap.height).toBeGreaterThan(60);
  const { red, blue } = await colors(page, overlap);
  console.log("OVERLAP COLORS", red, blue);
  // b 在文档顺序上更晚（更高 z），应遮挡 a：重叠区不应出现 a 的红色预览。
  expect(red).toBeLessThan(30);
  expect(blue).toBeGreaterThan(100);
});

test("模型预览相机为透视", async ({ page }) => {
  test.setTimeout(120000);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  // 一个高而窄的塔：透视投影下顶部会明显比底部窄（近大远小），正交投影下两者等宽。
  expect(
    (
      await sendCommands(page, [
        { type: "node.add", nodeData: defaultSelfContained3DNodeData("model3d"), node: { id: "m", type: "model3d", position: { x: 60, y: 40 }, width: 300, height: 360 } },
      ])
    ).ok,
  ).toBe(true);
  const tower =
    "for(let i=0;i<8;i+=1){scene.box({id:'t'+i,position:[0,i*0.6,0],size:[0.5,0.55,0.5],color:'#c02a2a'});}";
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: "woohaa3-default-canvas", nodeId: "m", requestId: "persp", source: tower, version: "woohaa-model-js-v2" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes.filter((n: any) => n.model).length), { timeout: 30000 })
    .toBe(1);
  await page.waitForTimeout(2000);

  const node = await rect(page, "m");
  const content = {
    x: node.x + 16,
    y: node.y + 52,
    width: node.width - 32,
    height: node.height - 68,
  };
  const png = (await page.screenshot({ clip: content })).toString("base64");
  const widths = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    // 逐行统计红色（模型）像素的水平范围，取靠上/靠下若干行的宽度。
    // 先求红色像素的整体包围盒，再在包围盒内比较上下区域的宽度。
    const isRed = (i: number) => data[i] > data[i + 2] + 20 && data[i] > data[i + 1] + 20 && data[i] > 60;
    let minY = Infinity, maxY = -Infinity, redTotal = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (isRed(i)) { redTotal += 1; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
    }
    if (redTotal === 0) return { top: 0, bottom: 0, redTotal };
    const rowWidth = (y: number) => {
      let min = Infinity, max = -Infinity;
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (isRed(i)) { if (x < min) min = x; if (x > max) max = x; }
      }
      return max >= min ? max - min + 1 : 0;
    };
    const bandWidth = (from: number, to: number) => {
      let best = 0;
      for (let y = from; y <= to; y += 1) best = Math.max(best, rowWidth(y));
      return best;
    };
    const span = maxY - minY;
    return {
      top: bandWidth(minY, minY + Math.round(span * 0.18)),
      bottom: bandWidth(maxY - Math.round(span * 0.18), maxY),
      redTotal,
    };
  }, png);
  console.log("TOWER WIDTHS", JSON.stringify(widths));
  expect(widths.top).toBeGreaterThan(10);
  expect(widths.bottom).toBeGreaterThan(10);
  // 透视：卡片从斜上方俯视，塔顶离相机更近，投影应明显宽于塔底；正交时两侧几乎等宽。
  expect(widths.top / widths.bottom).toBeGreaterThan(1.1);
});
