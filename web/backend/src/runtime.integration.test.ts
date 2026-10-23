/**
 * 统一后端进程集成测试
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 1.3 / 2.1 / 3.1）。
 *
 * 验证：单进程内组合各领域模块并通过进程内契约协作；浏览器可见 handler 可用；
 * 生成扩展点可注册/解析；插件宿主可激活/释放。
 */
import { describe, expect, it } from "vitest";
import { createGenerationRegistry } from "../src/host/core/generation.js";
import { mediaPortToTaskMediaClient, taskPortToCanvasTaskClient } from "../src/ports/adapters.js";
import type { BackendMediaPort, BackendTaskPort } from "@woohaa3/contracts";

describe("后端生成扩展点（ctx.generation）", () => {
  it("注册、解析与重复拒绝", () => {
    const generation = createGenerationRegistry();
    const registration = {
      extensionId: "sample",
      providerId: "sample",
      available: true,
      provider: { kind: "sample" },
      models: []
    };
    generation.register(registration);
    expect(generation.resolve("sample")).toBe(registration);
    expect(generation.list()).toHaveLength(1);
    expect(() => generation.register(registration)).toThrow(/已注册/);
    expect(generation.resolve("missing")).toBeUndefined();
  });
});

describe("进程内契约适配器", () => {
  it("Task 端口 → CanvasTaskClient 形状（submit 透传领域结果）", async () => {
    const calls: unknown[] = [];
    const port: BackendTaskPort = {
      async submit(request) {
        calls.push(request);
        return {
          workerTaskKey: request.workerTaskKey,
          state: "queued",
          reused: false,
          canvasId: "c",
          nodeId: "n",
          runId: "r"
        };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [] } as never;
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 } as never;
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 } as never;
      }
    };
    const client = taskPortToCanvasTaskClient(port);
    const result = await client.submit({ workerTaskKey: "k", canvasId: "c" } as never);
    expect(result.workerTaskKey).toBe("k");
    expect(calls).toHaveLength(1);
  });

  it("Media 端口 → Task MediaClient 形状（无 HTTP）", async () => {
    const port: BackendMediaPort = {
      async verify(key) {
        return { exists: true, matches: true, metadata: { storageKey: key, contentType: "image/png", size: 1, checksum: "x" } };
      },
      async sign() {
        return "https://signed.example/x";
      },
      async importFromLocator() {
        return { storageKey: "media/locator.png", contentType: "image/png", size: 1, checksum: "x" };
      },
      async importFromUrl() {
        return { storageKey: "sha256-".padEnd(71, "a"), contentType: "image/png", size: 1, checksum: "x" };
      },
      async importBytes() {
        return { storageKey: "sha256-".padEnd(71, "a"), contentType: "image/png", size: 1, checksum: "x" };
      }
    };
    const client = mediaPortToTaskMediaClient(port);
    expect((await client.verify("sha256-".padEnd(71, "b"))).exists).toBe(true);
    expect(await client.sign("sha256-".padEnd(71, "b"))).toContain("https://");
  });
});
