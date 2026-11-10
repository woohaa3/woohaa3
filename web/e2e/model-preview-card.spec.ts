import { defaultSelfContained3DNodeData } from "@woohaa3/contracts";
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import {
  resetCanvasStorage,
  waitForCanvasSession,
  sendCommands,
  readStoredCanvas,
} from "./helpers.js";

async function rect(page: Page, id: string) {
  return page.evaluate((id) => {
    const runtime = (window as any).__bevyRuntime,
      scene = runtime.lastScene();
    const node = scene.nodes.find((n: any) => n.id === id),
      view = scene.viewport;
    const canvas = document
      .querySelector("#bevy-canvas")!
      .getBoundingClientRect();
    return {
      x: canvas.left + (node.x + 16) * view.zoom + view.x,
      y: canvas.top + (node.y + 52) * view.zoom + view.y,
      width: (node.width - 32) * view.zoom,
      height: (node.height - 68) * view.zoom,
    };
  }, id);
}
async function colors(
  page: Page,
  region: { x: number; y: number; width: number; height: number },
) {
  const png = (await page.screenshot({ clip: region })).toString("base64");
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${png}`)).blob(),
    );
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext(
      "2d",
    )!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let red = 0,
      blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > pixels[i + 2] + 30) red++;
      if (pixels[i + 2] > pixels[i] + 30) blue++;
    }
    return { red, blue };
  }, png);
}

test("模型卡片独立渲染、聚焦视角同步、模型信息面板", async ({ page }) => {
  // 多次真实截图/捕获在 SwiftShader 上需要等待帧完成。
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  const script = (color: string) =>
    `scene.box({id:'body',size:[1,2,.5],color:'${color}'});scene.box({id:'side',position:[.8,0,.5],size:[.7,.5,1],color:'${color}'});`;
  expect(
    (
      await sendCommands(page, [
        {
          type: "node.add",
          nodeData: defaultSelfContained3DNodeData("model3d"),
          node: {
            id: "red-model",
            type: "model3d",
            position: { x: 120, y: 60 },
            width: 196,
            height: 64,
          },
        },
        {
          type: "node.add",
          nodeData: defaultSelfContained3DNodeData("model3d"),
          node: {
            id: "blue-model",
            type: "model3d",
            position: { x: 420, y: 60 },
          },
        },
      ])
    ).ok,
  ).toBe(true);
  await expect
    .poll(async () => (await readStoredCanvas(page))!.document.nodes.length)
    .toBe(2);
  for (const [nodeId, color] of [
    ["red-model", "#ee3520"],
    ["blue-model", "#2080ff"],
  ]) {
    const response = await page.request.post("/api/model-mcp/scripts", {
      data: {
        canvasId: "woohaa3-default-canvas",
        nodeId,
        requestId: `preview-script-${nodeId}`,
        source: script(color),
        version: "woohaa-model-js-v2",
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__bevyRuntime
            .lastScene()
            ?.nodes.filter((n: any) => n.model).length,
      ),
    )
    .toBe(2);
  let red = await rect(page, "red-model");
  const blue = await rect(page, "blue-model");
  expect(red.width).toBeGreaterThan(150);
  expect(red.height).toBeGreaterThan(140);
  await expect
    .poll(async () => (await colors(page, red)).red, { timeout: 30000 })
    .toBeGreaterThan(200);
  await expect
    .poll(async () => (await colors(page, blue)).blue, { timeout: 30000 })
    .toBeGreaterThan(200);
  expect((await colors(page, blue)).red).toBeLessThan(20);
  // An unselected card leaves trackpad panning with the canvas.
  const unselectedView = await page.evaluate(
    () =>
      (window as any).__bevyRuntime
        .lastScene()
        .nodes.find((n: any) => n.id === "blue-model").modelPreview,
  );
  const unselectedViewport = await page.evaluate(() =>
    (window as any).__canvasViewport(),
  );
  await page.dispatchEvent("#bevy-canvas", "wheel", {
    clientX: blue.x + blue.width / 2,
    clientY: blue.y + blue.height / 2,
    deltaX: 12,
    deltaY: 16,
    deltaMode: 0,
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__canvasViewport()))
    .not.toEqual(unselectedViewport);
  const pannedViewport = await page.evaluate(() =>
    (window as any).__canvasViewport(),
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__bevyRuntime.lastScene().viewport),
    )
    .toEqual(pannedViewport);
  expect(
    await page.evaluate(
      () =>
        (window as any).__bevyRuntime
          .lastScene()
          .nodes.find((n: any) => n.id === "blue-model").modelPreview,
    ),
  ).toEqual(unselectedView);
  red = await rect(page, "red-model");
  const center = { x: red.x + red.width / 2, y: red.y + red.height / 2 };
  await page.mouse.click(center.x, center.y);
  const before = await readStoredCanvas(page);
  const viewport = await page.evaluate(() =>
    (window as any).__canvasViewport(),
  );
  const oldAngle = await page.evaluate(
    () =>
      (window as any).__bevyRuntime
        .lastScene()
        .nodes.find((n: any) => n.id === "red-model").modelPreview.azimuth,
  );
  const beforePixels = await page.screenshot({ clip: red });
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 60, center.y + 15, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__bevyRuntime
            .lastScene()
            .nodes.find((n: any) => n.id === "red-model").modelPreview.azimuth,
      ),
    )
    .not.toBe(oldAngle);
  await page.mouse.move(30, 30);
  await page.waitForTimeout(400);
  expect((await page.screenshot({ clip: red })).equals(beforePixels)).toBe(
    false,
  );
  expect((await readStoredCanvas(page))!.document).toEqual(before!.document);
  expect((await readStoredCanvas(page))!.nodeData).toEqual(before!.nodeData);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(20, -40);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__canvasViewport())).toEqual(
    viewport,
  );
  const cardView = await page.evaluate(
    () =>
      (window as any).__bevyRuntime
        .lastScene()
        .nodes.find((n: any) => n.id === "red-model").modelPreview,
  );
  await page.mouse.dblclick(center.x, center.y);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()),
    )
    .toBe(true);
  await expect(page.locator(".model-editor")).toBeVisible();
  const observer = await page.evaluate(() =>
    (window as any).__canvasModelFocus.projection(),
  );
  expect(observer.yaw).toBeCloseTo(cardView.azimuth);
  expect(observer.pitch).toBeCloseTo(-cardView.elevation);
  const canvasBounds = await page.locator("#bevy-canvas").boundingBox();
  await expect
    .poll(async () => (await colors(page, canvasBounds!)).red)
    .toBeGreaterThan(200);
  // Observer navigation must also update the embedded preview, without document writes.
  await page.mouse.move(400, 300);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(470, 330, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.mouse.wheel(0, -80);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(480, 340, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__bevyRuntime
            .lastScene()
            .nodes.find((n: any) => n.id === "red-model").modelPreview.azimuth,
      ),
    )
    .not.toBe(cardView.azimuth);
  const movedObserver = await page.evaluate(() =>
    (window as any).__canvasModelFocus.projection(),
  );
  const movedView = await page.evaluate(
    () =>
      (window as any).__bevyRuntime
        .lastScene()
        .nodes.find((n: any) => n.id === "red-model").modelPreview,
  );
  expect(movedView.azimuth).toBeCloseTo(movedObserver.yaw);
  expect(movedView.elevation).toBeCloseTo(-movedObserver.pitch);
  expect(movedView.distanceScale).not.toBe(cardView.distanceScale);
  expect(movedView.targetOffset).not.toEqual(cardView.targetOffset);
  expect((await readStoredCanvas(page))!.nodeData).toEqual(before!.nodeData);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()),
    )
    .toBe(false);
  await expect
    .poll(async () => (await colors(page, red)).red)
    .toBeGreaterThan(200);
  expect((await page.screenshot({ clip: red })).equals(beforePixels)).toBe(
    false,
  );
  await page.mouse.dblclick(center.x, center.y);
  await expect(page.locator(".model-editor")).toBeVisible();
  const restoredObserver = await page.evaluate(() =>
    (window as any).__canvasModelFocus.projection(),
  );
  expect(restoredObserver.yaw).toBeCloseTo(movedObserver.yaw);
  expect(restoredObserver.pitch).toBeCloseTo(movedObserver.pitch);
  expect(restoredObserver.distance).toBeCloseTo(movedObserver.distance);
  restoredObserver.target.forEach((value: number, index: number) =>
    expect(value).toBeCloseTo(movedObserver.target[index]),
  );
  // 普通 model3d 聚焦只保留 AI 修改与模型规模信息
  // （change: 2026-10-18-simplify-model-focus-panel）：镜头、取景与截图已移除，
  await expect(page.locator(".model-info")).toBeVisible();
  await expect(page.locator("[data-model-info-rows]")).toBeVisible();
  await expect(page.getByRole("button", { name: "添加镜头", exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__modelEditorGizmo()?.shot != null),
    )
    .toBe(false);
  await page.evaluate(() => (window as any).__modelEditor.addCamera());
  await page.waitForTimeout(300);
  expect(
    (await readStoredCanvas(page))!.document.nodes.filter(
      (n) => n.type === "image",
    ).length,
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()),
    )
    .toBe(false);
  expect(errors).toEqual([]);
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath("failure.png") });
});
