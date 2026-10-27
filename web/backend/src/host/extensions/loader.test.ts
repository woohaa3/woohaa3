import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { defineConfigSchema, type HostExtensionPlugin } from "@woohaa3/contracts";
import { createSettingsService, type SettingsService } from "../../settings/settings-service.js";
import { loadBaseLayer } from "../base/index.js";
import type { HostContext } from "../context.js";
import { createSiteGate } from "../core/site-gate.js";
import { createMarketplaceRegistry } from "../core/marketplace.js";
import { loadExtensionLayer, type LoadedExtension } from "./loader.js";

const SAMPLE_CONFIG = defineConfigSchema({
  apiKey: { kind: "string", secret: true, label: "API Key", description: "密钥", reload: "hot" },
  baseUrl: { kind: "url", protocols: ["https:"], label: "地址", description: "服务地址", reload: "hot", default: "https://sample.invalid" }
});

type Start = { baseUrl: string; apiKey: string | undefined };

function samplePlugin(starts: Start[], name = "sample"): HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> {
  return {
    name,
    label: "样例",
    configPrefix: `providers.${name}`,
    inject: [],
    Config: SAMPLE_CONFIG,
    apply(_ctx, config) {
      starts.push({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    }
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(config = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-ext-loader-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "woohaa.config.yml");
  fs.writeFileSync(configFile, config);
  const settings: SettingsService = await createSettingsService({
    configFile,
    secretsFile: path.join(dir, "woohaa.secrets.yml"),
    env: {},
    watch: false
  });
  cleanups.push(() => settings.close());
  const events: Array<Record<string, unknown>> = [];
  const ctx = new Context() as HostContext;
  const base = await loadBaseLayer(ctx, { env: {}, sink: (event) => events.push(event), settings });
  cleanups.push(async () => {
    for (const fiber of base.reverse()) await fiber.dispose();
  });
  const load = async (plugins: HostExtensionPlugin<typeof SAMPLE_CONFIG.fields>[]) => {
    const loaded: LoadedExtension[] = await loadExtensionLayer(ctx, plugins);
    cleanups.push(async () => {
      for (const extension of loaded.reverse()) await extension.dispose();
    });
    return loaded;
  };
  return { ctx, settings, events, load };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("扩展层装载器", () => {
  it("把扩展的配置项并进设置定义表，按配置段的值启动", async () => {
    const { settings, load } = await setup("providers:\n  sample:\n    baseUrl: https://a.invalid\n");
    const starts: Start[] = [];
    await load([samplePlugin(starts)]);
    expect(starts).toEqual([{ baseUrl: "https://a.invalid", apiKey: undefined }]);
    const entry = settings.describe().find((item) => item.key === "providers.sample.baseUrl");
    expect(entry?.group).toBe("样例");
    // 配置项带上归属插件：设置面据此把该扩展的启停放到配置旁边。
    expect(entry?.ownerExtensionId).toBe("sample");
    expect(settings.describe().find((item) => item.key === "storage.primary")?.ownerExtensionId).toBeUndefined();
  });

  it("扩展声明的图标进设置面插件清单；未声明则不带该字段", async () => {
    const { settings, load } = await setup();
    const starts: Start[] = [];
    await load([{ ...samplePlugin(starts), icon: "provider" }, samplePlugin(starts, "plain")]);
    // setup 已经装载基础层，这里只看这次装载的两个扩展。
    const icons = settings
      .plugins()
      .filter((plugin) => plugin.id === "sample" || plugin.id === "plain")
      .map((plugin) => [plugin.id, plugin.icon]);
    expect(icons).toEqual([
      ["sample", "provider"],
      ["plain", undefined]
    ]);
    // 基础层的图标来自 inventory 表。
    expect(settings.plugins().find((plugin) => plugin.id === "config")?.icon).toBe("config");
  });

  it("配置段变化时按新值重启", async () => {
    const { settings, load } = await setup();
    const starts: Start[] = [];
    await load([samplePlugin(starts)]);
    await settings.update({ "providers.sample.baseUrl": "https://b.invalid" });
    await waitFor(() => starts.length === 2);
    expect(starts[1]!.baseUrl).toBe("https://b.invalid");
  });

  it("密钥字段写进密钥文件，写入后按新值重启", async () => {
    const { settings, load } = await setup();
    const starts: Start[] = [];
    await load([samplePlugin(starts)]);
    expect(await settings.update({ "providers.sample.apiKey": "k1" })).toMatchObject({ ok: true });
    await waitFor(() => starts.length === 2);
    expect(starts.at(-1)?.apiKey).toBe("k1");
    expect(fs.readFileSync(settings.secretsFile, "utf8")).toContain("k1");
    expect(fs.readFileSync(settings.configFile, "utf8")).not.toContain("k1");
  });

  it("单个扩展配置非法只跳过它", async () => {
    const { load, events } = await setup("providers:\n  broken:\n    baseUrl: not-a-url\n");
    const starts: Start[] = [];
    const loaded = await load([samplePlugin(starts, "broken"), samplePlugin(starts, "fine")]);
    expect(loaded.map((extension) => extension.name)).toEqual(["fine"]);
    expect(events.some((event) => event.event === "extension-config-invalid" && event.extension === "broken")).toBe(true);
  });

  it("装载的扩展进入设置面插件清单，卸载后撤出", async () => {
    const { settings, load } = await setup();
    // 基础层先登记：宿主自带插件也要在「插件配置」里露面。
    // `diagnostics` 是 base 层新增的诊断缓冲（服务端接入日志窗口的数据源）。
    expect(settings.plugins().map((plugin) => plugin.id)).toEqual(["diagnostics", "log", "gateway", "access", "config", "restart"]);

    const starts: Start[] = [];
    const loaded = await load([samplePlugin(starts)]);
    expect(settings.plugins().find((plugin) => plugin.id === "sample")).toEqual({
      id: "sample",
      label: "样例",
      description: "",
      layer: "extension",
      configPrefix: "providers.sample",
      settingCount: 2,
      siteManaged: false,
      provider: true
    });

    await loaded[0]!.dispose();
    expect(settings.plugins().some((plugin) => plugin.id === "sample")).toBe(false);
  });

  it("配置段非法的扩展只跳过启动，仍留在插件清单里", async () => {
    const { settings, load } = await setup("providers:\n  broken:\n    baseUrl: not-a-url\n");
    const loaded = await load([samplePlugin([], "broken")]);
    expect([...loaded]).toEqual([]);
    expect(settings.plugins().find((plugin) => plugin.id === "broken")).toMatchObject({ label: "样例", settingCount: 0, provider: true });
  });

  it("站点门控插件把 health 接到站点定义上，并随当前配置变化", async () => {
    const { ctx, settings, load } = await setup();
    const siteGate = createSiteGate(["sample"]);
    ctx.provide("application", { siteGate } as never);
    const starts: Start[] = [];
    const degraded = () => ({
      state: "degraded" as const,
      diagnostics: [{ code: "provider-credentials-missing", message: "未配置 API Key" }]
    });
    await load([
      { ...samplePlugin(starts), health: (config) => (config.apiKey ? undefined : degraded()) }
    ]);
    const definition = siteGate.definitions[0]!;
    // 未激活：插件 fiber 没起来，不给健康信息（状态投影自己会报 configuring/disabled）。
    expect(definition.health?.()).toBeUndefined();

    const activation = await definition.activate({} as never);
    expect(definition.health?.()).toEqual(degraded());

    // 补上凭据：health 用当前配置求值，不需要重启插件就恢复健康。
    await settings.update({ "providers.sample.apiKey": "k" });
    await waitFor(() => definition.health?.() === undefined);
    expect(starts.at(-1)?.apiKey).toBe("k");
    await activation?.dispose?.();
  });

  it("hostPlugin 扩展由站点开关在运行中启停，不需要重启进程", async () => {
    // change: 2026-10-19-restore-runtime-extension-toggling：Provider / 存储后端与站点插件
    // 共用一套启停语义——控制面激活即启动该 Cordis 插件，停用即停止。
    const { ctx, load } = await setup();
    const starts: Start[] = [];
    const siteGate = createSiteGate(["sample"]);
    ctx.provide("application", { siteGate } as never);
    await load([samplePlugin(starts)]);
    // 受开关管理：装载时不直接启动，等控制面激活。
    expect(starts).toEqual([]);
    const definition = siteGate.definitions[0]!;
    const active = await definition.activate({} as never);
    expect(starts).toHaveLength(1);
    await active?.dispose?.();
    // 停用即释放：插件 fiber 被停止（再次激活会重新启动）。
    const again = await definition.activate({} as never);
    expect(starts).toHaveLength(2);
    await again?.dispose?.();
  });

  it("未声明 health 的站点插件在定义上不带该字段", async () => {
    const { ctx, load } = await setup();
    const siteGate = createSiteGate(["sample"]);
    ctx.provide("application", { siteGate } as never);
    await load([samplePlugin([], "sample")]);
    expect(siteGate.definitions[0]!.health?.()).toBeUndefined();
    const activation = await siteGate.definitions[0]!.activate({} as never);
    expect(siteGate.definitions[0]!.health?.()).toBeUndefined();
    await activation?.dispose?.();
  });

  it("hostPlugin 通过 ctx.webServer 注册受控路由，路由按 extensionId 命名空间隔离", async () => {
    // 概念对齐：web 路由是**公共基础设施**（与 ctx.generation / ctx.storage 同级），
    // 不是 backend 类插件的专属特权。注册的 route 只写相对路径，前缀由宿主添加。
    const { ctx, load } = await setup();
    const siteGate = createSiteGate(["sample"]);
    const registered: Array<{ kind: string; route: string }> = [];
    const webServerFor = (extensionId: string) => ({
      register: (registration: { route: string }) => registered.push({ kind: "json", route: `${extensionId}/${registration.route}` }),
      registerHttp: (registration: { route: string }) => registered.push({ kind: "http", route: `${extensionId}/${registration.route}` }),
      registerRawHttp: (registration: { route: string }) => registered.push({ kind: "raw", route: `${extensionId}/${registration.route}` })
    });
    ctx.provide("application", { siteGate, service: { host: () => ({ webServerFor }) } } as never);

    const plugin: HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> = {
      ...samplePlugin([]),
      apply(pluginCtx) {
        pluginCtx.webServer!.register({ route: "status", auth: "public", handle: () => ({ body: {} }) });
        pluginCtx.webServer!.registerRawHttp({ route: "auth/callback", method: "GET", auth: "public", purpose: "read", handle: async () => undefined });
      }
    };
    await load([plugin]);
    const definition = siteGate.definitions[0]!;
    const activation = await definition.activate({} as never);

    expect(registered).toEqual([
      { kind: "json", route: "sample/status" },
      { kind: "raw", route: "sample/auth/callback" }
    ]);
    await activation?.dispose?.();
  });

});

describe("扩展层装载时限与就绪（D4/D5）", () => {
  const hangingPlugin = (name: string, gate: Promise<void>, applied: string[]): HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> => ({
    ...samplePlugin([], name),
    async apply() {
      await gate;
      applied.push(name);
    }
  });

  it("可选插件激活挂起：超时记 activation-timeout，不阻塞装载返回；迟到成功被立即释放", async () => {
    const { ctx, events, load, settings } = await setup("extensions:\n  activationTimeoutMs: 1000\n");
    void settings;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied: string[] = [];
    const started = Date.now();
    const loaded = await load([hangingPlugin("slow", gate, applied)]);
    // 可选插件不被 await：装载立即返回。
    expect(Date.now() - started).toBeLessThan(500);
    await loaded[0]!.started;
    expect(events.some((event) => event.event === "extension-start-failed" && event.code === "activation-timeout")).toBe(true);
    // 迟到完成不会让插件留在已装载状态：配置变化时按「未运行」重新尝试，而不是更新一个幽灵 fiber。
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((event) => event.event === "extension-restart-failed")).toBe(false);
    void ctx;
  }, 10_000);

  it("optional: false 的插件被 await；失败只记日志", async () => {
    const { ctx } = await setup();
    const starts: Start[] = [];
    const layer = await loadExtensionLayer(ctx, [{ plugin: samplePlugin(starts, "primary"), optional: false }]);
    expect(starts).toHaveLength(1);
    for (const extension of layer.reverse()) await extension.dispose();
  });

  it("gated 插件激活超时：acquire 以 activation-timeout 拒绝", async () => {
    const { ctx, load } = await setup("extensions:\n  activationTimeoutMs: 1000\n");
    const siteGate = createSiteGate(["slow"]);
    ctx.provide("application", { siteGate } as never);
    await load([hangingPlugin("slow", new Promise<void>(() => undefined), [])]);
    await expect(siteGate.definitions[0]!.activate({} as never)).rejects.toMatchObject({ code: "activation-timeout" });
  }, 10_000);

  it("dispose 挂起不阻塞停用：超时后完成状态转换并记诊断", async () => {
    const { ctx, events, load } = await setup("extensions:\n  disposeTimeoutMs: 1000\n");
    const siteGate = createSiteGate(["stuck"]);
    ctx.provide("application", { siteGate } as never);
    const plugin: HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> = {
      ...samplePlugin([], "stuck"),
      apply(pluginCtx) {
        pluginCtx.effect(() => () => new Promise<void>(() => undefined));
      }
    };
    await load([plugin]);
    const active = await siteGate.definitions[0]!.activate({} as never);
    const started = Date.now();
    await active?.dispose?.();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.some((event) => event.event === "extension-dispose-timeout")).toBe(true);
  });
});

describe("扩展层插件的 ctx.marketplace（change: 2026-10-21-add-extension-marketplace-point，D3）", () => {
  const sourceFor = (sourceId: string) => ({
    sourceId,
    label: sourceId,
    available: () => ({ ok: true as const }),
    search: async () => ({ items: [] }),
    resolve: async () => null,
    download: async () => {
      throw new Error("unused");
    }
  });

  async function withMarketplace(plugins: Array<HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> & { origin?: { managed: boolean; rootWritable: boolean } }>) {
    const { ctx } = await setup();
    const registry = createMarketplaceRegistry();
    ctx.provide("marketplace", registry);
    const loaded = await loadExtensionLayer(ctx, plugins);
    await (loaded as unknown as { settled: Promise<void> }).settled;
    cleanups.push(async () => {
      for (const extension of loaded.reverse()) await extension.dispose();
    });
    return registry;
  }

  const sourcePlugin = (name: string, origin?: { managed: boolean; rootWritable: boolean }) => ({
    ...samplePlugin([], name),
    inject: ["marketplace"],
    ...(origin ? { origin } : {}),
    apply(ctx: { marketplace: { register(source: unknown): () => void }; effect(fn: () => () => void): void }) {
      ctx.effect(() => ctx.marketplace.register(sourceFor(name)));
    }
  }) as unknown as HostExtensionPlugin<typeof SAMPLE_CONFIG.fields> & { origin?: { managed: boolean; rootWritable: boolean } };

  it("内置根插件能注册来源；受管根 / 缺少 origin 的插件注册被拒绝（插件启动失败，来源不出现）", async () => {
    const registry = await withMarketplace([
      sourcePlugin("builtin-src", { managed: false, rootWritable: false }),
      sourcePlugin("managed-src", { managed: true, rootWritable: false }),
      sourcePlugin("anon-src")
    ]);
    expect(registry.list().map((source) => source.sourceId)).toEqual(["builtin-src"]);
  });
});