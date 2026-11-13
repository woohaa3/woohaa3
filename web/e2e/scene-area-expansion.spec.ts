import { test, expect } from './review-browser.js';
import { seedYjsCanvas, waitForCanvasSession } from './helpers.js';

const canvasId = 'woohaa3-default-canvas';
for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
  test(`导演区命令选项在 ${viewport.width}×${viewport.height} 默认关闭`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const nodes = [{ id: 'area-1', type: 'scene-area', position: { x: 240, y: 180 } }, { id: 'area-2', type: 'scene-area', position: { x: 500, y: 180 } }];
    const area = (id: string) => ({ title: id, sceneArea: { kind: 'scene-area', version: 'shared-world-v1', areaId: id, scopeVersion: `${id}-v1`, bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } } } });
    await seedYjsCanvas(page, canvasId, nodes, { canvas: { id: canvasId, title: '导演区', revision: 0, document: { schemaVersion: 'asset-canvas-v1', nodes, edges: [], updatedAt: '2026-09-24T00:00:00.000Z' }, nodeData: { 'area-1': area('area-1'), 'area-2': area('area-2') }, assets: [], jobs: [], updatedAt: '2026-09-24T00:00:00.000Z' } });
    await page.goto('/');
    await waitForCanvasSession(page);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__canvasSetSelection), { timeout: 30_000 }).toBe('function');
    await page.evaluate(() => (window as any).__canvasSetSelection(['area-1']));
    const checkbox = page.locator('.assistant-expansion-option input');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`director-${viewport.width}.png`) });
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await page.evaluate(() => (window as any).__canvasSetSelection(['area-2']));
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await page.evaluate(() => (window as any).__canvasSetSelection(['area-1']));
    await expect(checkbox).toBeChecked();
  });
}
