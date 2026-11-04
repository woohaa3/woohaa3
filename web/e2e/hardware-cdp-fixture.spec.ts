import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "./base-test";

let observer: Browser;
let sentinel: BrowserContext;
let sentinelUrl: string;
let sentinelTargetId: string;
let testTargetId: string;

test.beforeAll(async () => {
  if (!process.env.WOOHAA_E2E_CDP || !process.env.E2E_BASE_URL) {
    throw new Error("hardware fixture requires explicit WOOHAA_E2E_CDP and E2E_BASE_URL");
  }
  observer = await chromium.connectOverCDP(process.env.WOOHAA_E2E_CDP);
  sentinel = await observer.newContext();
  const page = await sentinel.newPage();
  sentinelUrl = `data:text/html,fixture-sentinel-${Date.now()}`;
  await page.goto(sentinelUrl);
  const session = await sentinel.newCDPSession(page);
  sentinelTargetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  await session.detach();
});

test.afterAll(async () => {
  if (!observer) return;
  try {
    const session = await observer.newBrowserCDPSession();
    const { targetInfos } = await session.send("Target.getTargets");
    expect(targetInfos.some(target => target.targetId === sentinelTargetId && target.url === sentinelUrl)).toBe(true);
    expect(testTargetId).toBeTruthy();
    expect(targetInfos.some(target => target.targetId === testTargetId)).toBe(false);
    console.log(`fixture cleanup: sentinel=${sentinelTargetId} present; test=${testTargetId} absent`);
    await session.detach();
  } finally {
    await sentinel?.close();
    await observer.close();
  }
});

test("hardware application renders in an isolated context", async ({ page }, testInfo) => {
  const session = await page.context().newCDPSession(page);
  testTargetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  await session.detach();
  const wasmResponse = page.waitForResponse(response => response.url().endsWith(".wasm") && response.status() === 200, { timeout: 90_000 });
  await page.goto(new URL(`/?fixture=${Date.now()}`, process.env.E2E_BASE_URL).href);
  await page.waitForFunction(() => (window as any).__bevyRuntime?.isReady?.(), null, { timeout: 90_000 });
  const iframe = page.locator('iframe[title="画布渲染预览"]');
  await expect(iframe).toHaveCSS("opacity", "1");
  const frame = page.frameLocator('iframe[title="画布渲染预览"]');
  await expect(frame.locator("canvas")).toBeVisible();
  const renderer = await frame.locator("canvas").evaluate(canvas => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  });
  expect(renderer).toMatch(/NVIDIA.*4060/i);
  const response = await wasmResponse;
  const downloaded = await frame.locator("canvas").evaluate(async (_canvas, url) => {
    const bytes = await (await fetch(url)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { length: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
  }, response.url());
  const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(downloaded.sha256).toBe(sha256(built));
  await writeFile(testInfo.outputPath("renderer.json"), JSON.stringify({ renderer, url: page.url(), wasmUrl: response.url(), wasmBytes: downloaded.length, wasmSha256: downloaded.sha256, sentinelTargetId, testTargetId }, null, 2));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("application.png") });
});
