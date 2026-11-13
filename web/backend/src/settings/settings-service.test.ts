import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsService, resolveSettingsFiles, type SettingsService } from "./settings-service.js";

const services: SettingsService[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-settings-"));
  dirs.push(dir);
  return { configFile: path.join(dir, "woohaa.config.yml"), secretsFile: path.join(dir, "woohaa.secrets.yml") };
}

async function start(files: ReturnType<typeof tempFiles>, options: { env?: Record<string, string>; watch?: boolean; settingDefaults?: Record<string, string | number | boolean> } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const service = await createSettingsService({
    ...files,
    env: options.env ?? {},
    watch: options.watch ?? false,
    debounceMs: 20,
    ...(options.settingDefaults ? { settingDefaults: options.settingDefaults } : {}),
    logger: (event) => events.push(event)
  });
  services.push(service);
  return { service, events };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 测试用的“扩展配置段”：替代已移除的 canvas.syncUpstream.*，保留 url / secret / 旧环境变量语义。 */
const DEMO_PREFIX = "providers.demo";
const demoFields = {
  url: {
    kind: "url",
    protocols: ["ws:", "wss:"],
    reload: "hot",
    label: "中继地址",
    description: "ws(s) 基址",
    legacyEnv: "WOOHAA3_CANVAS_SYNC_UPSTREAM_URL"
  },
  token: {
    kind: "string",
    secret: true,
    reload: "hot",
    label: "令牌",
    description: "会话令牌",
    legacyEnv: "WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN"
  }
} as const;

describe("createSettingsService", () => {
  it("文件不存在时取默认值；默认位置在 web/ 下，可由环境变量指定", async () => {
    const { service } = await start(tempFiles());
    expect(service.get("storage.primary")).toBe("local");
    expect(resolveSettingsFiles({}, "/repo").configFile).toBe("/repo/web/woohaa.config.yml");
    expect(resolveSettingsFiles({ WOOHAA3_SECRETS_FILE: "/etc/woohaa/secrets.yml" }, "/repo").secretsFile).toBe("/etc/woohaa/secrets.yml");
  });

  it("构建期默认值覆盖静态项与插件配置项，用户文件仍然优先", async () => {
    const files = tempFiles();
    const { service } = await start(files, {
      settingDefaults: { "exposer.primary": "local-public", "storage.local.publicEnabled": true }
    });
    // 构建默认里的 local-public 表示「用内置」，迁移为自动；用户显式值仍保留（见下方文件写入）。
    expect(service.get("exposer.primary")).toBe("auto");

    service.register("storage.local", {
      publicEnabled: { kind: "boolean", default: false, reload: "hot", label: "公开桶", description: "" }
    }, "本地存储");
    expect(service.describe().find((entry) => entry.key === "storage.local.publicEnabled")?.value).toBe(true);

    fs.writeFileSync(files.configFile, "exposer:\n  primary: local-public\n", "utf8");
    await service.reload();
    // 用户显式写下的 local-public 不是产品默认：保持手动选择。
    expect(service.get("exposer.primary")).toBe("local-public");
    expect(service.describe().find((entry) => entry.key === "exposer.primary")?.source).toBe("file");

    fs.writeFileSync(files.configFile, "exposer:\n  primary: cos\nstorage:\n  local:\n    publicEnabled: false\n", "utf8");
    await service.reload();
    expect(service.get("exposer.primary")).toBe("cos");
    expect(service.describe().find((entry) => entry.key === "storage.local.publicEnabled")?.value).toBe(false);
  });

  it("默认位置不随 cwd 漂移：从子包目录启动也落在仓库根的 web/ 下", async () => {
    // 回归：曾以 `path.resolve(cwd, "web/...")` 解析，从 `web/backend` 启动会在
    // `web/backend/web/` 下新建一份没人读的配置文件（且不在 .gitignore 覆盖内）。
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-root-"));
    dirs.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, "web", "backend"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "scripts", "lib"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "scripts", "lib", "extension-host.mjs"), "export {};\n");
    const subpackage = path.join(repoRoot, "web", "backend");

    expect(resolveSettingsFiles({}, subpackage).configFile).toBe(path.join(repoRoot, "web", "woohaa.config.yml"));
    expect(resolveSettingsFiles({}, path.join(repoRoot, "web")).configFile).toBe(path.join(repoRoot, "web", "woohaa.config.yml"));
    // 显式环境变量仍优先于任何推导。
    expect(resolveSettingsFiles({ WOOHAA3_CONFIG_FILE: "/etc/custom.yml" }, subpackage).configFile).toBe("/etc/custom.yml");
  });

  it("从父仓启动时仍解析 client 子模块的 web 配置", () => {
    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-parent-"));
    dirs.push(parentRoot);
    fs.mkdirSync(path.join(parentRoot, "client", "web"), { recursive: true });
    fs.mkdirSync(path.join(parentRoot, "client", "scripts", "lib"), { recursive: true });
    fs.writeFileSync(path.join(parentRoot, "client", "scripts", "lib", "extension-host.mjs"), "export {};\n");

    expect(resolveSettingsFiles({}, parentRoot).configFile).toBe(path.join(parentRoot, "client", "web", "woohaa.config.yml"));
  });

  it("启动时配置非法直接失败", async () => {
    const files = tempFiles();
    fs.writeFileSync(files.configFile, "telemetry:\n  local:\n    retentionDays: 0\n");
    await expect(start(files)).rejects.toThrow(/retentionDays/);
  });

  it("旧环境变量生效时告警迁移", async () => {
    const { service, events } = await start(tempFiles(), { env: { WOOHAA3_CANVAS_SYNC_UPSTREAM_URL: "ws://relay" } });
    service.register(DEMO_PREFIX, demoFields, "演示", "demo-extension");
    expect(service.get((DEMO_PREFIX + ".url") as never)).toBe("ws://relay");
    expect(events.some((event) => event.event === "settings-legacy-env")).toBe(true);
  });

  it("监听文件变化热重载并通知订阅者；改坏后保留上一份生效值", async () => {
    const files = tempFiles();
    const { service, events } = await start(files, { watch: true });
    service.register(DEMO_PREFIX, demoFields, "演示", "demo-extension");
    const urlKey = DEMO_PREFIX + ".url";
    const notified: string[][] = [];
    service.subscribe([urlKey] as never, (changed) => {
      notified.push([...changed]);
    });

    fs.writeFileSync(files.configFile, "providers:\n  demo:\n    url: ws://relay-a\n");
    await waitFor(() => service.get(urlKey as never) === "ws://relay-a");
    expect(notified).toEqual([[urlKey]]);

    fs.writeFileSync(files.configFile, "providers:\n  demo:\n    url: http://wrong\n");
    await waitFor(() => events.some((event) => event.event === "settings-reload-rejected"));
    expect(service.get(urlKey as never)).toBe("ws://relay-a");
  });

  it("update 写回时保留注释，敏感项写入 0600 的密钥文件", async () => {
    const files = tempFiles();
    const { service } = await start(files);
    service.register(DEMO_PREFIX, demoFields, "演示", "demo-extension");
    fs.writeFileSync(files.configFile, "# 团队中继\nproviders:\n  demo:\n    url: ws://old # 旧地址\n");
    await service.reload();
    const urlKey = DEMO_PREFIX + ".url";
    const tokenKey = DEMO_PREFIX + ".token";
    const notified: string[][] = [];
    service.subscribe([urlKey, tokenKey] as never, (changed) => {
      notified.push([...changed]);
    });

    const result = await service.update({ [urlKey]: "wss://new", [tokenKey]: "alice" });
    expect(result).toEqual({ ok: true, changed: [urlKey, tokenKey] });
    expect(notified).toHaveLength(1);
    const written = fs.readFileSync(files.configFile, "utf8");
    expect(written).toContain("# 团队中继");
    expect(written).toContain("wss://new");
    expect(written).not.toContain("alice");
    expect(fs.readFileSync(files.secretsFile, "utf8")).toContain("alice");
    expect(fs.statSync(files.secretsFile).mode & 0o777).toBe(0o600);

    const described = service.describe().find((entry) => entry.key === tokenKey);
    expect(described).toMatchObject({ value: null, configured: true });

    expect(await service.update({ [urlKey]: null })).toMatchObject({ ok: true });
    expect(service.get(urlKey as never)).toBeUndefined();
  });

  it("扩展登记的配置段：未登记前只记为未知键，登记后按定义校验、可读写，注销后撤出", async () => {
    const files = tempFiles();
    fs.writeFileSync(files.configFile, "providers:\n  demo:\n    timeoutMs: 5\n");
    const { service } = await start(files);
    expect(service.unknownKeys()).toEqual(["providers.demo.timeoutMs"]);

    const fields = {
      timeoutMs: { kind: "integer", label: "超时", description: "毫秒", reload: "hot", min: 1 },
      apiKey: { kind: "string", secret: true, label: "API Key", description: "密钥", reload: "hot" }
    } as const;
    const unregister = service.register("providers.demo", fields, "演示", "demo-extension");
    expect(service.unknownKeys()).toEqual([]);
    expect(service.section("providers.demo")).toEqual({ timeoutMs: 5 });
    expect(() => service.register("providers.demo", fields, "演示")).toThrow();
    expect(service.describe().find((entry) => entry.key === "providers.demo.apiKey")).toMatchObject({
      group: "演示",
      ownerExtensionId: "demo-extension",
      value: null,
      configured: false
    });

    expect(await service.update({ "providers.demo.timeoutMs": 0 })).toMatchObject({ ok: false });
    expect(await service.update({ "providers.demo.apiKey": "sk-demo" })).toMatchObject({ ok: true });
    expect(service.section("providers.demo").apiKey).toBe("sk-demo");
    expect(fs.readFileSync(files.secretsFile, "utf8")).toContain("sk-demo");
    expect(fs.statSync(files.secretsFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(files.configFile, "utf8")).not.toContain("sk-demo");
    expect(service.describe().find((entry) => entry.key === "providers.demo.apiKey")).toMatchObject({ value: null, configured: true });

    unregister();
    expect(service.describe().some((entry) => entry.key.startsWith("providers.demo."))).toBe(false);
  });

  it("插件清单：分层与配置段前缀推导 settingCount / provider，注销只删自己的登记", async () => {
    const { service } = await start(tempFiles());
    const unregisterLog = service.registerPlugin({ id: "log", label: "日志", description: "结构化日志出口", layer: "base" });
    const unregisterSample = service.registerPlugin({ id: "sample", label: "样例", layer: "extension", configPrefix: "providers.sample", directory: "/opt/woohaa/extensions/sample", siteManaged: true });
    const unregisterStorage = service.registerPlugin({ id: "storage-local", label: "本地存储", description: "本机读写", layer: "extension", configPrefix: "storage.local" });

    // 没有 configPrefix 的插件不带该键，也没可配置项；description 缺省为空串。
    expect(service.plugins()).toEqual([
      { id: "log", label: "日志", description: "结构化日志出口", layer: "base", settingCount: 0, siteManaged: false, provider: false },
      { id: "sample", label: "样例", description: "", layer: "extension", configPrefix: "providers.sample", directory: "/opt/woohaa/extensions/sample", settingCount: 0, siteManaged: true, provider: true },
      { id: "storage-local", label: "本地存储", description: "本机读写", layer: "extension", configPrefix: "storage.local", settingCount: 0, siteManaged: false, provider: false }
    ]);

    const unregisterSampleConfig = service.register(
      "providers.sample",
      { timeoutMs: { kind: "integer", label: "超时", description: "毫秒", reload: "hot" } },
      "样例",
      "sample"
    );
    const unregisterStorageConfig = service.register("storage.local", { dir: { kind: "string", label: "目录", description: "字节存放位置", reload: "restart" } }, "本地存储", "storage-local");
    // 前缀相近的兄弟段（storage.localBackup.*）不算进 storage.local。
    const unregisterBackupConfig = service.register("storage.localBackup", { dir: { kind: "string", label: "备份目录", description: "备份位置", reload: "restart" } }, "本地备份", "storage-local");
    const counts = () => Object.fromEntries(service.plugins().map((plugin) => [plugin.id, plugin.settingCount]));
    expect(counts()).toEqual({ log: 0, sample: 1, "storage-local": 1 });

    unregisterSampleConfig();
    expect(counts().sample).toBe(0);

    // 同一 id 重新登记即替换；旧注销函数不会误删后来者。
    unregisterSample();
    const replacement = service.registerPlugin({ id: "sample", label: "样例 v2", layer: "extension", configPrefix: "providers.sample" });
    unregisterSample();
    expect(service.plugins().find((plugin) => plugin.id === "sample")).toMatchObject({ label: "样例 v2" });
    replacement();
    expect(service.plugins().some((plugin) => plugin.id === "sample")).toBe(false);

    unregisterBackupConfig();
    unregisterStorageConfig();
    unregisterStorage();
    unregisterLog();
    expect(service.plugins()).toEqual([]);
  });

  it("插件清单带上声明的图标（语义名或品牌图形路径）；未声明时不带该字段", async () => {
    const { service } = await start(tempFiles());
    service.registerPlugin({ id: "ark-provider", label: "Ark（火山方舟）", layer: "extension", configPrefix: "providers.ark", icon: "provider", website: "https://provider.example.com", setupOrder: 20 });
    service.registerPlugin({
      id: "litellm-provider",
      label: "LiteLLM",
      layer: "extension",
      configPrefix: "providers.litellm",
      icon: "/plugin-icons/litellm.png"
    });
    service.registerPlugin({ id: "legacy", label: "旧插件", layer: "extension" });
    expect(service.plugins()).toEqual([
      {
        id: "ark-provider",
        label: "Ark（火山方舟）",
        description: "",
        layer: "extension",
        icon: "provider",
        website: "https://provider.example.com",
        setupOrder: 20,
        configPrefix: "providers.ark",
        settingCount: 0,
        siteManaged: false,
        provider: true
      },
      {
        id: "litellm-provider",
        label: "LiteLLM",
        description: "",
        layer: "extension",
        icon: "/plugin-icons/litellm.png",
        configPrefix: "providers.litellm",
        settingCount: 0,
        siteManaged: false,
        provider: true
      },
      { id: "legacy", label: "旧插件", description: "", layer: "extension", settingCount: 0, siteManaged: false, provider: false }
    ]);
  });

  it("非站点插件的启动失败原因进插件清单，成功/注销后清除", async () => {
    const { service } = await start(tempFiles());
    service.registerPlugin({ id: "litellm-provider", label: "LiteLLM", layer: "extension", configPrefix: "providers.litellm" });
    // 没有失败时字段不出现：消费方据此区分「没启动失败」与「失败原因为空」。
    expect(service.plugins()[0]).not.toHaveProperty("activationFailure");

    // 真实场景：旧版本插件调用了宿主已删除的 ctx 能力，apply 抛错。
    service.setPluginActivationFailure("litellm-provider", "ctx.generation.registerConversion is not a function");
    expect(service.plugins()[0]?.activationFailure).toBe("ctx.generation.registerConversion is not a function");

    // 配置改对后重启成功：失败原因必须自己消失，否则设置页会一直谎报异常。
    service.setPluginActivationFailure("litellm-provider", null);
    expect(service.plugins()[0]).not.toHaveProperty("activationFailure");

    // 插件被卸载：登记与失败原因一起撤出。
    service.setPluginActivationFailure("litellm-provider", "boom");
    service.plugins();
    const unregister = service.registerPlugin({ id: "temp", label: "临时", layer: "extension" });
    service.setPluginActivationFailure("temp", "boom");
    unregister();
    expect(service.plugins().some((plugin) => plugin.id === "temp")).toBe(false);
  });

  it("登记时现有值不合法则拒绝登记", async () => {
    const files = tempFiles();
    fs.writeFileSync(files.configFile, "providers:\n  demo:\n    timeoutMs: 0\n");
    const { service } = await start(files);
    expect(() =>
      service.register("providers.demo", { timeoutMs: { kind: "integer", label: "超时", description: "毫秒", reload: "hot", min: 1 } }, "演示")
    ).toThrow();
    expect(service.describe().some((entry) => entry.key === "providers.demo.timeoutMs")).toBe(false);
  });

  it("非法值与被环境变量锁定的项拒绝写入，文件不变", async () => {
    const files = tempFiles();
    const { service } = await start(files, { env: { WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN: "deploy" } });
    service.register(DEMO_PREFIX, demoFields, "演示", "demo-extension");
    expect(await service.update({ [DEMO_PREFIX + ".url"]: "http://wrong" })).toMatchObject({ ok: false });
    expect(await service.update({ [DEMO_PREFIX + ".token"]: "mine" })).toMatchObject({ ok: false });
    expect(fs.existsSync(files.configFile)).toBe(false);
    expect(fs.existsSync(files.secretsFile)).toBe(false);
  });
});

describe("扩展启停落在配置文件", () => {
  it("写入 extensions.<id>.enabled，并保留文件中已有的注释与其它配置", async () => {
    const files = tempFiles();
    fs.writeFileSync(
      files.configFile,
      ["# 顶部注释不能丢", "providers:", "  demo:", "    url: wss://example.test/ws", ""].join("\n"),
      "utf8"
    );
    const { service } = await start(files);
    const outcome = await service.setExtensionToggle("prompt-snippets", false);
    expect(outcome.ok).toBe(true);

    const text = fs.readFileSync(files.configFile, "utf8");
    // 注释保留，原有配置不丢。
    expect(text).toContain("# 顶部注释不能丢");
    expect(text).toContain("wss://example.test/ws");
    // 启停写进同一个文件、同一段。
    expect(text).toMatch(new RegExp("^  prompt-snippets:$", "m"));
    expect(text).toContain("prompt-snippets:");
    expect(text).toContain("enabled: false");
    // 读回投影。
    expect(service.extensionToggles()).toEqual({ "prompt-snippets": false });
  });

  it("再次写入同一个插件只改值，不产生重复段", async () => {
    const files = tempFiles();
    const { service } = await start(files);
    await service.setExtensionToggle("prompt-snippets", false);
    await service.setExtensionToggle("prompt-snippets", true);
    await service.setExtensionToggle("dev-performance", false);
    const text = fs.readFileSync(files.configFile, "utf8");
    expect(text.match(/prompt-snippets:/g)).toHaveLength(1);
    expect(service.extensionToggles()).toEqual({ "prompt-snippets": true, "dev-performance": false });
  });

  it("拒绝非法插件 ID（不允许路径穿越落到配置文件）", async () => {
    const files = tempFiles();
    const { service } = await start(files);
    const outcome = await service.setExtensionToggle("../../etc/passwd", false);
    expect(outcome.ok).toBe(false);
    expect(fs.existsSync(files.configFile)).toBe(false);
  });

  it("手工编辑配置文件后读取投影反映最新值，非布尔值被忽略", async () => {
    const files = tempFiles();
    fs.writeFileSync(
      files.configFile,
      [
        "extensions:",
        "  prompt-snippets:",
        "    enabled: false",
        "  broken:",
        "    enabled: yes-please"
      ].join("\n"),
      "utf8"
    );
    const { service } = await start(files);
    expect(service.extensionToggles()).toEqual({ "prompt-snippets": false });
    // 这段是动态键，不应被当成未知配置项报错。
    expect(service.unknownKeys()).not.toContain("extensions.prompt-snippets.enabled");
  });
});


it("图床列表顺序与恢复自动选择一起保存，重启后读取同一优先顺序", async () => {
  const files = tempFiles();
  const { service } = await start(files);
  const values = { "exposer.order": "cos,runninghub-temporary", "exposer.primary": "auto" };
  expect(await service.update(values)).toMatchObject({ ok: true });
  expect(service.get("exposer.order")).toBe(values["exposer.order"]);
  const { service: restarted } = await start(files);
  expect(restarted.get("exposer.order")).toBe(values["exposer.order"]);
  expect(restarted.get("exposer.primary")).toBe("auto");
});
