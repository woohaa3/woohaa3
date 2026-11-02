import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { resetCanvasStorage, waitForCanvasSession, sendCommands } from "./helpers.js";

async function work(page: Page) {
  return page.evaluate(() => (window as any).__bevyRuntime.getWorkDiagnostics());
}

test("moving one card retains unrelated ordinary-card GPU blocks", async ({ page }) => {
  test.setTimeout(120000);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  expect((await sendCommands(page, Array.from({ length: 33 }, (_, i) => ({
    type: "node.add", node: { id: `card-${i}`, type: "text",
      position: { x: 80 + i % 4 * 270, y: 60 + Math.floor(i / 4) * 200 } }
  })))).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes.length)).toBe(33);
  await expect.poll(async () => (await work(page)).cardBlockBuilds).toBeGreaterThanOrEqual(3);
  // Move the pointer outside cards and allow initial selection/hover to settle.
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  const before = await work(page);
  const registrations = await page.evaluate(() => (window as any).__canvasSceneDiagnostics.snapshot().modelRegistrations);
  expect((await sendCommands(page, [{ type: "node.update", nodeId: "card-17",
    position: { x: 420, y: 875 } }])).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()
    ?.nodes.find((n: any) => n.id === "card-17")?.x)).toBe(420);
  await expect.poll(async () => (await work(page)).cardBlockBuilds - before.cardBlockBuilds).toBe(1);
  await page.waitForTimeout(250);
  expect((await work(page)).cardBlockBuilds - before.cardBlockBuilds).toBe(1);
  expect(await page.evaluate(() => (window as any).__canvasSceneDiagnostics.snapshot().modelRegistrations)).toBe(registrations);
  // Camera-only work still leaves both static card buffers and shared geometry intact.
  const moved = await work(page);
  await page.evaluate(() => {
    const runtime = (window as any).__bevyRuntime;
    runtime.setViewport({ baseSceneGeneration: runtime.baseSceneGeneration(), viewport: { x: -100, y: -100, zoom: 0.75 } });
  });
  await page.waitForTimeout(250);
  const panned = await work(page);
  expect(panned.cardBlockBuilds).toBe(moved.cardBlockBuilds);
  expect(panned.meshBuilds).toBe(moved.meshBuilds);
});
