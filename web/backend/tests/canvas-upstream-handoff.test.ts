/**
 * canvas-upstream capability 交接集成测试。
 *
 * 锁住三件事：
 * 1. 上游提供者在 application 层激活、晚于 canvas 装载，宿主仍必须解析到它（不能早解析成 null）；
 * 2. 解析入口是**按画布**的：宿主把每个已加载 room 的 canvasId 交给提供者，提供者据此决定
 *    这张画布要不要同步（登录不等于上传）；
 * 3. 会话在运行中变化后，宿主经 `CanvasService.refreshUpstream()` 重新逐画布解析。
 *
 * 用提供者的调用记录断言「谁被问了、问了哪张画布」；不建立真实中继连接。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasUpstreamCapabilityId,
  type ApplicationBackendExtensionDefinition,
  type CanvasUpstreamLink
} from "@woohaa3/contracts";
import { createBackendService } from "../src/composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-canvas-upstream-"));
  dirs.push(dir);
  return dir;
}
function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) { objects.set(key, { bytes: Uint8Array.from(bytes), contentType }); },
    async get(key: string) { return objects.get(key)!; },
    async exists(key: string) { return objects.has(key); },
    async stat(key: string) { const r = objects.get(key); if (!r) throw new Error("missing"); return { size: r.bytes.byteLength, contentType: r.contentType }; },
    async getHttpsUrl(key: string) { return `https://cos.invalid/${key}?sign=test`; }
  };
}

const PROVIDER_CAPABILITY = canvasUpstreamCapabilityId("test-upstream");

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor 超时");
}

describe("canvas-upstream capability 交接", () => {
  it("晚装载的扩展提供者按画布解析，运行中切换会话后逐画布重新解析", async () => {
    const dir = tempDir();
    const events: Array<Record<string, unknown>> = [];
    /** 提供者被问过哪些画布；用来证明解析是逐画布发生的。 */
    const resolvedCanvases: string[] = [];
    /** 模拟扩展：允许同步的画布集合（登录不改变它，只有显式启用才加入）。 */
    const enabled = new Set<string>();
    const link: CanvasUpstreamLink = { url: "ws://upstream.invalid", token: "token-a" };
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "canvas-upstream-test",
      activate: (host) => {
        host.registerCapability({
          id: PROVIDER_CAPABILITY, version: 1, value: {
            providerId: "test-upstream",
            resolve: async (canvasId: string) => {
              resolvedCanvases.push(canvasId);
              return enabled.has(canvasId) ? link : null;
            },
            describe: () => "测试上游"
          }
        });
      }
    };
    const service = await createBackendService({
      env: {
        WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
        WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
        WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
        WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
      },
      logger: (event) => events.push(event),
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: true,
      applicationBackendExtensions: [definition],
      // 不写进 applicationExtensionMetadata：那会把它当成站点扩展交给站点控制面启停，
      // 而本用例要验证的是「后端 runtime 激活的扩展晚于 canvas 装载」这条路径。
      applicationExtensionMetadata: []
    });
    const syncCalls = () => events.filter((event) => event.event === "sync-upstream-offline");
    try {
      const canvasService = service.modules().canvas.composition!.service;
      await canvasService.createCanvas({ canvasId: "c-sync", title: "同步测试" });

      // 客户端打开画布（acquire）时宿主必须已经能解析到提供者，并按画布询问。
      // 内部消费者用 resolve() 只拿文档、不挂上游（任务对账不该把没打开的画布推给远端），
      // 所以这里必须走 acquire，与浏览器进页面同一条路径。
      const lease = await service.modules().canvas.sync!.registry.acquire("c-sync");
      try {
        await waitFor(() => resolvedCanvases.includes("c-sync"));

      // 未启用：提供者给 null，不应出现任何中继链路事件。
      expect(syncCalls().some((event) => event.canvasId === "c-sync")).toBe(false);

      // 显式启用这张画布：refresh 后重新解析同一张画布，并真的开始建链路。
      const before = resolvedCanvases.filter((id) => id === "c-sync").length;
      enabled.add("c-sync");
      await service.modules().canvas.refreshUpstream();
      await waitFor(() => resolvedCanvases.filter((id) => id === "c-sync").length > before);
      // 链路尝试连接一个不可达地址：以 offline 事件证明链路确实建立了。
      await waitFor(() => syncCalls().some((event) => event.canvasId === "c-sync"));

      // 换会话（等价于重新登录）仍按画布重新解析。
      const beforeRelogin = resolvedCanvases.length;
      await service.modules().canvas.refreshUpstream();
      await waitFor(() => resolvedCanvases.length > beforeRelogin);
      expect(resolvedCanvases.every((id) => id === "c-sync")).toBe(true);
      } finally {
        lease.release();
      }
    } finally {
      await service.close();
    }
  }, 30_000);
});
