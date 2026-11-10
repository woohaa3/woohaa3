/**
 * ChatGPT 插件公开路由集成测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 5.4）。
 *
 * 验证：统一后端经唯一宿主把 `/api/oauth-agent/*` 公开映射分派到 ChatGPT 插件（原始 HTTP handler），
 * 而不是任何手工在 composition 中注册的路由。
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      // 配置与密钥必须落在临时目录：本用例会写扩展启停，不能碰仓库里的真实配置。
      WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
      WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
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

  it("ChatGPT 在控制面 catalog；Provider 出现在设置页插件清单（带 configPrefix）", async () => {
    const app = await boot();
    try {
      const snapshot = (await (await fetch(`${app.base}/api/extensions`)).json()) as {
        catalog: Array<{ extensionId: string; directory: string }>;
      };
      expect(snapshot.catalog.some((entry) => entry.extensionId === "oauth-agent")).toBe(true);
      // catalog 只列**可激活**的扩展：有后端定义，或声明了 `site` 的扩展层插件。
      // 纯前端扩展（两者都没有）进了 catalog 只会永远停在 `configuring`，面板显示「正在应用…」。
      for (const entry of snapshot.catalog) {
        const descriptor = JSON.parse(readFileSync(path.join(entry.directory, "extension.json"), "utf8")) as {
          backend?: unknown;
          hostPlugin?: unknown;
        };
        expect(Boolean(descriptor.backend ?? descriptor.hostPlugin), `${entry.extensionId} 应可激活`).toBe(true);
      }
      // Provider 自带 Config 与装配入口，由设置面按配置段管理；控制面 catalog 只列有后端入口的扩展。
      const settings = (await (await fetch(`${app.base}/api/settings`)).json()) as {
        plugins: Array<{ id: string; configPrefix?: string; siteManaged: boolean }>;
      };
      for (const providerId of ["tokenhub", "replicate", "fal", "grsai", "ark", "deepseek"]) {
        const row = settings.plugins.find((entry) => entry.id === `${providerId}-provider`);
        expect(row, `${providerId}-provider`).toBeDefined();
        expect(row?.configPrefix, `${providerId}-provider`).toBe(`providers.${providerId}`);
        // 启停不再由站点控制面管理。
        expect(row?.siteManaged, `${providerId}-provider`).toBe(false);
      }
      // RunningHub 同时声明了 `site` 段（余额 handler），因此它仍属于站点控制面；
      // 这一行与上面那批的差异是真实状态，不是遗漏。
      const runninghub = settings.plugins.find((entry) => entry.id === "runninghub-provider");
      expect(runninghub).toMatchObject({ configPrefix: "providers.runninghub", siteManaged: true });
    } finally {
      await app.close();
    }
  }, 30_000);
});
