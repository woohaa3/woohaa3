/**
 * 独立扩展发布加载 E2E
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 6.6/7.2/7.5）。
 *
 * 用**真实构建产物**（`web/frontend/dist` + assembly 输出）验证发布目录驱动的浏览器加载：
 * - HTML 发布 link → release catalog → 只请求本次选择的扩展 artifact；
 * - 禁用的 browser-local optional 产生**零** JS/CSS 请求；
 * - Task History 冷启动不触发任何 Canvas 扩展请求；
 * - 发布资源 immutable 缓存、缺失带扩展名资源 404（不 SPA 回退）。
 *
 * 只等应用 shell 就绪（`.canvas-control-panel`），不依赖 Bevy 渲染或 GPU。
 */
import { expect, test, type Page } from "@playwright/test";

const PREF_KEY = "woohaa:frontend-extensions:v1";

/** 记录页面上对扩展发布资源的请求 URL（去重）。 */
function trackExtensionRequests(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/extensions/") || url.includes("/extension-releases/")) seen.add(url);
  });
  return seen;
}

async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator(".canvas-control-panel")).toBeVisible({ timeout: 60_000 });
}

test.describe("独立扩展发布加载", () => {
  test("发布 link 驱动的运行时加载：catalog + always/browser-local 入口", async ({ page }) => {
    const extensionRequests = trackExtensionRequests(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForShell(page);
    // 给实现 chunk 的异步导入一点时间。
    await page.waitForTimeout(2000);

    const releaseHref = await page.evaluate(
      () => document.querySelector('link[rel="woohaa-extension-release"]')?.getAttribute("href") ?? null
    );
    expect(releaseHref, "HTML 必须携带发布目录 link").toMatch(/^\/extension-releases\/[0-9a-f]{64}\.json$/);

    const requests = [...extensionRequests];
    // 目录只请求一次，且就是 HTML link 指向的固定版本。
    const catalogRequests = requests.filter((url) => url.includes("/extension-releases/"));
    expect(catalogRequests).toHaveLength(1);
    expect(new URL(catalogRequests[0]).pathname).toBe(releaseHref);

    // always（ChatGPT、片场）与默认启用的 browser-local（prompt-snippets、task-activity）
    // 的 artifact 入口被请求；server-active 的 RunningHub 未激活则不请求。
    for (const id of ["oauth-agent", "film-set", "prompt-snippets", "task-activity"]) {
      expect(
        requests.some((url) => url.includes(`/extensions/${id}/`)),
        `${id} 应被加载`
      ).toBe(true);
    }
    expect(requests.some((url) => url.includes("/extensions/runninghub-provider/"))).toBe(false);

    expect(pageErrors).toEqual([]);
  });

  test("禁用 browser-local optional 后零 JS/CSS 请求", async ({ page }) => {
    const extensionRequests = trackExtensionRequests(page);
    await page.addInitScript(
      ([key]) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({ "prompt-snippets": false, "task-activity": false })
        );
      },
      [PREF_KEY]
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForShell(page);
    await page.waitForTimeout(2000);

    const disabled = [...extensionRequests].filter(
      (url) => url.includes("/extensions/prompt-snippets/") || url.includes("/extensions/task-activity/")
    );
    expect(disabled).toEqual([]);
    // 目录与 always 入口仍应加载。
    expect([...extensionRequests].some((url) => url.includes("/extension-releases/"))).toBe(true);
    expect([...extensionRequests].some((url) => url.includes("/extensions/oauth-agent/"))).toBe(true);
  });

  test("Task History 冷启动不触发任何 Canvas 扩展请求", async ({ page }) => {
    const extensionRequests = trackExtensionRequests(page);
    await page.goto("/task-history", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    expect([...extensionRequests]).toEqual([]);
  });

  test("发布资源 immutable 缓存；缺失带扩展名资源 404", async ({ request, page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const releaseHref = await page.evaluate(
      () => document.querySelector('link[rel="woohaa-extension-release"]')?.getAttribute("href") ?? null
    );
    expect(releaseHref).not.toBeNull();

    const catalog = await request.get(releaseHref!);
    expect(catalog.status()).toBe(200);
    expect(catalog.headers()["cache-control"]).toContain("immutable");
    const body = await catalog.json();
    const entry = body.entries.find(
      (candidate: { metadata: { extensionId: string } }) => candidate.metadata.extensionId === "oauth-agent"
    );
    expect(entry).toBeTruthy();

    const artifact = await request.get(entry.entryURL);
    expect(artifact.status()).toBe(200);
    expect(artifact.headers()["content-type"]).toContain("javascript");
    expect(artifact.headers()["cache-control"]).toContain("immutable");

    const missing = await request.get("/extensions/does-not-exist/deadbeef/entry.js");
    expect(missing.status()).toBe(404);
  });
});
