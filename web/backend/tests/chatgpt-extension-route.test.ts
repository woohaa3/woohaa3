/**
 * ChatGPT 插件公开路由集成测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 5.4）。
 *
 * 验证：统一后端经唯一宿主把 `/api/oauth-agent/*` 公开映射分派到 ChatGPT 插件（原始 HTTP handler），
 * 而不是任何手工在 composition 中注册的路由。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendService } from "../src/composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-chatgpt-route-"));
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

async function boot() {
  const dir = tempDir();
  const service = await createBackendService({
    env: {
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"),
      // 本地开发姿态：允许本地会话；未配置凭据目录 → 服务进入 not-configured 分支，仍应返回 503。
      WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK: "1"
    },
    logger: () => {},
    modelsConfig: { version: 1, models: [] },
    mediaStorage: memoryStorage() as never,
    enableYjsSync: false
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    service,
    async close() {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe("ChatGPT 插件公开路由", () => {
  it("/api/oauth-agent/status 由插件经统一宿主分派（非 404）", async () => {
    const app = await boot();
    try {
      const plane = app.service.modules().application.plugins();
      expect(await plane.write({ extensionId: "oauth-agent", expectedRevision: plane.snapshot().revision, enabled: true, values: {}, secretRefs: [], actor: "tester" })).toMatchObject({ ok: true });
      const res = await fetch(`${app.base}/api/oauth-agent/status`);
      // 插件已处理该路由：未配置凭据时返回明确的 503 not-configured（而非 404 未注册）。
      expect([200, 503]).toContain(res.status);
      if (res.status === 503) {
        const body = (await res.json()) as { code?: string };
        expect(body.code).toBe("not-configured");
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it("ChatGPT 和全部内置 Provider 出现在设置页插件配置使用的站点列表", async () => {
    const app = await boot();
    try {
      const snapshot = (await (await fetch(`${app.base}/api/extensions`)).json()) as { catalog: Array<{ extensionId: string }> };
      expect(snapshot.catalog.some((entry) => entry.extensionId === "oauth-agent")).toBe(true);
      // 插件管理器读取同一公共 catalog；所有内置 Provider 都必须可见。
      for (const extensionId of ["tokenhub-provider", "replicate-provider", "fal-provider", "grsai-provider", "runninghub-provider", "ark-provider"]) {
        expect(snapshot.catalog.some(entry => entry.extensionId === extensionId), extensionId).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
