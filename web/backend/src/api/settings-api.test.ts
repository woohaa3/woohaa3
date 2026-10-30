import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAccessEnforcer,
  createFakeRequestAuthenticator,
  testPrincipal,
  type AccessEnforcer,
  type ApplicationRequestAuthenticator
} from "@woohaa3/application-service";
import type { SettingsSnapshot, SiteAccessPolicy } from "@woohaa3/contracts";
import { createSettingsService, type SettingsService } from "../settings/settings-service.js";
import { createSettingsApiHandler } from "./settings-api.js";

/** 允许 `extensions.configure` 的测试站点策略（生产由 site-access 扩展提供）。 */
function allowAllSitePolicy(): SiteAccessPolicy {
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions() {
      return ["extensions.configure"];
    },
    async authorize() {
      return { allowed: true };
    }
  };
}

function allowAllEnforcer(): AccessEnforcer {
  return createAccessEnforcer({ siteAccessPolicy: () => allowAllSitePolicy(), resourceAccessPolicy: () => null });
}

/** 本地单实例：访问控制关闭，设置面直接可用；认证器不应被调用。 */
const disabledAuth = {
  authenticator: createFakeRequestAuthenticator(() => { throw new Error("本地单实例不应认证"); }),
  accessEnforcer: createAccessEnforcer({
    runtime: {
      enabled: false,
      instance: { kind: "instance", id: "instance:test", ownerId: "dev-admin", credentialOwnerId: "principal:dev-admin" }
    },
    siteAccessPolicy: () => allowAllSitePolicy(),
    resourceAccessPolicy: () => null
  })
};

/** 站点部署：只有带管理员角色的请求建立主体。 */
const siteAuth = {
  authenticator: createFakeRequestAuthenticator((req) =>
    typeof req.headers["x-test-role"] === "string" ? testPrincipal("root", { identityProvider: "test" }) : null
  ),
  accessEnforcer: allowAllEnforcer()
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(
  auth: { authenticator: ApplicationRequestAuthenticator; accessEnforcer: AccessEnforcer },
  directoryControl?: import("../extensions/manifest.js").LoadedExtensionHost["directoryControl"],
  storageBackends?: () => readonly { backendId: string; label?: string; ownerExtensionId?: string }[]
): Promise<{ base: string; settings: SettingsService; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "settings-api-"));
  const settings = await createSettingsService({
    configFile: path.join(dir, "config.yml"),
    secretsFile: path.join(dir, "secrets.yml"),
    watch: false
  });
  const handler = createSettingsApiHandler({ settings, directoryControl, storageBackends, authenticator: auth.authenticator, accessEnforcer: auth.accessEnforcer });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  cleanups.push(() => settings.close());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`, settings, dir };
}

describe("settings API", () => {
  it("目录安装/卸载校验请求并返回已安装清单", async () => {
    const calls: unknown[] = [];
    const row = { id: "sample", label: "样例", description: "", directory: "/plugins/sample", version: "1.2.0", writable: true };
    const { base } = await start(disabledAuth, {
      list: () => [row],
      setInstalled(id: string, installed: boolean) {
        calls.push([id, installed]);
        if (id !== "sample") throw new Error("插件目录不存在");
        row.directory = installed ? "/plugins/sample" : "/plugins/.sample";
      }
    });
    const request = (body: unknown) => fetch(`${base}/extensions`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect((await request({ extensionId: "sample", installed: "false" })).status).toBe(400);
    expect(calls).toEqual([]);
    const result = await request({ extensionId: "sample", installed: false });
    expect(result.status).toBe(200);
    // 展示用的版本随安装清单原样透传给设置面（前端按 v<version> 显示）。
    expect((await result.json()).installedExtensions).toMatchObject([
      { id: "sample", directory: "/plugins/.sample", version: "1.2.0", writable: true }
    ]);
    expect((await request({ extensionId: "missing", installed: true })).status).toBe(409);
  });

  it("本地单实例：无需令牌即可读写，敏感值不回显", async () => {
    const { base, settings, dir } = await start(disabledAuth);
    // 用插件登记的配置段充当读写样本（宿主自带的 url/secret 配置项已随静态同步移除）。
    settings.register("providers.demo", {
      url: { kind: "url", protocols: ["ws:", "wss:"], reload: "hot", label: "地址", description: "" },
      token: { kind: "string", secret: true, reload: "hot", label: "令牌", description: "" }
    }, "演示", "demo-extension");
    expect((await fetch(base)).status).toBe(200);

    const headers = { "content-type": "application/json" };
    const put = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({ values: { "providers.demo.url": "wss://relay.local", "providers.demo.token": "alice" } })
    });
    expect(put.status).toBe(200);
    const snapshot = (await put.json()) as SettingsSnapshot;
    const byKey = Object.fromEntries(snapshot.settings.map((entry) => [entry.key, entry]));
    expect(byKey["providers.demo.url"]).toMatchObject({ value: "wss://relay.local", source: "file" });
    expect(byKey["providers.demo.token"]).toMatchObject({ value: null, configured: true, source: "secrets" });
    expect(snapshot.files.config).toBe(path.join(dir, "config.yml"));
    expect(settings.get("providers.demo.token" as never)).toBe("alice");

    const cleared = await fetch(base, { method: "PUT", headers, body: JSON.stringify({ values: { "providers.demo.url": null } }) });
    expect(((await cleared.json()) as SettingsSnapshot).settings.find((entry) => entry.key === "providers.demo.url")?.configured).toBe(false);
  });

  it("GET 快照带上宿主插件清单", async () => {
    const { base, settings } = await start(disabledAuth);
    settings.registerPlugin({ id: "log", label: "日志", description: "结构化日志出口", layer: "base" });
    settings.registerPlugin({ id: "sample", label: "样例", layer: "extension", configPrefix: "providers.sample", siteManaged: true });

    const response = await fetch(base);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as SettingsSnapshot;
    expect(snapshot.plugins).toEqual([
      { id: "log", label: "日志", description: "结构化日志出口", layer: "base", settingCount: 0, siteManaged: false, provider: false },
      { id: "sample", label: "样例", description: "", layer: "extension", configPrefix: "providers.sample", settingCount: 0, siteManaged: true, provider: true }
    ]);
    // 没有存储注册表时仍然给出空集合，设置页据此知道「没有可选后端」而不是缺字段。
    // 没有存储注册表时仍然给出空集合（地址提供者同理），设置页据此知道「没有可选提供者」。
    expect(snapshot.extensionPoints).toEqual({ storage: [], exposer: [] });
  });

  it("GET 快照带上扩展点可用后端与提供者", async () => {
    const { base } = await start(disabledAuth, undefined, () => [
      { backendId: "local", label: "本地存储", ownerExtensionId: "local-storage" },
      { backendId: "cos", label: "COS", ownerExtensionId: "cos-storage" },
      { backendId: "custom" }
    ]);
    const snapshot = (await (await fetch(base)).json()) as SettingsSnapshot;
    expect(snapshot.extensionPoints?.storage).toEqual([
      { id: "local", label: "本地存储", ownerExtensionId: "local-storage" },
      { id: "cos", label: "COS", ownerExtensionId: "cos-storage" },
      { id: "custom", label: "custom", ownerExtensionId: null }
    ]);
  });

  it("非法值返回逐项问题，不写入文件", async () => {
    const { base, settings, dir } = await start(disabledAuth);
    // 注册一个带协议约束的 url 字段：非法值必须在写盘前被拦下。
    settings.register("providers.demo", {
      url: { kind: "url", protocols: ["ws:", "wss:"], reload: "hot", label: "地址", description: "" }
    }, "演示", "demo-extension");
    const response = await fetch(base, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { "providers.demo.url": "http://relay" } })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; issues: Array<{ key: string }> };
    expect(body.code).toBe("config-invalid");
    expect(body.issues.map((issue) => issue.key)).toEqual(["providers.demo.url"]);
    await expect(fsp.access(path.join(dir, "config.yml"))).rejects.toThrow();
  });

  it("站点部署：只有管理员能读写", async () => {
    const { base } = await start(siteAuth);
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { "x-test-role": "admin" } })).status).toBe(200);
    const denied = await fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: {} }) });
    expect(denied.status).toBe(401);
  });

  it("扩展启停走 /extension-toggles：写配置文件并回显到快照", async () => {
    const { base, dir } = await start(disabledAuth);
    const put = await fetch(`${base}/extension-toggles`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "prompt-snippets", enabled: false })
    });
    expect(put.status).toBe(200);
    const snapshot = (await put.json()) as SettingsSnapshot;
    expect(snapshot.extensionToggles).toEqual({ "prompt-snippets": false });
    // 落在宿主配置文件，而不是浏览器存储。
    const text = await fsp.readFile(path.join(dir, "config.yml"), "utf8");
    expect(text).toContain("extensions:");
    expect(text).toContain("enabled: false");

    // 请求体非法被拒绝，且不污染配置。
    const bad = await fetch(`${base}/extension-toggles`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "prompt-snippets", enabled: "no" })
    });
    expect(bad.status).toBe(400);
    const get = await fetch(base);
    expect(((await get.json()) as SettingsSnapshot).extensionToggles).toEqual({ "prompt-snippets": false });
  });

});