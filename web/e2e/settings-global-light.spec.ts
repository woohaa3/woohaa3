import { test, expect } from "./review-browser.js";
import { waitForBevyReady } from "./helpers.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

test("appearance global light defaults on, updates rendering and survives reload", async ({ page }, info) => {
  test.skip(!process.env.WOOHAA_REVIEW_CDP_URL && !process.env.ATC_REVIEW_CDP_URL, "hardware review CDP required");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("./");
  await waitForBevyReady(page);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (window as any).__bevyRuntime.lastScene()?.nodes.some((node: any) => node.model));
  const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
  const frame = page.frames().find(frame => frame.url().includes("renderer.html"))!;
  const hardware = await frame.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter || /swiftshader|llvmpipe|lavapipe|basic render/i.test(JSON.stringify(adapter.info))) throw new Error("hardware GPU required");
    const wasm = performance.getEntriesByType("resource").find(row => row.name.includes("_bg.wasm"))!.name;
    const bytes = await (await fetch(wasm)).arrayBuffer();
    return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
      wasmSha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("") };
  });
  expect(hardware.wasmSha256).toBe(createHash("sha256").update(built).digest("hex"));
  const open = async () => {
    await page.evaluate(() => (window as any).__settings.open({ section: "appearance" }));
    await expect(page.getByTestId("settings-global-light")).toBeVisible();
  };
  const close = async () => {
    await page.locator('[aria-label="关闭设置"]').click();
    await expect(page.getByTestId("settings-global-light")).toHaveCount(0);
  };
  const capture = async (name: string) => {
    const scene = await page.evaluate(() => (window as any).__bevyRuntime.lastScene());
    await frame.evaluate(async scene => {
      const url = performance.getEntriesByType("resource").map(row => row.name).find(url => url.includes("/bevy-wasm/woohaa_bevy_canvas.js"))!;
      const mod = await import(/* @vite-ignore */ url);
      scene.viewport = { x: 100, y: 550, zoom: .7 };
      // Ephemeral view only; keep the actual UI preference accepted by the shell.
      mod.set_scene(JSON.stringify(scene));
    }, scene);
    await page.waitForTimeout(1200);
    return page.screenshot({ path: info.outputPath(name), clip: { x: 280, y: 130, width: 730, height: 630 } });
  };
  await open();
  const toggle = page.getByTestId("settings-global-light");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().globalLightEnabled)).toBe(true);
  await page.screenshot({ path: info.outputPath("appearance-desktop-on.png") });
  await close();
  const on = await capture("canvas-on.png");
  await open();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().globalLightEnabled)).toBe(false);
  expect(await page.evaluate(() => Object.entries(localStorage).some(([key, value]) => key.startsWith("woohaa:canvas-appearance:v1|") && JSON.parse(value).globalLightEnabled === false))).toBe(true);
  await close();
  const off = await capture("canvas-off.png");
  await open();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().globalLightEnabled)).toBe(true);
  await close();
  const restored = await capture("canvas-restored.png");
  const differences = await page.evaluate(async ({ on, off, restored }) => {
    const decode = async (bytes: number[]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [a, b, c] = await Promise.all([decode(on), decode(off), decode(restored)]);
    const diff = (left: Uint8ClampedArray, right: Uint8ClampedArray) => {
      let changed = 0;
      for (let i = 0; i < left.length; i += 4) if (Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]) > 6) changed++;
      return changed;
    };
    return { toggled: diff(a, b), restored: diff(a, c) };
  }, { on: [...on], off: [...off], restored: [...restored] });
  expect(differences.toggled).toBeGreaterThan(1000);
  expect(differences.restored).toBeLessThan(differences.toggled * .02);
  await open();
  await toggle.click();
  await page.reload();
  await waitForBevyReady(page);
  await open();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().globalLightEnabled)).toBe(false);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('[data-testid="settings-theme"] button').filter({ hasText: "暗色" }).click();
  await page.screenshot({ path: info.outputPath("appearance-pad-dark-off.png") });
  const bounds = await toggle.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(768);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().globalLightEnabled)).toBe(true);
  await page.reload();
  await waitForBevyReady(page);
  await open();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await writeFile(info.outputPath("verification.json"), JSON.stringify({ hardware, differences, defaultOn: true, persistedOff: true, persistedOn: true, desktop: "1440x1000", pad: "1024x768" }, null, 2));
});
