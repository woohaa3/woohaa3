import { filmSetNodeDataFields, createFilmSetSnapshot } from "@woohaa3/contracts";
import { expect, test } from "@playwright/test";
import { installPageHelpers, readStoredCanvas, resetCanvasStorage, sendCommands, uploadMedia, waitForCanvasSession } from "./helpers.js";

test("图片直接点选、三轴实时移动、缩放和持久化，整体与对象工具同时可用", async ({ page }) => {
  test.setTimeout(150_000);
  await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page);
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#e735a9"; ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = "#f8dc35"; ctx.fillRect(10, 8, 24, 20);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
    return [...new Uint8Array(await blob!.arrayBuffer())];
  });
  const upload = await uploadMedia(page, bytes); expect(upload.status).toBe(201);
  const storageKey = String((upload.body as any).storageKey);
  const data = filmSetNodeDataFields(createFilmSetSnapshot({ title: "图片片场", motionScript: "", timeline: { duration: 0, loop: false }, filmSetContent: { schemaVersion: 3, items: [{ id: "photo", name: "照片", kind: "image", assetId: "photo-asset", aspectRatio: 4/3, localTransform: { offset: { x: 0, y: 2, z: 0 }, scale: 1, yaw: 0.2 } }] } }));
  await sendCommands(page, [
    { type: "asset.upsert", asset: { id: "photo-asset", title: "照片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: new Date().toISOString(), url: `/api/media/${storageKey}`, metadata: { storageKey, checksum: storageKey.replace("sha256-", ""), contentType: "image/png", size: bytes.length } } },
    { type: "node.add", node: { id: "film", type: "composite-asset", position: { x: 200, y: 120 }, width: 260, height: 195 }, nodeData: data }
  ] as never, "image-film-seed");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime?.lastScene()?.nodes.find((n: any) => n.id === "film")?.compositeAsset?.media?.[0]?.hasTexture)).toBe(true);
  await page.mouse.dblclick(330, 217);
  await expect(page.locator(".film-set-animation-controls")).toBeVisible();
  await expect(page.locator(".film-set-object-dock")).toBeVisible();
  await expect(page.getByRole("radio", { name: "对象", exact: true })).toHaveCount(0);
  await page.waitForTimeout(700);
  // Project an interior point of the actual rendered image, then use a real pointer click.
  const point = await page.evaluate(() => {
    const runtime = (window as any).__bevyRuntime;
    const p = (window as any).__canvasModelFocus.projection();
    const center = runtime.queryCompositeAssetItemBounds("film").find((b: any) => b.itemId === "photo").center;
    const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch), sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    const forward = [-sy*cp, sp, -cy*cp], right = [cy, 0, -sy], up = [sy*sp, cp, cy*sp];
    const eye = p.target.map((v: number, i: number) => v - forward[i]*p.distance);
    const rel = center.map((v: number, i: number) => v-eye[i]);
    const dot = (v: number[]) => rel.reduce((a: number, x: number, i: number) => a+x*v[i], 0);
    const focal = rect.height/(2*Math.tan(Math.PI/6));
    return { x: rect.left+rect.width/2+dot(right)*focal/dot(forward), y: rect.top+rect.height/2-dot(up)*focal/dot(forward) };
  });
  // 中心点上有镜头三轴手柄；在图片内部避开手柄，验证对象本体的真实点选路径。
  await page.mouse.click(point.x + 24, point.y + 24);
  await expect(page.getByRole("option", { name: "图片 · 照片" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().modelEditor?.toolMode)).toBe("object");
  const transform = async () => ((await readStoredCanvas(page))!.nodeData.film as any).filmSetContent.items[0].localTransform;
  for (const axis of ["x", "y", "z"]) {
    const handle = await page.evaluate(axis => {
      const runtime = (window as any).__bevyRuntime, editor = runtime.lastScene().modelEditor;
      const projection = (window as any).__canvasModelFocus.projection();
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      const content = runtime.lastScene().surface.contentRect;
      // 只寻找共享聚焦内容区中可实际点击的手柄，避开顶部导航和右侧面板。
      for (let y = content.y + 12; y < content.y + content.height - 12; y += 4) for (let x = content.x + 12; x < content.x + content.width - 12; x += 4) {
        const hit = runtime.queryGizmoHit({ kind: "object", editor, projection, surface: { width: rect.width, height: rect.height }, point: { x, y } });
        if (hit?.handle === axis && hit.constraint) return { x: rect.left+x, y: rect.top+y, direction: hit.constraint.direction };
      }
      throw new Error(`Missing ${axis} handle`);
    }, axis);
    const before = await transform();
    const center = await page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film")[0].center);
    const pixels = await page.locator("#bevy-canvas").screenshot();
    await page.mouse.move(handle.x, handle.y); await page.mouse.down();
    await page.mouse.move(handle.x+handle.direction[0]*30, handle.y+handle.direction[1]*30, { steps: 6 });
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film")[0].center)).not.toEqual(center);
    expect(await transform()).toEqual(before);
    expect((await page.locator("#bevy-canvas").screenshot()).equals(pixels)).toBe(false);
    const panel = await page.locator(".film-set-transform input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
    await page.mouse.up(); await expect.poll(transform).not.toEqual(before);
    await expect.poll(() => page.locator(".film-set-transform input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(panel);
  }
  await page.getByRole("spinbutton", { name: "等比缩放" }).focus();
  await expect(page.getByRole("button", { name: "删除对象", exact: true })).toBeEnabled();
  const radius = await page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film")[0].radius);
  await page.getByRole("spinbutton", { name: "等比缩放" }).fill("1.5");
  await page.getByRole("spinbutton", { name: "等比缩放" }).press("Tab");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film")[0].radius)).toBeCloseTo(radius*1.5, 2);
  // 渲染预览先于服务端结算；刷新验证必须等规范缩放已落盘。
  await expect.poll(async () => (await transform()).scale).toBe(1.5);
  const saved = await transform();
  await page.reload(); await waitForCanvasSession(page); expect(await transform()).toEqual(saved);
});
