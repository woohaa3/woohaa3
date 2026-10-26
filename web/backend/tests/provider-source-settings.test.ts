import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defineConfigSchema, type HostExtensionPlugin, type ServiceConnectionDirectory } from "@woohaa3/contracts";
import { createBackendService } from "../src/composition.js";

const Config = defineConfigSchema({
  apiKey: { kind: "string", secret: true, label: "API Key", description: "Key", reload: "hot" },
  baseUrl: { kind: "url", protocols: ["https:"], label: "地址", description: "地址", reload: "hot", default: "https://provider.example/v1" },
});
const provider: HostExtensionPlugin<typeof Config.fields> = {
  name: "settings-test-provider", label: "测试模型提供商", configPrefix: "providers.settings-test", Config, inject: ["generation"],
  apply(ctx, config) {
    ctx.effect(() => ctx.generation.register({
      extensionId: "settings-test-provider", providerId: "settings-test", available: Boolean(config.apiKey), provider: {},
      models: [{ providerId: "settings-test", providerModelId: "image", modelType: "image" }],
    }));
  },
};

it("宿主扩展装载后登记模型提供商，保存首个 Key 后立即查询可见，替换与重启保留身份", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-provider-source-"));
  const boot = () => createBackendService({
    env: {
      WOOHAA3_CONFIG_FILE: path.join(dir, "config.yml"), WOOHAA3_SECRETS_FILE: path.join(dir, "secrets.yml"),
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"), WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
    },
    loadExtensionHost: false, providerPlugins: [provider], storagePlugins: [],
    applicationBackendExtensions: [], applicationExtensionMetadata: [],
    modelsConfig: { version: 1, models: [] }, enableYjsSync: false, logger: () => {},
    mediaStorage: {
      put: async () => {}, get: async () => { throw new Error("unused"); }, exists: async () => false,
      stat: async () => { throw new Error("unused"); }, getHttpsUrl: async () => { throw new Error("unused"); },
    },
  });
  let service = await boot();
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = async (): Promise<ServiceConnectionDirectory> => {
      const response = await fetch(`${base}/api/agent-conversations/service-connections`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const save = async (key: string) => {
      const response = await fetch(`${base}/api/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: { "providers.settings-test.apiKey": key } }),
      });
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.settings.find((field: { key: string }) => field.key === "providers.settings-test.apiKey")).toMatchObject({ configured: true, value: null });
    };
    expect((await directory()).connections).toEqual([]);
    await save("test-first-key");
    const first = await directory();
    expect(first.connections).toHaveLength(1);
    expect(first.connections[0]).toMatchObject({ name: "测试模型提供商", credentialConfigured: true, enabled: true,
      bindings: [{ consumer: "provider", consumerId: "settings-test" }] });
    expect(JSON.stringify(first)).not.toContain("test-first-key");
    await save("test-replacement-key");
    const replaced = (await directory()).connections[0];
    expect(replaced.serviceConnectionId).toBe(first.connections[0].serviceConnectionId);
    expect(replaced.credentialEpoch).toBeGreaterThan(first.connections[0].credentialEpoch);
    await service.close();
    service = await boot();
    const restarted = await directory();
    expect(restarted.connections).toHaveLength(1);
    expect(restarted.connections[0]).toMatchObject({ serviceConnectionId: replaced.serviceConnectionId, credentialConfigured: true, enabled: true });
    expect(JSON.stringify(restarted)).not.toContain("test-replacement-key");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
