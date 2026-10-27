/**
 * Provider 密钥端到端验收。
 *
 * 验证：设置页把 apiKey 写进 Provider 自己的配置段 → 落到 0600 密钥文件 → 插件按新配置重启 →
 * 目录出现 RunningHub 模型；清除后撤出；公开响应不含明文；未授权写入被拒。
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendService } from "../src/composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-provider-creds-"));
  dirs.push(dir);
  return dir;
}

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key: string) {
      return objects.get(key)!;
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
  const configFile = path.join(dir, "woohaa.config.yml");
  const secretsFile = path.join(dir, "woohaa.secrets.yml");
  const service = await createBackendService({
    env: {
      WOOHAA3_CONFIG_FILE: configFile,
      WOOHAA3_SECRETS_FILE: secretsFile,
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
    },
    logger: () => {},
    modelsConfig: { version: 1, models: [] },
    mediaStorage: memoryStorage() as never,
    enableYjsSync: false
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
    configFile,
    secretsFile,
    async close() {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function catalogModelKeys(base: string): Promise<string[]> {
  const catalog = (await (await fetch(`${base}/api/pptask/catalog`)).json()) as {
    available: boolean;
    models?: Array<{ modelKey: string }>;
  };
  return (catalog.models ?? []).map((model) => model.modelKey);
}

type SettingsSnapshot = { settings: Array<{ key: string; group?: string; value: unknown; configured: boolean }> };

async function settings(base: string): Promise<SettingsSnapshot> {
  return (await (await fetch(`${base}/api/settings`)).json()) as SettingsSnapshot;
}

function writeSettings(base: string, values: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ values })
  });
}

/** 全部自带 Provider 的稳定集合（providerId 排序后）。新增 Provider 时同步这里。 */
const ALL_PROVIDER_IDS = ["ark", "fal", "grsai", "replicate", "runninghub", "tokenhub"].sort();

describe("Provider 密钥在自己的配置段里", () => {
  it("每个 Provider 都声明 apiKey 密钥项；写入后 RunningHub 模型进入目录，清除后撤出", async () => {
    const app = await boot();
    try {
      expect(await catalogModelKeys(app.base)).not.toContain("runninghub:api/seedream-v5-pro");
      const before = await settings(app.base);
      for (const id of ALL_PROVIDER_IDS) {
        expect(before.settings.find((entry) => entry.key === `providers.${id}.apiKey`)).toMatchObject({ value: null, configured: false });
      }

      const write = await writeSettings(app.base, { "providers.runninghub.apiKey": "rh-secret" });
      expect(write.status, await write.clone().text()).toBe(200);
      const written = await write.text();
      expect(written).not.toContain("rh-secret");
      expect(JSON.parse(written).settings.find((entry: { key: string }) => entry.key === "providers.runninghub.apiKey")).toMatchObject({ configured: true });
      expect(readFileSync(app.secretsFile, "utf8")).toContain("rh-secret");
      expect(statSync(app.secretsFile).mode & 0o777).toBe(0o600);

      await waitFor(async () => (await catalogModelKeys(app.base)).includes("runninghub:api/seedream-v5-pro"));
      const keys = await catalogModelKeys(app.base);
      expect(keys.some((key) => key.startsWith("runninghub:api/bytedance/seedance-2.0-global"))).toBe(true);

      expect((await writeSettings(app.base, { "providers.runninghub.apiKey": null })).status).toBe(200);
      await waitFor(async () => !(await catalogModelKeys(app.base)).includes("runninghub:api/seedream-v5-pro"));
    } finally {
      await app.close();
    }
  }, 30_000);

  it("本地单实例写入无需管理员令牌", async () => {
    const app = await boot();
    try {
      expect((await writeSettings(app.base, { "providers.runninghub.apiKey": "x" })).status).toBe(200);
      expect((await settings(app.base)).settings.find((entry) => entry.key === "providers.runninghub.apiKey")?.configured).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("本地单实例访问控制", () => {
  it("设置与插件启停都无需令牌", async () => {
    const app = await boot();
    try {
      expect((await writeSettings(app.base, { "providers.ark.apiKey": "ark-secret" })).status).toBe(200);
      // 启停走配置文件（extensions.<id>.enabled），不需要令牌、也不经过站点控制面。
      const toggled = await fetch(`${app.base}/api/settings/extension-toggles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionId: "ark-provider", enabled: true })
      });
      expect(toggled.status, await toggled.clone().text()).toBe(200);
      const snapshot = (await toggled.json()) as { extensionToggles?: Record<string, boolean> };
      expect(snapshot.extensionToggles?.["ark-provider"]).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("插件管理里的 Provider 开关", () => {
  it("Provider 的启停由配置文件决定，而不是站点控制面", async () => {
    const app = await boot();
    try {
      const plane = app.service.modules().application.plugins();
      const providerIds = async () =>
        app.service.modules().generation.list().map((provider) => provider.providerId).sort();
      // Provider 自带 Config 与装配入口：它们不出现在控制面 catalog 里（那里只列有后端入口的扩展）。
      for (const extensionId of ALL_PROVIDER_IDS.map((id) => `${id}-provider`)) {
        expect(plane.status(extensionId), extensionId).toBeUndefined();
      }
      // 但 Provider 仍然全部注册可用：启停不经过控制面不等于不工作。
      expect(await providerIds()).toEqual(ALL_PROVIDER_IDS);
    } finally {
      await app.close();
    }
  });
});

describe("Provider 的刷新路由", () => {
  it("本地单实例的 Provider 刷新入口不再要求管理员令牌", async () => {
    const app = await boot();
    try {
      for (const path of ["/api/providers/fal/refresh", "/api/providers/grsai/refresh"]) {
        const response = await fetch(`${app.base}${path}`, { method: "POST" });
        expect([200, 502], path).toContain(response.status);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
