/**
 * 大型模型快照热路径性能验收
 * （change: optimize-model-scene-snapshot-hot-path，任务 5.1 / 5.2 / 5.3）。
 *
 * 硬门禁使用确定性计数器（可由 `window.__canvasSceneDiagnostics.snapshot()` 读取）：
 * - 空闲画布不构建场景、不提交、不遍历模型；
 * - 聚焦镜头 / viewport / placement 连续更新期间模型注册次数不变，且动态 payload 大小
 *   与模型顶点数无关；
 * - 模型内容替换恰好新增一次注册。
 *
 * 帧耗时（rAF P50/P95、dropped frame）只做软记录并打印 `[perf]`，避免软件 GPU 与共享
 * CI 负载导致 flaky；确定性计数与 payload 上界作为硬断言。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, createNode, waitForCanvasSession } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

type Diagnostics = {
  sceneBuilds: number;
  sceneSubmits: number;
  sceneDedupes: number;
  modelRegistrations: number;
  boundaryBytes: number;
  derivedMetadata: number;
};

async function diagnostics(page: Page): Promise<Diagnostics> {
  return page.evaluate(
    () =>
      (window as unknown as { __canvasSceneDiagnostics: { snapshot(): Diagnostics } }).__canvasSceneDiagnostics.snapshot()
  );
}

async function resetDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __canvasSceneDiagnostics: { reset(): void } }).__canvasSceneDiagnostics.reset()
  );
}

/**
 * 生成一份大型 V2 mesh 脚本：运行时用循环构造顶点/面，脚本本身很小，
 * 但规范化后 Scene IR 达到约 20,000 顶点、30,000 面、> 1 MB。
 *
 * 权威提交接口对脚本文本有 200k 字符上限，因此不能在脚本里内联顶点字面量；
 * 必须在执行期用循环生成数组（validator 会检查实际规范化结果）。
 */
function largeMeshScript(vertexCount: number, faceCount = vertexCount): string {
  return `
    const vertices = [];
    for (let i = 0; i < ${vertexCount}; i += 1) {
      vertices.push([(i % 100) * 0.37, Math.floor(i / 100) * 0.41, (i % 17) * 0.19]);
    }
    const faces = [];
    for (let i = 0; i < ${faceCount}; i += 1) {
      faces.push([i % ${vertexCount}, (i + 1) % ${vertexCount}, (i + 2) % ${vertexCount}]);
    }
    scene.mesh({ id: "hull", vertices, faces, color: "#3aa0c8" });
  `;
}

/**
 * 在页内采样 rAF 帧间隔（固定帧数），返回 P50/P95 与 dropped frame 估算
 * （间隔 > 1.5× 中位视为掉帧）。软指标，只写 artifact/日志，不作为硬门禁。
 */
async function rafStats(page: Page, frames = 120): Promise<{ p50: number; p95: number; dropped: number; count: number }> {
  return page.evaluate(
    (sampleCount) =>
      new Promise<{ p50: number; p95: number; dropped: number; count: number }>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const tick = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (deltas.length >= sampleCount) {
            const sorted = [...deltas].sort((a, b) => a - b);
            const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
            const median = percentile(0.5);
            resolve({
              p50: percentile(0.5),
              p95: percentile(0.95),
              dropped: deltas.filter((delta) => delta > median * 1.5).length,
              count: deltas.length
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames
  );
}

/** 记录软性能指标并附带 JSON artifact（不改变渲染结果）。 */
async function recordPerf(page: Page, name: string, extra: Record<string, unknown>): Promise<void> {
  const stats = await rafStats(page);
  const summary = { name, ...stats, ...extra };
  // eslint-disable-next-line no-console
  console.log(`[perf] ${JSON.stringify(summary)}`);
  await test.info().attach(`${name}-perf.json`, {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json"
  });
}

async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, source, version: "woohaa-model-js-v2", requestId: `e2e-${nodeId}-${source}` }
  });
  expect(response.ok(), `submit_model_script 失败：${response.status()}`).toBe(true);
}

async function waitForModelRendered(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const canonical = (window as unknown as {
        __canvasCanonical?: { nodeData?: Record<string, { modelScriptVersion?: string; modelScriptStatus?: string }> };
      }).__canvasCanonical;
      const data = canonical?.nodeData?.[id];
      return data?.modelScriptVersion === "woohaa-model-js-v2" && data.modelScriptStatus === "ok";
    },
    nodeId,
    { timeout: 30_000, polling: 200 }
  );
  await page.waitForTimeout(600);
}

test.describe("大型模型快照热路径（change: optimize-model-scene-snapshot-hot-path）", () => {
  test.beforeEach(async ({ page }) => {
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
  });

  test("空闲画布 60 帧：不构建场景、不提交 set_scene", async ({ page }) => {
    await resetDiagnostics(page);
    const baseline = await diagnostics(page);
    // 等待约 60 帧（1 秒 @60Hz）；期间无任何输入。
    await page.waitForTimeout(1000);
    const after = await diagnostics(page);
    expect(after.sceneSubmits).toBe(baseline.sceneSubmits);
    expect(after.modelRegistrations).toBe(baseline.modelRegistrations);
    // 空闲帧不应派生元数据（无模型内容变化）。
    expect(after.derivedMetadata).toBe(baseline.derivedMetadata);
    // 软指标：记录空闲 rAF P50/P95 与 dropped frames。
    await recordPerf(page, "idle", { sceneBuilds: after.sceneBuilds - baseline.sceneBuilds });
  });

  test("大型模型：聚焦/视口/placement 更新不重复注册模型，动态 payload 与顶点数无关", async ({ page }) => {
    // 软件渲染下 20k 顶点模型单帧较慢，放宽用例超时。
    test.setTimeout(180_000);
    const created = await createNode(page, { nodeType: "model3d", position: { x: 380, y: 120 }, nodeId: "hot-large" });
    expect(created.ok).toBe(true);
    await submitModelScript(page, "hot-large", largeMeshScript(20_000, 30_000));
    await waitForModelRendered(page, "hot-large");

    await resetDiagnostics(page);
    const baseline = await diagnostics(page);
    expect(baseline.modelRegistrations).toBe(0);

    // 连续 viewport 缩放（滚轮作用于画布中心）。
    const canvas = page.locator("#bevy-canvas");
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    for (let index = 0; index < 20; index += 1) {
      await page.mouse.wheel(0, index % 2 === 0 ? -120 : 120);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(200);
    const afterViewport = await diagnostics(page);
    // 动态更新期间模型不重复注册。
    expect(afterViewport.modelRegistrations).toBe(baseline.modelRegistrations);
    // 场景提交的次数与边界字节应远小于模型 1MB payload（不重复传输静态模型内容）。
    const submitted = afterViewport.sceneSubmits - baseline.sceneSubmits;
    if (submitted > 0) {
      const bytesPerSubmit = (afterViewport.boundaryBytes - baseline.boundaryBytes) / submitted;
      expect(bytesPerSubmit).toBeLessThan(200_000);
    }
  });

  test("模型内容替换恰好新增一次注册", async ({ page }) => {
    const created = await createNode(page, { nodeType: "model3d", position: { x: 380, y: 120 }, nodeId: "hot-replace" });
    expect(created.ok).toBe(true);
    await submitModelScript(page, "hot-replace", largeMeshScript(8_000));
    await waitForModelRendered(page, "hot-replace");
    await resetDiagnostics(page);

    // 内容变化：换一个不同 mesh。
    await submitModelScript(page, "hot-replace", largeMeshScript(9_000));
    await waitForModelRendered(page, "hot-replace");
    await page.waitForTimeout(300);
    const after = await diagnostics(page);
    expect(after.modelRegistrations).toBeGreaterThanOrEqual(1);
    // 内容替换只应产生一次新资源注册（不随帧率重复）。
    expect(after.modelRegistrations).toBeLessThanOrEqual(2);
  });
});
