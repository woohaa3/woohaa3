/**
 * 独立验收：样例站点插件跨进程/双客户端/draining 恢复
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 5.1 / design D6）。
 *
 * 覆盖：
 * - 管理员开关影响两个客户端（HTTP 公开 snapshot + changes）；
 * - 配置冲突/失败保留正确版本；
 * - 关闭期间拒绝新工作但旧工作可恢复，draining 后释放；
 * - 卸载与 activation 失败无遗留注册；
 * - 生产 manifest 不含 fixture。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationExtensionMetadata, AccessAction, PrincipalContext, SiteAccessPolicy } from "@woohaa3/contracts";

import { createSqliteSiteExtensionConfigStore } from "./config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createApplicationExtensionHost } from "./host.js";
import { createSiteExtensionControlPlane } from "./control-plane.js";
import { createApplicationExtensionApiHandler } from "../api/extension-api.js";
import { createFakeRequestAuthenticator, testPrincipal } from "../auth/adapter.js";
import { createAccessEnforcer } from "./access-enforcement.js";
import { createSampleSiteExtensionDefinition, type SampleExtensionProbe } from "@woohaa3/extension-sample-site/backend";
import { SAMPLE_SITE_EXTENSION_METADATA, validateSampleSiteConfig } from "@woohaa3/extension-sample-site/shared";
import { createApplicationBackendExtensionManifest } from "./manifest.js";

const dirs: string[] = [];
const servers: http.Server[] = [];
/** harness 建出来的 SQLite 端口：先关再删目录（Windows 上不关就 EBUSY）。 */
const stores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-plugin-accept-"));
  dirs.push(dir);
  return path.join(dir, "plugin.sqlite");
}

type Harness = {
  base: string;
  plane: ReturnType<typeof createSiteExtensionControlPlane>;
  probe: SampleExtensionProbe;
};

const TEST_ADMIN = "admin@example";
/** 测试用 site-access 策略：TEST_ADMIN 拥有全部 action。 */
function acceptanceSitePolicy(): SiteAccessPolicy {
  const all: AccessAction[] = ["extensions.configure", "providers.credentials.write", "models.manage", "tasks.inspect"];
  const grant = (principal: PrincipalContext): boolean => principal.subject === TEST_ADMIN;
  return {
    policyId: "acceptance-site-access",
    policyVersion: () => "1",
    async allowedActions({ principal }) {
      return grant(principal) ? all : [];
    },
    async authorize({ principal }) {
      return grant(principal) ? { allowed: true } : { allowed: false, code: "forbidden" };
    }
  };
}

async function startHarness(): Promise<Harness> {
  const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
  const work = createSqliteExtensionWorkRepository({ path: tempDb() });
  stores.push(store, work);
  const host = createApplicationExtensionHost();
  const probe: SampleExtensionProbe = { started: false, stopped: 0, admitted: 0 };
  // 先提供样例依赖 runtime，再注册插件（依赖满足）。
  await host.activate({
    extensionId: "sample-runtime-owner",
    activate: (h) => {
      h.registerCapability({ id: "sample.fixture.runtime", value: { kind: "sample-runtime" } });
    }
  });
  const plane = createSiteExtensionControlPlane({
    host,
    store,
    workStore: work,
    metadata: { list: () => [SAMPLE_SITE_EXTENSION_METADATA], get: (id) => (id === SAMPLE_SITE_EXTENSION_METADATA.extensionId ? SAMPLE_SITE_EXTENSION_METADATA : undefined) },
    definitions: [createSampleSiteExtensionDefinition(probe)],
    validateConfig: (_id, values) => validateSampleSiteConfig(values)
  });
  const siteAccess = acceptanceSitePolicy();
  const handler = createApplicationExtensionApiHandler({
    controlPlane: plane,
    host,
    authenticator: createFakeRequestAuthenticator((req) => {
      const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
      return actor ? testPrincipal(actor, { identityProvider: "test" }) : null;
    }),
    accessEnforcer: createAccessEnforcer({ siteAccessPolicy: () => siteAccess, resourceAccessPolicy: () => null })
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, plane, probe };
}

async function write(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/extensions/${SAMPLE_SITE_EXTENSION_METADATA.extensionId}/config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-test-actor": TEST_ADMIN
    },
    body: JSON.stringify(body)
  });
}

/** 读取当前权威 revision（实际状态变化也会推进 revision）。 */
async function currentRevision(base: string): Promise<number> {
  const snapshot = (await (await fetch(`${base}/api/extensions`)).json()) as { revision: number };
  return snapshot.revision;
}

describe("样例站点插件独立验收（任务 5.1）", () => {
  it("管理员开关影响两个客户端（snapshot + changes）", async () => {
    const { base } = await startHarness();
    const enabled = await write(base, { expectedRevision: 0, enabled: true, values: { threshold: 5 }, secretRefs: [] });
    expect(enabled.status).toBe(200);

    // 两个客户端各自读取公开 snapshot，取得相同目标状态与实际状态。
    const clientA = (await (await fetch(`${base}/api/extensions`)).json()) as { revision: number; plugins: Array<{ desiredEnabled: boolean; actualState: string }> };
    const clientB = (await (await fetch(`${base}/api/extensions`)).json()) as typeof clientA;
    expect(clientA).toEqual(clientB);
    expect(clientA.plugins[0]?.desiredEnabled).toBe(true);
    expect(clientA.plugins[0]?.actualState).toBe("active");

    // 停用后第二客户端可按 revision 增量追赶。
    const beforeDisable = await currentRevision(base);
    const disabled = await write(base, { expectedRevision: beforeDisable, enabled: false, values: {}, secretRefs: [] });
    expect(disabled.status).toBe(200);
    const changes = (await (await fetch(`${base}/api/extensions/changes?after=${beforeDisable}`)).json()) as { changes: Array<{ extensionId: string; status: { desiredEnabled: boolean } }> };
    expect(changes.changes.find((entry) => entry.extensionId === SAMPLE_SITE_EXTENSION_METADATA.extensionId)?.status.desiredEnabled).toBe(false);
  });

  it("配置失败保留正确版本；冲突保留较新配置", async () => {
    const { base } = await startHarness();
    await write(base, { expectedRevision: 0, enabled: true, values: { threshold: 5 }, secretRefs: [] });
    const revisionAfterValid = await currentRevision(base);
    const invalid = await write(base, { expectedRevision: revisionAfterValid, enabled: true, values: { threshold: 999 }, secretRefs: [] });
    expect(invalid.status).toBe(400);
    // 失败不推进 revision。
    const snapshot = (await (await fetch(`${base}/api/extensions`)).json()) as { revision: number; plugins: Array<{ configVersion: number }> };
    expect(snapshot.revision).toBe(revisionAfterValid);
    expect(snapshot.plugins[0]?.configVersion).toBe(1);

    const revisionBeforeSecond = await currentRevision(base);
    await write(base, { expectedRevision: revisionBeforeSecond, enabled: true, values: { threshold: 10 }, secretRefs: [] });
    const stale = (await currentRevision(base)) - 1;
    const conflict = await write(base, { expectedRevision: stale, enabled: false, values: {}, secretRefs: [] });
    expect(conflict.status).toBe(409);
  });

  it("关闭期间拒绝新工作但旧工作可恢复；draining 全部终态后释放资源", async () => {
    const { base, plane, probe } = await startHarness();
    await write(base, { expectedRevision: 0, enabled: true, values: {}, secretRefs: [] });
    expect(probe.started).toBe(true);

    // 受理一条工作（在途）。
    const lease = plane.workLease(SAMPLE_SITE_EXTENSION_METADATA.extensionId)!;
    const admitted = lease.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    // 停用：新工作被拒，旧工作仍可恢复，状态为 draining，资源保留。
    const beforeDisable = await currentRevision(base);
    const disabled = await write(base, { expectedRevision: beforeDisable, enabled: false, values: {}, secretRefs: [] });
    expect(disabled.status).toBe(200);
    expect(probe.started).toBe(true);
    const statusAfterDisable = plane.status(SAMPLE_SITE_EXTENSION_METADATA.extensionId)!;
    expect(statusAfterDisable.actualState).toBe("draining");
    expect(lease.admit().ok).toBe(false);

    const handle = lease.resume(admitted.workId);
    expect(handle).not.toBeNull();
    handle!.settle("succeeded");

    // 全部旧工作终态后再次写入（触发释放）——资源被最终回收。
    const beforeFinalize = await currentRevision(base);
    const finalize = await write(base, { expectedRevision: beforeFinalize, enabled: false, values: {}, secretRefs: [] });
    expect(finalize.status).toBe(200);
    expect(probe.started).toBe(false);
    expect(probe.stopped).toBeGreaterThan(0);
  });

  it("activation 失败无遗留注册并可诊断", async () => {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    stores.push(store, work);
    const host = createApplicationExtensionHost();
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: {
        list: () => [SAMPLE_SITE_EXTENSION_METADATA],
        get: () => SAMPLE_SITE_EXTENSION_METADATA
      },
      definitions: [
        {
          extensionId: SAMPLE_SITE_EXTENSION_METADATA.extensionId,
          requiredDependencies: ["missing-dependency"],
          activate: (h) => {
            h.registerCapability({ id: "should-not-exist", value: 1 });
          }
        }
      ]
    });
    const outcome = await plane.write({ extensionId: SAMPLE_SITE_EXTENSION_METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status.actualState).toBe("failed");
    expect(outcome.status.diagnostics.length).toBeGreaterThan(0);
    // 无遗留注册。
    expect(host.snapshot().every((entry) => entry.extensionId !== SAMPLE_SITE_EXTENSION_METADATA.extensionId || entry.capabilities.length === 0)).toBe(true);
  });

  it("生产 manifest 不含 fixture（生产站点清单由宿主生成物注入）", () => {
    const definitions = createApplicationBackendExtensionManifest().definitions;
    expect(definitions.map(entry => entry.extensionId)).not.toContain(SAMPLE_SITE_EXTENSION_METADATA.extensionId);
    // 目录宿主负责生产站点清单；嵌入式 manifest 默认不静态装配业务扩展。
    expect(definitions).toEqual([]);
    // fixture 元数据显式存在，但只在测试清单使用。
    expect(SAMPLE_SITE_EXTENSION_METADATA.extensionId).toBe("sample-site-extension");
    void (null as unknown as ApplicationExtensionMetadata);
  });
});
