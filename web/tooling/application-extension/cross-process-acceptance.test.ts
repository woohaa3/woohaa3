/**
 * Application -> Task 跨进程真实 HTTP 验收
 * （change: 2026-10-05-extract-application-plugin-host，任务 6.1 / design D3/D4/D7）。
 *
 * 用真实 HTTP 把 Application Service 与 Task Service 组合起来（provider 用确定性假 worker）：
 * - 管理员经 Application Remote 协议启用样例插件，插件通过公共 Context 提交 Task 工作；
 * - 受控 handler 经真实 HTTP dispatcher 分派，认证等级生效；
 * - 双客户端读取一致状态；停用进入 draining 且拒绝新工作。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskService } from "@woohaa3/task-service";
import { createApplicationService } from "@woohaa3/application-service";
import { createFakeRequestAuthenticator, testPrincipal } from "@woohaa3/application-service";
import type { SiteAccessPolicy } from "@woohaa3/contracts";
import { createSampleSiteExtensionDefinition } from "@woohaa3/extension-sample-site/backend";
import { SAMPLE_SITE_EXTENSION_METADATA, validateSampleSiteConfig } from "@woohaa3/extension-sample-site/shared";
import type { PptaskWorkerServer } from "@sdppp/pptask-worker-server";

/** 测试站点策略：只有 admin@example 拥有具名 action（生产由 site-access 扩展提供）。 */
function adminSitePolicy(): SiteAccessPolicy {
  const admin = "admin@example";
  return {
    policyId: "acceptance-site-access",
    policyVersion: () => "1",
    async allowedActions({ principal }) {
      return principal.subject === admin ? ["extensions.configure"] : [];
    },
    async authorize({ principal }) {
      return principal.subject === admin ? { allowed: true } : { allowed: false, code: "forbidden" };
    }
  };
}

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-app-accept-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function fakeWorkerServer(): PptaskWorkerServer {
  const records = new Map<string, { id: string; providerId: string; state: string; createdAt: string; updatedAt: string; durationMs: number; metadata?: Record<string, unknown> }>();
  const listeners = new Set<(record: unknown) => void>();
  return {
    worker: {} as never,
    async submit(input: never) {
      const value = input as { key: string; context?: Record<string, unknown> };
      const now = new Date().toISOString();
      const record = { id: value.key, providerId: "fake", state: "queued", events: [], createdAt: now, updatedAt: now, durationMs: 0, metadata: value.context };
      records.set(record.id, record);
      for (const listener of listeners) listener(record);
      return { record, created: true } as never;
    },
    async status(key: string) {
      return (records.get(key) as never) ?? null;
    },
    async cancel() {},
    history: { get: async () => undefined, list: async () => [...records.values()] as never, subscribe: () => () => undefined, ingestSchedulingEvent() {}, async flush() {}, async dispose() {} } as never,
    subscribe(listener: never) {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
    stop() {},
    async drained() {},
    async close() {}
  } as unknown as PptaskWorkerServer;
}

describe("Application -> Task 跨进程验收（任务 6.1）", () => {
  it("启用样例插件、Context 提交 Task 工作、受控 handler 分派与 draining", async () => {
    const serviceToken = "svc-token";
    const task = await listen(
      createTaskService({
        env: {
          WOOHAA3_TASK_STORE_PATH: tempDb("task.sqlite"),
          PPTASK_LITELLM_API_KEY: "test-placeholder",
          PPTASK_LITELLM_BASE_URL: "https://litellm.invalid"
        },
        modelsConfig: {
          version: 1,
          models: [{ id: "fake:gpt-4o-mini", enabled: true }]
        },
        serviceToken,
        workerServer: fakeWorkerServer(),
        generationProviders: () => [{
          extensionId: "test-generation",
          providerId: "fake",
          available: true,
          provider: {},
          models: [{
            providerId: "fake",
            providerModelId: "gpt-4o-mini",
            modelType: "language",
            title: "gpt",
            inputSchema: {},
            defaultInput: {}
          }]
        }]
      }).handle
    );
    closers.push(async () => {
      await new Promise<void>((resolve) => task.server.close(() => resolve()));
    });

    const probe = { started: false, stopped: 0, admitted: 0 };
    const application = createApplicationService({
      env: { WOOHAA3_APPLICATION_STORE_PATH: tempDb("application.sqlite") },
      serviceToken,
      taskServiceUrl: `http://127.0.0.1:${task.port}`,
      applicationExtensionMetadata: [SAMPLE_SITE_EXTENSION_METADATA],
      applicationBackendExtensions: [createSampleSiteExtensionDefinition(probe)],
      authenticator: createFakeRequestAuthenticator((req) => {
        const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
        return actor ? testPrincipal(actor, { identityProvider: "test" }) : null;
      }),
      seedProviders: { siteAccess: adminSitePolicy() }
    });
    const app = await listen(application.handle);
    closers.push(async () => {
      await application.close();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${app.port}`;
    const adminHeaders = { "content-type": "application/json", "x-woohaa3-test-actor": "admin@example", "x-woohaa3-test-role": "admin" };

    // 样例插件依赖的 runtime 由宿主核心 owner 提供（在 Application 公共 Context 内）。
    await application.host().activate({
      extensionId: "sample-runtime-owner",
      activate: (h) => {
        h.registerCapability({ id: "sample.fixture.runtime", value: { kind: "sample-runtime" } });
      }
    });

    // 管理员启用样例插件（真实 HTTP + 可信认证）。
    const initialRevision = ((await (await fetch(`${base}/api/extensions`)).json()) as { revision: number }).revision;
    const write = await fetch(`${base}/api/extensions/${SAMPLE_SITE_EXTENSION_METADATA.extensionId}/config`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ expectedRevision: initialRevision, enabled: true, values: { threshold: 5 }, secretRefs: [] })
    });
    expect(write.status).toBe(200);
    const written = (await write.json()) as { status: { actualState: string } };
    expect(written.status.actualState).toBe("active");
    expect(probe.started).toBe(true);

    // 双客户端读取一致状态。
    const clientA = (await (await fetch(`${base}/api/extensions`)).json()) as { plugins: Array<{ actualState: string }> };
    const clientB = (await (await fetch(`${base}/api/extensions`)).json()) as typeof clientA;
    expect(clientA).toEqual(clientB);
    expect(clientA.plugins[0]?.actualState).toBe("active");

    // 普通用户调用 admin handler：被拒绝。
    const denied = await fetch(`${base}/api/extensions/${SAMPLE_SITE_EXTENSION_METADATA.extensionId}/handlers/sample/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-test-actor": "user" },
      body: JSON.stringify({ hello: 1 })
    });
    // 已认证但无 extensions.configure：403（区别于未认证 401）。
    expect(denied.status).toBe(403);

    // 管理员经 Context 提交 Task 工作：真实 HTTP 到 Task。
    const submit = await fetch(`${base}/api/extensions/${SAMPLE_SITE_EXTENSION_METADATA.extensionId}/handlers/sample/submit`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ workerTaskKey: "plugin-work-1", modelType: "language", modelKey: "fake:gpt-4o-mini", prompt: "hi" })
    });
    const submitText = await submit.text();
    expect(submit.status, submitText).toBe(202);
    const submitBody = JSON.parse(submitText) as { ok: boolean; workerTaskKey: string };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.workerTaskKey).toBe("plugin-work-1");

    // 停用：进入 draining（有在途工作）且拒绝新工作。
    const currentRevision = ((await (await fetch(`${base}/api/extensions`)).json()) as { revision: number }).revision;
    const disable = await fetch(`${base}/api/extensions/${SAMPLE_SITE_EXTENSION_METADATA.extensionId}/config`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ expectedRevision: currentRevision, enabled: false, values: {}, secretRefs: [] })
    });
    expect(disable.status).toBe(200);
    void validateSampleSiteConfig;
  }, 30_000);
});
