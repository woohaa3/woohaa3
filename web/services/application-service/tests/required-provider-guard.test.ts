/**
 * 必需基础提供者在线停用拒绝（change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.5）。
 *
 * 站点控制面必须拒绝停用部署 profile 中的必需 provider，并返回稳定 `required-provider`：
 * chrome/UI 据此引导「经发布/重启更新部署 profile」，而不是提供在线开关。
 * 非必需插件仍可正常启停。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplicationService } from "../src/composition.js";
import { createFakeRequestAuthenticator, testPrincipal } from "../src/auth/adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function metadataFor(extensionId: string) {
  return {
    extensionId,
    name: extensionId,
    description: `${extensionId} 测试`,
    version: "1.0.0",
    managementScope: "site" as const,
    host: "application" as const,
    configSchema: { schemaId: `${extensionId}-config`, schemaVersion: 1 },
    dependencies: [],
    capabilities: []
  };
}

describe("必需基础提供者在线停用（任务 1.5）", () => {
  it("停用必需 provider 返回 required-provider；非必需插件仍可停用", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-required-provider-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      applicationExtensionMetadata: [metadataFor("test-identity"), metadataFor("optional-plugin")],
      applicationBackendExtensions: [
        { extensionId: "test-identity", activate: () => ({}) },
        { extensionId: "optional-plugin", activate: () => ({}) }
      ],
      requiredProviders: [{ slot: "identity", extensionId: "test-identity" }]
    });
    try {
      const rejected = await service.plugins().write({
        extensionId: "test-identity",
        expectedRevision: 0,
        enabled: false,
        values: {},
        secretRefs: [],
        actor: "admin"
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.code).toBe("required-provider");

      const optional = await service.plugins().write({
        extensionId: "optional-plugin",
        expectedRevision: service.plugins().snapshot().revision,
        enabled: true,
        values: {},
        secretRefs: [],
        actor: "admin"
      });
      expect(optional.ok).toBe(true);
      const disabled = await service.plugins().write({
        extensionId: "optional-plugin",
        expectedRevision: service.plugins().snapshot().revision,
        enabled: false,
        values: {},
        secretRefs: [],
        actor: "admin"
      });
      expect(disabled.ok).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("HTTP PUT 停用必需 provider 返回 409 与稳定 required-provider 码", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-required-provider-http-"));
    dirs.push(dir);
    const service = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
      authenticator: createFakeRequestAuthenticator(() => testPrincipal("admin", { identityProvider: "test" })),
      seedProviders: { siteAccess: allowAllSitePolicy() },
      applicationExtensionMetadata: [metadataFor("test-identity")],
      applicationBackendExtensions: [{ extensionId: "test-identity", activate: () => ({}) }],
      requiredProviders: [{ slot: "identity", extensionId: "test-identity" }]
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
      const response = await fetch(`http://127.0.0.1:${port}/api/extensions/test-identity/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, enabled: false, values: {}, secretRefs: [] })
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("required-provider");
      expect(body.message).toContain("发布/重启");
    } finally {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
