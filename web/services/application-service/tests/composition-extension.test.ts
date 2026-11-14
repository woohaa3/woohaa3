/**
 * Application Service 组合根站点插件接线测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.1 / 3.2；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/3.5）。
 *
 * 验证 createApplicationService 挂载站点插件 API：公开状态可读、管理写入经可信认证、
 * 生产清单不含 fixture、健康检查可用。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplicationService } from "../src/composition.js";
import { createFakeRequestAuthenticator, testPrincipal } from "../src/auth/adapter.js";
import type { ApplicationBackendExtensionDefinition } from "../src/extensions/contract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 测试用后端扩展定义：验证装配机制（清单登记、启用状态、能力注入）本身，
 * 不绑定任何具体业务扩展。私有扩展（如 game-furnace）迁出公开仓后仍能覆盖同一路径。
 */
function testBackendExtension(): ApplicationBackendExtensionDefinition {
  return {
    extensionId: "test-fixture-extension",
    activate() {},
  };
}

/** 测试用 site-access 策略：允许全部 action（生产由 site-access 扩展提供）。 */
function allowAllSitePolicy(): import("@woohaa3/contracts").SiteAccessPolicy {
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions() {
      return ["extensions.configure", "providers.credentials.write", "models.manage", "tasks.inspect"];
    },
    async authorize() {
      return { allowed: true };
    }
  };
}

describe("Application Service 站点插件接线", () => {
  it("宿主注入的站点扩展挂载 /api/extensions，健康检查可用", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-application-plugin-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      serviceToken: "svc",
      authenticator: createFakeRequestAuthenticator((req) => {
        const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
        return actor ? testPrincipal(actor, { identityProvider: "test" }) : null;
      }),
      // 显式注入基础 site-access 提供者（生产由 site-access 扩展登记）。
      seedProviders: { siteAccess: allowAllSitePolicy() },
      // 生产由宿主（web/backend）从启动期扩展宿主注入站点目录与后端定义；
      // 本测试显式注入等价 fixture（change: 2026-10-15-...，任务 4.3：Application 不再内建生产清单）。
      applicationExtensionMetadata: [
        {
          extensionId: "test-fixture-extension",
          name: "装配路径 fixture",
          description: "验证站点清单登记、启用状态与后端定义装配；不绑定具体业务扩展。",
          version: "0.1.0",
          managementScope: "site",
          host: "backend",
          configSchema: { schemaId: "test-fixture-extension-config", schemaVersion: 1 },
          dependencies: [],
          capabilities: [{ id: "test-fixture-extension.run", kind: "capability", description: "装配路径 fixture" }],
          defaultEnabled: true
        },
        {
          extensionId: "legacy-import",
          name: "LegacyCanvas 旧画布迁移",
          description: "只读恢复旧 LegacyCanvas 画布（Mongo/SQLite/目录快照）并转换为当前格式候选。",
          version: "0.1.0",
          managementScope: "site",
          host: "backend",
          configSchema: { schemaId: "legacy-import-config", schemaVersion: 1 },
          dependencies: [],
          capabilities: [{ id: "canvas-source:legacy-source", kind: "capability", description: "受控外部画布来源" }],
          defaultEnabled: false
        }
      ],
      applicationBackendExtensions: [testBackendExtension()]
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
    const base = `http://127.0.0.1:${port}`;
    try {
      const snapshot = (await (await fetch(`${base}/api/extensions`)).json()) as { revision: number; plugins: Array<{ extensionId: string; actualState: string; desiredEnabled: boolean }> };
      expect(snapshot.revision).toBeGreaterThanOrEqual(0);
      // 注入清单登记 test-fixture-extension（有后端定义，默认启用）与只有元数据的 legacy-import（未配置）。
      expect(snapshot.plugins).toContainEqual(expect.objectContaining({ extensionId: "test-fixture-extension", actualState: "active", desiredEnabled: true }));
      expect(snapshot.plugins).toContainEqual(expect.objectContaining({ extensionId: "legacy-import", actualState: "unconfigured", desiredEnabled: false }));

      const live = await fetch(`${base}/api/application/health/live`);
      expect(live.status).toBe(200);

      // 未知插件写入被拒绝（生产清单不含 fixture）。
      const write = await fetch(`${base}/api/extensions/sample-site-extension/config`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-woohaa3-test-actor": "admin" },
        body: JSON.stringify({ expectedRevision: 0, enabled: true, values: {}, secretRefs: [] })
      });
      expect(write.status).toBe(404);
    } finally {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("后端入口清单可由测试注入且不进入生产清单", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-application-plugin-inject-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      applicationExtensionMetadata: [
        {
          extensionId: "sample-site-extension",
          name: "样例",
          description: "测试",
          version: "1.0.0",
          managementScope: "site",
          host: "application",
          configSchema: { schemaId: "s", schemaVersion: 1 },
          dependencies: [],
          capabilities: []
        }
      ],
      applicationBackendExtensions: [{ extensionId: "sample-site-extension", activate: () => ({}) }]
    });
    expect(service.plugins().status("sample-site-extension")?.actualState).toBe("unconfigured");
    await service.close();
  });

  it("宿主会话 API 复用统一 Identity provider", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-application-identity-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      seedProviders: { identity: {
        providerId: "fake-agent-provider",
        authenticate: async () => ({ ok: true, principal: testPrincipal("user-a") })
      } },
      conversationCanvasAccess: { authorize: async () => ({ ok: true as const }) }
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
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-conversations/mcp`);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("没有统一 Identity provider 时返回 503，插件本地会话不能绕过", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-application-no-identity-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      accessRuntime: { enabled: true },
      conversationCanvasAccess: { authorize: async () => ({ ok: true as const }) }
    });
    await service.host().activate({
      extensionId: "legacy-local-session",
      activate(host) {
        host.registerCapability({ id: "agent-conversation-identity", version: 1, value: {
          resolveLocalSession: () => ({ subject: "local:spoof", sessionId: "local:spoof" })
        } });
        return {};
      }
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
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-conversations/mcp`);
      expect(response.status).toBe(503);
    } finally {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
