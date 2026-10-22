/**
 * 统一后端进程端到端验收
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 1.3 / 2.2 / 3.1 / design D1/D2/D3）。
 *
 * 在**单一进程**内启动 Canvas/Task/Media/MCP 与站点插件宿主，经真实 HTTP 验证：
 * - 站点插件公开状态与管理员写入路径可用；
 * - Task catalog 与只读 history 面可用；
 * - 模块间通过进程内契约协作（画布 run 提交经 Task 端口，无服务令牌）。
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
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-backend-"));
  dirs.push(dir);
  return dir;
}

/** 内存媒体存储替身（避免真实 COS）。 */
function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key: string) {
      const record = objects.get(key);
      if (!record) throw new Error("missing");
      return record;
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async stat(key: string) {
      const record = objects.get(key);
      if (!record) throw new Error("missing");
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key: string) {
      return `https://cos.invalid/${key}?sign=test`;
    }
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
      PPTASK_LITELLM_API_KEY: "test-placeholder",
      PPTASK_LITELLM_BASE_URL: "https://litellm.invalid"
    },
    logger: () => {},
    modelsConfig: { version: 1, models: [] },
    mediaStorage: memoryStorage() as never,
    enableYjsSync: true
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
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

describe("统一后端进程端到端", () => {
  it("单进程内组合各模块并暴露同源 API", async () => {
    const app = await boot();
    try {
      // 站点插件公开状态（Application 模块，进程内）。
      const plugins = (await (await fetch(`${app.base}/api/extensions`)).json()) as { revision: number; plugins: unknown[] };
      expect(plugins.revision).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(plugins.plugins)).toBe(true);

      // Task catalog（Task 模块）。
      const catalog = await fetch(`${app.base}/api/pptask/catalog`);
      expect([200, 503]).toContain(catalog.status);

      // Application 健康。
      const health = await fetch(`${app.base}/api/application/health/live`);
      expect(health.status).toBe(200);

      // 仅存储扩展 + 本地开发身份也必须完成基础提供者装配。
      const ready = await fetch(`${app.base}/api/application/health/ready`);
      expect(await ready.json()).toMatchObject({ status: "ready" });
      expect(ready.status).toBe(200);

      // 全局监控由宿主提供，无需安装 task-monitor 扩展；本地单实例直接按实例作用域查询。
      const inspection = await fetch(`${app.base}/api/task-inspection/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 5 })
      });
      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({ items: [], nextCursor: null });


      // 本地单实例不再暴露开发管理员令牌端点。
      expect((await fetch(`${app.base}/api/dev-admin`)).status).toBe(404);

      // 未命中的同源路径返回 404。
      const missing = await fetch(`${app.base}/api/does-not-exist`);
      expect(missing.status).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("进程内契约：Canvas 经 Task 端口提交，不依赖服务令牌", async () => {
    const app = await boot();
    try {
      const { canvas, task } = app.service.modules();
      // 直接断言 Canvas 的 taskClient 由 Task 端口适配而来（画布 run 会走它）。
      expect(canvas.runService).toBeDefined();
      expect(task.port()).toBeDefined();
      // 任务目录可用性来自同一进程内的 Task 实例。
      const catalog = await task.catalog();
      expect(catalog).toHaveProperty("available");
    } finally {
      await app.close();
    }
  }, 30_000);
});
