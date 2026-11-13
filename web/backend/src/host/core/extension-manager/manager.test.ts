/**
 * Extension Manager 流水线（change: 2026-10-21-add-extension-marketplace-point，tasks 5.6）。
 *
 * 用真实的包工具（scripts/lib 的 extension-package / extension-installations / extension-descriptor 与
 * extensions-preflight）和真实打包出的 .wxt：签名、解包、预检、指针提交都走生产代码。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceSource, ReleaseRef } from "@woohaa3/contracts";
import { createMarketplaceRegistry } from "../marketplace.js";
import { ExtensionManagerError } from "./errors.js";
import { createExtensionManager, type ExtensionManagerDeps, type ObservedHealth } from "./manager.js";
import { loadPackageToolkit } from "./toolkit.js";
import type { ExtensionPackageToolkit } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const ENGINES = { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 };

type PackModule = {
  packDirectory(input: { treeDir: string; outFile: string; privateKey?: crypto.KeyObject | string | null; keyId?: string }): { outFile: string; packageDigest: string };
  createTarGz(entries: Array<{ path: string; bytes: Buffer }>): Buffer;
  keyIdOf(publicKey: crypto.KeyObject | string): string;
};

let toolkit: ExtensionPackageToolkit;
let pack: PackModule;
const temps: string[] = [];
const managers: Array<{ close(): void }> = [];

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function setup() {
  if (!toolkit) {
    const loaded = await loadPackageToolkit({ WOOHAA3_REPO_ROOT: REPO_ROOT });
    if (!loaded) throw new Error("找不到扩展包工具");
    toolkit = loaded;
    pack = (await import(path.join(REPO_ROOT, "scripts/lib/extension-package.mjs"))) as PackModule;
  }
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** 准备一个受管扩展目录（纯前端 server-active、hostPlugin，或站点 backend 工厂）。 */
function extensionTree(options: { id?: string; version?: string; backend?: boolean; siteBackend?: boolean; descriptor?: Record<string, unknown>; marker?: string } = {}): string {
  const id = options.id ?? "demo";
  const version = options.version ?? "1.0.0";
  const dir = temp("mgr-tree-");
  const pkg: Record<string, unknown> = { name: `@woohaa3/extension-${id}`, version, type: "module" };
  const descriptor: Record<string, unknown> = { schemaVersion: 1, extensionId: id, version, engines: ENGINES, ...(options.descriptor ?? {}) };
  if (options.backend || options.siteBackend) {
    pkg.exports = { "./backend-dist/entry": "./backend-dist/entry.mjs" };
  }
  if (options.siteBackend) {
    descriptor.backend = { module: "./backend-dist/entry", factory: "createDefinition" };
    // 真声明 `site` 段：`backend + site` 是市场可安装的真实形态；缺 site 会把这条路径挡在预检之外，
    // 让「安装后需要重启」的断言失去意义。
    descriptor.site = {
      name: id,
      description: id,
      version,
      configSchema: { schemaId: `${id}-config`, schemaVersion: 1 },
      capabilities: [{ id: `${id}.probe`, kind: "handler", description: "probe" }],
      defaultEnabled: true
    };
    fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "backend-dist", "entry.mjs"),
      `export function createDefinition() { return { extensionId: ${JSON.stringify(id)}, activate: () => ({ dispose() {} }) }; }\n`
    );
  }
  if (options.backend) {
    descriptor.hostPlugin = { module: "./backend-dist/entry", factory: "createPlugin", features: ["provider"] };
    fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend-dist", "entry.mjs"), `export function createPlugin() { return {}; }\n`);
    // 子进程隔离（change: 2026-10-21-isolate-extension-host-process，D9）：受管后端包必须带构建期静态描述。
    fs.writeFileSync(
      path.join(dir, "backend-dist", "config-schema.json"),
      JSON.stringify({
        schemaVersion: 1,
        extensionId: id,
        features: ["provider"],
        factory: "createPlugin",
        plugin: { name: id, label: id, configPrefix: `providers.${id}`, fields: {}, health: false },
        publicPaths: {}
      })
    );
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify(descriptor));
  const bytes = Buffer.from(`export const v = ${JSON.stringify(`${version}${options.marker ?? ""}`)};\n`);
  fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "browser-dist", "entry.js"), bytes);
  fs.writeFileSync(
    path.join(dir, "browser-dist", "artifact-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifactId: sha256(bytes),
      metadata: { extensionId: id, version, label: id, description: id, activation: "server-active", configScope: "site", required: false, sdkAbi: 1 },
      protocolVersion: 1,
      sdkAbi: 1,
      reactMajor: 18,
      entry: "entry.js",
      styles: [],
      requiredSdkGroups: ["core"],
      requiredSdkExports: [],
      imports: [],
      files: [{ path: "entry.js", bytes: bytes.length, gzipBytes: 0, sha256: sha256(bytes), kind: "entry" }]
    })
  );
  return dir;
}

const keys = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  return { privateKey, publicKey, keyId: pack.keyIdOf(publicKey), raw };
};

function packTree(tree: string, privateKey: crypto.KeyObject | null): { file: string; digest: string } {
  const out = path.join(temp("mgr-pack-"), "pkg.wxt");
  const result = pack.packDirectory({ treeDir: tree, outFile: out, privateKey });
  return { file: result.outFile, digest: result.packageDigest };
}

type Harness = {
  manager: ReturnType<typeof createExtensionManager>;
  managedRoot: string;
  published: Array<Record<string, unknown>>;
  restarts: string[];
  health: Map<string, ObservedHealth>;
  now: { value: number };
  marketplace: ReturnType<typeof createMarketplaceRegistry>;
  /** 测试里代替安装弹窗：为 true 时每次安装都带上用户确认。 */
  acceptUntrusted: boolean;
};

async function harness(overrides: Partial<ExtensionManagerDeps> & { trustedKeys?: Array<{ keyId: string; publicKey: string }>; acceptUntrusted?: boolean; builtin?: string[]; builtinVersion?: string; builtinRequiresBackend?: boolean; builtinHotSwappable?: boolean; officialPublisherKeys?: string[] } = {}): Promise<Harness> {
  await setup();
  const acceptUntrusted = overrides.acceptUntrusted === true;
  const managerOverrides = { ...overrides };
  delete managerOverrides.acceptUntrusted;
  const managedRoot = temp("mgr-root-");
  const published: Array<Record<string, unknown>> = [];
  const restarts: string[] = [];
  const health = new Map<string, ObservedHealth>();
  const now = { value: Date.parse("2026-10-21T10:00:00Z") };
  const marketplace = createMarketplaceRegistry();
  const handle = toolkit.openInstallations({ managedRoot, lock: true });
  const manager = createExtensionManager(
    {
      managedRoot,
      toolkit,
      marketplace,
      trust: () => ({ trustedKeys: overrides.trustedKeys ?? [] }),
      ...(overrides.officialPublisherKeys ? { officialPublisherKeyIds: () => new Set(overrides.officialPublisherKeys) } : {}),
      builtins: () =>
        new Map(
          (overrides.builtin ?? []).map((id) => [
            id,
            {
              extensionId: id,
              version: overrides.builtinVersion ?? "0.0.0",
              directory: path.join(managedRoot, "builtin", id),
              requiresBackend: overrides.builtinRequiresBackend === true,
              hotSwappable: overrides.builtinHotSwappable !== false
            }
          ])
        ),
      publishBrowserRelease: async (change) => {
        published.push(change);
        return { releaseId: `r${published.length}`, href: `/extension-releases/r${published.length}.json`, changed: true };
      },
      restart: { supported: () => true, request: ({ actor }) => (restarts.push(actor), true) },
      health: (id) => health.get(id) ?? "unknown",
      now: () => new Date(now.value),
      observeMs: 60_000,
      drainPollMs: 1,
      ...managerOverrides
    },
    handle
  );
  managers.push(manager);
  return { manager, managedRoot, published, restarts, health, now, marketplace, acceptUntrusted };
}

async function installFile(h: Harness, file: string) {
  const job = await h.manager.installFromFile({
    body: fs.createReadStream(file),
    actor: "tester",
    ...(h.acceptUntrusted ? { acceptUntrusted: true } : {})
  });
  return (await h.manager.wait(job.jobId)) ?? job;
}

const installations = (root: string) => JSON.parse(fs.readFileSync(path.join(root, "installations.json"), "utf8"));

describe("Extension Manager", () => {
  it("签名的纯前端扩展：安装 → 热登记 → 观察期结束转 active", async () => {
    await setup();
    const key = keys();
    const h = await harness({ trustedKeys: [{ keyId: key.keyId, publicKey: key.raw }] });
    const { file } = packTree(extensionTree(), key.privateKey);
    const job = await installFile(h, file);
    expect(job.status).toBe("succeeded");
    expect(job.outcome).toBe("installed");
    expect(job.extensionId).toBe("demo");
    const state = installations(h.managedRoot);
    expect(state.extensions.demo).toMatchObject({ current: "1.0.0", sourceId: "local-file", trust: `signed:${key.keyId}`, state: "observing" });
    expect(fs.existsSync(path.join(h.managedRoot, "installed/demo/1.0.0/extension.json"))).toBe(true);
    expect(h.published).toEqual([{ upsert: [{ extensionId: "demo", directory: path.join(h.managedRoot, "installed/demo/1.0.0") }] }]);
    expect(fs.readdirSync(path.join(h.managedRoot, "staging"))).toEqual([]);
    h.now.value += 61_000;
    await h.manager.observe();
    expect(installations(h.managedRoot).extensions.demo.state).toBe("active");
  });

  it("签名公钥不在信任根：未确认失败且不改指针；确认后按未验证安装", async () => {
    await setup();
    const h = await harness({ trustedKeys: [] });
    const job = await installFile(h, packTree(extensionTree(), keys().privateKey).file);
    expect(job.failure?.code).toBe("MARKETPLACE_SIGNATURE_UNTRUSTED");
    expect(fs.existsSync(path.join(h.managedRoot, "installations.json"))).toBe(false);
    expect(fs.readdirSync(path.join(h.managedRoot, "staging"))).toEqual([]);
    const allowed = await harness({ acceptUntrusted: true });
    const ok = await installFile(allowed, packTree(extensionTree(), keys().privateKey).file);
    expect(ok.status).toBe("succeeded");
    expect(installations(allowed.managedRoot).extensions.demo.trust).toBe("unsigned");
  });

  it("未签名包：未确认时拒绝；安装请求明确确认后记为 unsigned", async () => {
    await setup();
    const rejected = await harness();
    expect((await installFile(rejected, packTree(extensionTree(), null).file)).failure?.code).toBe("MARKETPLACE_UNSIGNED_REJECTED");
    const allowed = await harness({ acceptUntrusted: true });
    const job = await installFile(allowed, packTree(extensionTree(), null).file);
    expect(job.status).toBe("succeeded");
    expect(installations(allowed.managedRoot).extensions.demo.trust).toBe("unsigned");
  });

  it("包内文件被篡改（与 FILES.json 不符）→ MARKETPLACE_DIGEST_MISMATCH", async () => {
    await setup();
    const key = keys();
    const h = await harness({ trustedKeys: [{ keyId: key.keyId, publicKey: key.raw }] });
    const { file } = packTree(extensionTree(), key.privateKey);
    // 改写 FILES.json 外的一个文件：重新打 tar（不重签），模拟传输中被替换。
    const unpack = temp("mgr-tamper-");
    await toolkit.unpackExtensionPackage({ packagePath: file, destDir: path.join(unpack, "t") });
    fs.writeFileSync(path.join(unpack, "t", "browser-dist", "entry.js"), "export const evil = 1;\n");
    const entries: Array<{ path: string; bytes: Buffer }> = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else entries.push({ path: rel, bytes: fs.readFileSync(path.join(dir, entry.name)) });
      }
    };
    walk(path.join(unpack, "t"));
    const tampered = path.join(unpack, "tampered.wxt");
    fs.writeFileSync(tampered, pack.createTarGz(entries));
    expect((await installFile(h, tampered)).failure?.code).toBe("MARKETPLACE_DIGEST_MISMATCH");
  });

  it("路径穿越条目 → MARKETPLACE_ARCHIVE_UNSAFE，不写出解包目录外的文件", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    const dir = temp("mgr-evil-");
    const evil = path.join(dir, "evil.wxt");
    fs.writeFileSync(evil, pack.createTarGz([{ path: "../escape.txt", bytes: Buffer.from("x") }]));
    expect((await installFile(h, evil)).failure?.code).toBe("MARKETPLACE_ARCHIVE_UNSAFE");
    expect(fs.existsSync(path.join(h.managedRoot, "staging", "escape.txt"))).toBe(false);
  });

  it("超过大小上限 → MARKETPLACE_PACKAGE_TOO_LARGE", async () => {
    const h = await harness({ acceptUntrusted: true, limits: { maxPackageBytes: 64 } });
    const job = await h.manager.installFromFile({ body: Readable.from([Buffer.alloc(128)]), actor: "t" });
    expect(job.failure?.code).toBe("MARKETPLACE_PACKAGE_TOO_LARGE");
  });

  it("预检禁止项（migrate / always）→ MARKETPLACE_FORBIDDEN_DECLARATION；engines 不兼容 → MARKETPLACE_ENGINES_INCOMPATIBLE", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    const migrate = await installFile(h, packTree(extensionTree({ descriptor: { migrate: { module: "./x", export: "m" } } }), null).file);
    expect(migrate.failure?.code).toBe("MARKETPLACE_FORBIDDEN_DECLARATION");
    const engines = await installFile(h, packTree(extensionTree({ descriptor: { engines: { ...ENGINES, hostAbi: "^9.0.0" } } }), null).file);
    expect(engines.failure?.code).toBe("MARKETPLACE_ENGINES_INCOMPATIBLE");
    const broken = await installFile(h, packTree(extensionTree({ descriptor: { version: "2.0.0" } }), null).file);
    expect(broken.failure?.code).toBe("MARKETPLACE_PREFLIGHT_FAILED");
    expect(broken.failure?.issues?.length).toBeGreaterThan(0);
  });

  it("与内置扩展同 id：不高于内置版本 → MARKETPLACE_BUILTIN_CONFLICT；严格更高且官方签名 → 允许覆盖", async () => {
    await setup();
    const same = await harness({ acceptUntrusted: true, builtin: ["demo"], builtinVersion: "1.0.0" });
    expect((await installFile(same, packTree(extensionTree(), null).file)).failure?.code).toBe("MARKETPLACE_BUILTIN_CONFLICT");
    const older = await harness({ acceptUntrusted: true, builtin: ["demo"], builtinVersion: "2.0.0" });
    expect((await installFile(older, packTree(extensionTree(), null).file)).failure?.code).toBe("MARKETPLACE_BUILTIN_CONFLICT");
    const key = keys();
    const newer = await harness({
      trustedKeys: [{ keyId: key.keyId, publicKey: key.raw }],
      builtin: ["demo"],
      builtinVersion: "0.9.0",
      officialPublisherKeys: [key.keyId]
    });
    expect((await installFile(newer, packTree(extensionTree(), key.privateKey).file)).outcome).toBe("installed");
    const unsigned = await harness({ acceptUntrusted: true, builtin: ["demo"], builtinVersion: "0.9.0" });
    expect((await installFile(unsigned, packTree(extensionTree(), null).file)).failure?.code).toBe("MARKETPLACE_PUBLISHER_CHANGED");
  });

  it("内置版本被更高受管版本覆盖：安装把内置目录当回退，卸载后热切回内置", async () => {
    await setup();
    const swaps: Array<{ id: string; dir: string | null; previous: string | null }> = [];
    const runtime = {
      available: () => true,
      swap: async (id: string, dir: string, _version: string, previous: string | null) => {
        swaps.push({ id, dir, previous });
        return { swapped: true };
      },
      remove: async () => undefined
    };
    const key = keys();
    const h = await harness({
      trustedKeys: [{ keyId: key.keyId, publicKey: key.raw }],
      builtin: ["demo"],
      builtinVersion: "0.9.0",
      builtinRequiresBackend: true,
      builtinHotSwappable: true,
      officialPublisherKeys: [key.keyId],
      runtime
    });
    await installFile(h, packTree(extensionTree({ backend: true }), key.privateKey).file);
    const builtinDir = path.join(h.managedRoot, "builtin", "demo");
    const managedDir = path.join(h.managedRoot, "installed/demo/1.0.0");
    expect(swaps[0]).toEqual({ id: "demo", dir: managedDir, previous: builtinDir });

    const job = h.manager.uninstall("demo", { actor: "tester" });
    const done = await h.manager.wait(job.jobId);
    expect(done?.outcome).toBe("installed");
    expect(swaps.at(-1)).toEqual({ id: "demo", dir: builtinDir, previous: managedDir });
    expect(installations(h.managedRoot).extensions.demo).toBeUndefined();
  });

  it("已安装扩展的发布者 key 变更 → MARKETPLACE_PUBLISHER_CHANGED，指针不变", async () => {
    await setup();
    const first = keys();
    const second = keys();
    const h = await harness({
      trustedKeys: [
        { keyId: first.keyId, publicKey: first.raw },
        { keyId: second.keyId, publicKey: second.raw }
      ]
    });
    expect((await installFile(h, packTree(extensionTree({ version: "1.0.0" }), first.privateKey).file)).outcome).toBe("installed");
    const changed = await installFile(h, packTree(extensionTree({ version: "1.1.0" }), second.privateKey).file);
    expect(changed.failure?.code).toBe("MARKETPLACE_PUBLISHER_CHANGED");
    expect(installations(h.managedRoot).extensions.demo.current).toBe("1.0.0");
  });

  it("重复安装同一内容 → already-current，不推进 revision；同版本不同内容 → MARKETPLACE_VERSION_CONTENT_CONFLICT", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    expect((await installFile(h, packTree(extensionTree(), null).file)).outcome).toBe("installed");
    const revision = installations(h.managedRoot).revision;
    expect((await installFile(h, packTree(extensionTree(), null).file)).outcome).toBe("already-current");
    expect(installations(h.managedRoot).revision).toBe(revision);
    const conflict = await installFile(h, packTree(extensionTree({ marker: "-other" }), null).file);
    expect(conflict.failure?.code).toBe("MARKETPLACE_VERSION_CONTENT_CONFLICT");
    expect(installations(h.managedRoot).extensions.demo.current).toBe("1.0.0");
  });

  it("升级保留 previous，手动回滚只切指针且幂等", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    await installFile(h, packTree(extensionTree({ version: "1.0.0" }), null).file);
    await installFile(h, packTree(extensionTree({ version: "1.1.0" }), null).file);
    expect(installations(h.managedRoot).extensions.demo).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
    const job = h.manager.rollback("demo", { actor: "t" });
    const done = await h.manager.wait(job.jobId);
    expect(done?.outcome).toBe("installed");
    expect(installations(h.managedRoot).extensions.demo).toMatchObject({ current: "1.0.0", previous: "1.1.0" });
    const again = await h.manager.wait(h.manager.rollback("demo", { actor: "t", toVersion: "1.0.0" }).jobId);
    expect(again?.outcome).toBe("already-current");
    const none = await h.manager.wait(h.manager.rollback("demo", { actor: "t", toVersion: "0.9.0" }).jobId);
    expect(none?.failure?.code).toBe("MARKETPLACE_NO_PREVIOUS_VERSION");
    expect(installations(h.managedRoot).extensions.demo.history.map((entry: { action: string }) => entry.action)).toEqual(["install", "install", "rollback"]);
  });

  it("观察期内健康失败 → 自动回滚并标记 rejected；没有上一版本时只标记", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, observeFailureThreshold: 2 });
    await installFile(h, packTree(extensionTree({ version: "1.0.0" }), null).file);
    h.now.value += 61_000;
    await h.manager.observe();
    await installFile(h, packTree(extensionTree({ version: "1.1.0" }), null).file);
    h.health.set("demo", "degraded");
    await h.manager.observe();
    expect(installations(h.managedRoot).extensions.demo.current).toBe("1.1.0");
    await h.manager.observe();
    const record = installations(h.managedRoot).extensions.demo;
    expect(record).toMatchObject({ current: "1.0.0", previous: "1.1.0", rejected: ["1.1.0"], state: "active" });
    expect(h.published.at(-1)).toEqual({ upsert: [{ extensionId: "demo", directory: path.join(h.managedRoot, "installed/demo/1.0.0") }] });
  });

  it("含后端扩展：提交后 restart-required，不热登记；受控重启经宿主控制器", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    const job = await installFile(h, packTree(extensionTree({ backend: true }), null).file);
    expect(job.outcome).toBe("restart-required");
    expect(h.published).toEqual([]);
    expect(h.manager.installed()[0]).toMatchObject({ extensionId: "demo", restartRequired: true });
    expect(installations(h.managedRoot).extensions.demo.observeUntil).toBeNull();
    h.manager.requestRestart("admin");
    expect(h.restarts).toEqual(["admin"]);
  });

  it("站点 backend 扩展（带 site 段）：restart-required，不 swap、不热登记", async () => {
    await setup();
    const swaps: unknown[] = [];
    const runtime = {
      available: () => true,
      swap: async (...args: unknown[]) => {
        swaps.push(args);
        return { swapped: true };
      },
      remove: async () => undefined
    };
    const h = await harness({ acceptUntrusted: true, runtime });
    const job = await installFile(h, packTree(extensionTree({ siteBackend: true }), null).file);
    expect(job.outcome).toBe("restart-required");
    expect(swaps).toEqual([]);
    expect(h.published).toEqual([]);
    expect(installations(h.managedRoot).extensions.demo).toMatchObject({
      requiresRestart: true,
      hotSwappable: false,
      restartPending: true
    });
  });

  it("站点 backend 扩展（带 site 段）卸载：不调用运行期 remove，仍要求重启", async () => {
    await setup();
    const removes: string[] = [];
    const runtime = {
      available: () => true,
      swap: async () => ({ swapped: true }),
      remove: async (id: string) => {
        removes.push(id);
      }
    };
    const h = await harness({ acceptUntrusted: true, runtime });
    await installFile(h, packTree(extensionTree({ siteBackend: true }), null).file);
    const job = h.manager.uninstall("demo", { actor: "tester" });
    const done = await h.manager.wait(job.jobId);
    expect(done?.outcome).toBe("restart-required");
    expect(removes).toEqual([]);
    expect(installations(h.managedRoot).extensions.demo).toBeUndefined();
  });

  it("不支持受控重启 → MARKETPLACE_RESTART_UNSUPPORTED", async () => {
    const h = await harness({ restart: { supported: () => false, request: () => false } });
    expect(() => h.manager.requestRestart("a")).toThrow(expect.objectContaining({ code: "MARKETPLACE_RESTART_UNSUPPORTED" }));
  });

  it("重启后恢复：待重启记录清零并从现在开始观察期；残留 staging 被清理", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    await installFile(h, packTree(extensionTree({ backend: true }), null).file);
    h.manager.close();
    fs.mkdirSync(path.join(h.managedRoot, "staging", "crashed-job", "tree"), { recursive: true });
    const handle = toolkit.openInstallations({ managedRoot: h.managedRoot, lock: true });
    const next = createExtensionManager(
      { managedRoot: h.managedRoot, toolkit, marketplace: createMarketplaceRegistry(), trust: () => ({ trustedKeys: [] }), builtins: () => new Map(), now: () => new Date(h.now.value), observeMs: 60_000 },
      handle
    );
    managers.push(next);
    expect(fs.readdirSync(path.join(h.managedRoot, "staging"))).toEqual([]);
    const record = installations(h.managedRoot).extensions.demo;
    expect(record.restartPending).toBe(false);
    expect(record.state).toBe("observing");
    expect(Date.parse(record.observeUntil)).toBe(h.now.value + 60_000);
  });

  it("卸载：先停用并等 draining 收尾，再删除指针与发布条目", async () => {
    await setup();
    const states = ["draining", "draining", "disabled"];
    const disableSite = vi.fn(async () => "draining" as const);
    const h = await harness({ acceptUntrusted: true, disableSite, siteState: () => (states.shift() as "draining" | "disabled") ?? "disabled" });
    await installFile(h, packTree(extensionTree(), null).file);
    const done = await h.manager.wait(h.manager.uninstall("demo", { actor: "admin" }).jobId);
    expect(done?.outcome).toBe("installed");
    expect(disableSite).toHaveBeenCalledWith("demo", "admin");
    expect(installations(h.managedRoot).extensions.demo).toBeUndefined();
    expect(h.published.at(-1)).toEqual({ remove: ["demo"] });
    await expect(h.manager.wait(h.manager.uninstall("demo", { actor: "a" }).jobId)).resolves.toMatchObject({ failure: { code: "MARKETPLACE_NOT_INSTALLED" } });
  });

  it("卸载时 draining 超时 → MARKETPLACE_UNINSTALL_DRAINING，记录仍在", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, disableSite: async () => "draining", siteState: () => "draining", drainTimeoutMs: 0 });
    await installFile(h, packTree(extensionTree(), null).file);
    const done = await h.manager.wait(h.manager.uninstall("demo", { actor: "a" }).jobId);
    expect(done?.failure?.code).toBe("MARKETPLACE_UNINSTALL_DRAINING");
    expect(installations(h.managedRoot).extensions.demo.state).toBe("uninstalling");
  });

  it("热登记失败 → 回滚到旧版本（首次安装则撤销记录），任务失败", async () => {
    await setup();
    let fail = false;
    const h = await harness({
      acceptUntrusted: true,
      publishBrowserRelease: async () => {
        if (fail) throw Object.assign(new Error("catalog invalid"), { code: "EXTENSION_RELEASE_INVALID" });
        return { releaseId: "r", href: "/r", changed: true };
      }
    });
    await installFile(h, packTree(extensionTree({ version: "1.0.0" }), null).file);
    fail = true;
    const job = await installFile(h, packTree(extensionTree({ version: "1.1.0" }), null).file);
    expect(job.failure?.code).toBe("MARKETPLACE_PREFLIGHT_FAILED");
    expect(installations(h.managedRoot).extensions.demo).toMatchObject({ current: "1.0.0", rejected: ["1.1.0"] });
  });

  it("市场来源：resolve 引擎不兼容在下载前拒绝；摘要不符拒绝；同请求进行中去重", async () => {
    await setup();
    const key = keys();
    const h = await harness({ trustedKeys: [{ keyId: key.keyId, publicKey: key.raw }] });
    const { file, digest } = packTree(extensionTree(), key.privateKey);
    let downloads = 0;
    let ref: ReleaseRef = { sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: digest, size: fs.statSync(file).size };
    let gate: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (gate = resolve));
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [{ extensionId: "demo", label: "Demo", latest: "1.0.0" }] }),
      resolve: async () => ref,
      download: async () => {
        downloads += 1;
        await blocked;
        return { stream: Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>, size: ref.size };
      }
    };
    h.marketplace.register(source);
    const first = h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "^1.0.0", actor: "a" });
    const second = h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "^1.0.0", actor: "a" });
    expect(second.jobId).toBe(first.jobId);
    gate();
    expect((await h.manager.wait(first.jobId))?.status).toBe("succeeded");
    expect(downloads).toBe(1);

    ref = { ...ref, version: "1.1.0", engines: { ...ENGINES, protocolVersion: 99 } };
    const incompatible = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(incompatible?.failure?.code).toBe("MARKETPLACE_ENGINES_INCOMPATIBLE");
    expect(downloads).toBe(1);

    ref = { ...ref, version: "1.0.1", engines: ENGINES, packageDigest: "sha256:" + "0".repeat(64) };
    const mismatch = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(mismatch?.failure?.code).toBe("MARKETPLACE_DIGEST_MISMATCH");

    const page = await h.manager.search({ text: "d" });
    expect(page.items.map((item) => item.extensionId)).toEqual(["demo"]);
    const missing = await h.manager.wait(h.manager.installFromSource({ sourceId: "nope", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(missing?.failure?.code).toBe("MARKETPLACE_SOURCE_UNAVAILABLE");
  });

  it("下载瞬时失败自动重试：第二次成功则照常安装", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, download: { attempts: 3, backoffMs: [0, 0] } });
    const { file, digest } = packTree(extensionTree(), null);
    const ref: ReleaseRef = { sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: digest, size: fs.statSync(file).size };
    let attempts = 0;
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => ref,
      download: async () => {
        attempts += 1;
        if (attempts === 1) throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "下载停滞：60 秒内没有收到新数据", undefined, { retryable: true });
        return { stream: Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>, size: ref.size };
      }
    };
    h.marketplace.register(source);
    const done = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "^1.0.0", actor: "a", acceptUntrusted: true }).jobId);
    expect(done?.status).toBe("succeeded");
    expect(attempts).toBe(2);
  });

  it("重试耗尽：失败原因带「读到哪里」与尝试次数，暂存区清空、指针不动", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, download: { attempts: 3, backoffMs: [0, 0] } });
    const { file, digest } = packTree(extensionTree(), null);
    const bytes = fs.readFileSync(file);
    const ref: ReleaseRef = { sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: digest, size: bytes.length };
    let attempts = 0;
    /** 先吐一半字节、让流水线落盘，再断开：模拟传输到一半连接被网络吞掉。 */
    const halfThenBreak = (half: Buffer) => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(half));
            return;
          }
          setTimeout(() => controller.error(new Error("socket hang up")), 20);
        }
      });
    };
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => ref,
      download: async () => {
        attempts += 1;
        // 每次重试都写同一个 package.wxt：能跑起来说明重试前清掉了上次的半截包（writePackage 用 wx）。
        return { stream: halfThenBreak(bytes.subarray(0, Math.ceil(bytes.length / 2))), size: bytes.length };
      }
    };
    h.marketplace.register(source);
    const done = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(done?.status).toBe("failed");
    expect(done?.failure?.code).toBe("MARKETPLACE_DOWNLOAD_FAILED");
    expect(done?.failure?.message).toContain("已收到 50%");
    expect(done?.failure?.message).toContain("已尝试 3 次");
    expect(attempts).toBe(3);
    expect(fs.existsSync(path.join(h.managedRoot, "installations.json"))).toBe(false);
    expect(fs.readdirSync(path.join(h.managedRoot, "staging"))).toEqual([]);
  });

  it("来源不设时限时也有看门狗：传输停滞按断流重试，不会无限挂住", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, download: { attempts: 3, backoffMs: [0, 0], idleTimeoutMs: 30 } });
    const { file, digest } = packTree(extensionTree(), null);
    const ref: ReleaseRef = { sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: digest, size: fs.statSync(file).size };
    let attempts = 0;
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => ref,
      download: async () => {
        attempts += 1;
        // 永远不给字节：来源没有自己的超时（本部署市场就是这样），只能靠流水线看门狗。
        return { stream: new ReadableStream<Uint8Array>({ start: () => undefined }), size: ref.size };
      }
    };
    h.marketplace.register(source);
    const done = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a", acceptUntrusted: true }).jobId);
    expect(done?.failure?.code).toBe("MARKETPLACE_DOWNLOAD_FAILED");
    expect(done?.failure?.message).toContain("下载停滞");
    expect(done?.failure?.message).toContain("已尝试 3 次");
    expect(attempts).toBe(3);
  });

  it("非瞬时失败（HTTP 4xx）不重试", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, download: { attempts: 3, backoffMs: [0, 0] } });
    const { file, digest } = packTree(extensionTree(), null);
    const ref: ReleaseRef = { sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: digest, size: fs.statSync(file).size };
    let attempts = 0;
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => ref,
      download: async () => {
        attempts += 1;
        throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "下载扩展包失败（HTTP 404）");
      }
    };
    h.marketplace.register(source);
    const done = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(done?.failure?.code).toBe("MARKETPLACE_DOWNLOAD_FAILED");
    expect(attempts).toBe(1);
    expect(done?.failure?.message).not.toContain("已尝试");
  });

  it("依赖不满足 → MARKETPLACE_DEPENDENCY_UNSATISFIED", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, installedVersions: () => new Map([["base", "1.0.0"]]) });
    const source: MarketplaceSource = {
      sourceId: "corp",
      label: "corp",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => ({ sourceId: "corp", extensionId: "demo", version: "1.0.0", engines: ENGINES, packageDigest: "sha256:x", size: 10, dependencies: { base: "^2.0.0" } }),
      download: async () => {
        throw new Error("不应下载");
      }
    };
    h.marketplace.register(source);
    const done = await h.manager.wait(h.manager.installFromSource({ sourceId: "corp", extensionId: "demo", range: "*", actor: "a" }).jobId);
    expect(done?.failure?.code).toBe("MARKETPLACE_DEPENDENCY_UNSATISFIED");
  });

  it("取消：提交前取消的任务终止，不留 staging 与指针", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true });
    let release: () => void = () => undefined;
    const source: MarketplaceSource = {
      sourceId: "slow",
      label: "slow",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return null;
      },
      download: async () => {
        throw new Error("unused");
      }
    };
    h.marketplace.register(source);
    const job = h.manager.installFromSource({ sourceId: "slow", extensionId: "demo", range: "*", actor: "a" });
    expect(h.manager.cancel(job.jobId)?.status).toBe("cancelled");
    release();
    const done = await h.manager.wait(job.jobId);
    expect(done?.failure?.code).toBe("MARKETPLACE_CANCELLED");
    expect(fs.existsSync(path.join(h.managedRoot, "installations.json"))).toBe(false);
  });

  it("第二个进程打开同一受管根 → MARKETPLACE_WRITER_LOCKED（锁由仍存活的持有者占用）", async () => {
    await setup();
    const h = await harness();
    // 伪造存活的其他持有者：用父进程 pid 写锁文件。
    fs.writeFileSync(path.join(h.managedRoot, "installations.lock"), JSON.stringify({ pid: process.ppid, owner: "other" }));
    expect(() => toolkit.openInstallations({ managedRoot: h.managedRoot, lock: true })).toThrow(expect.objectContaining({ code: "MARKETPLACE_WRITER_LOCKED" }));
  });

  it("没有受管根句柄时：安装直接失败为 MARKETPLACE_UNAVAILABLE", async () => {
    await setup();
    const manager = createExtensionManager(
      { managedRoot: "/nonexistent", toolkit, marketplace: createMarketplaceRegistry(), trust: () => ({ trustedKeys: [] }), builtins: () => new Map() },
      null
    );
    managers.push(manager);
    const job = await manager.installFromFile({ body: Readable.from([Buffer.from("x")]), actor: "a" });
    expect(job.failure?.code).toBe("MARKETPLACE_UNAVAILABLE");
    expect(manager.installed()).toEqual([]);
  });

  it("孤儿版本目录在保留期后清理，current/previous 保留", async () => {
    await setup();
    const h = await harness({ acceptUntrusted: true, retentionMs: 0 });
    await installFile(h, packTree(extensionTree({ version: "1.0.0" }), null).file);
    await installFile(h, packTree(extensionTree({ version: "1.1.0" }), null).file);
    await installFile(h, packTree(extensionTree({ version: "1.2.0" }), null).file);
    // 保留期按文件 mtime（真实墙钟）判断：把假时钟推到真实时间之后，避免测试结果随运行时刻变化。
    h.now.value = Date.now() + 1000;
    expect(h.manager.sweep()).toBe(1);
    expect(fs.readdirSync(path.join(h.managedRoot, "installed/demo")).sort()).toEqual(["1.1.0", "1.2.0"]);
  });
});

describe("trust activation lifecycle",()=>{
 it("quarantines a known revoked installation and attempts every cleanup even if disabling fails",async()=>{
  await setup();const key=keys();let revoked=false;
  const gate=vi.fn(async()=>{if(revoked)throw new Error("revoked")});
  const remove=vi.fn(async()=>undefined),publish=vi.fn(async()=>({releaseId:"r",href:"/r",changed:true}));
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate},disableSite:async()=>{throw new Error("disable unavailable")},runtime:{available:()=>true,swap:async()=>({swapped:true}),remove},publishBrowserRelease:publish});
  expect((await installFile(h,packTree(extensionTree(),key.privateKey).file)).status).toBe("succeeded");
  revoked=true;await h.manager.observe();
  expect(h.manager.installed()[0]).toMatchObject({quarantine:"revoked",restartRequired:true});
  expect(remove).toHaveBeenCalledWith("demo");expect(publish).toHaveBeenCalledWith({remove:["demo"]});
  await h.manager.observe();expect(remove.mock.calls.length).toBeGreaterThan(1);
 });
 it("manual rollback requires fresh authorization and preserves the pointer on rejection",async()=>{
  await setup();const key=keys();let deny=false;
  const gate=vi.fn(async(input:{dir:string;fresh?:boolean})=>{if(deny&&input.fresh)throw new Error("revoked previous version")});
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate}});
  await installFile(h,packTree(extensionTree({version:"1.0.0"}),key.privateKey).file);
  await installFile(h,packTree(extensionTree({version:"1.1.0"}),key.privateKey).file);
  deny=true;const job=h.manager.rollback("demo",{actor:"tester"});const result=await h.manager.wait(job.jobId);
  expect(result?.status).toBe("failed");expect(h.manager.installed()[0]?.version).toBe("1.1.0");
  expect(gate.mock.calls.some(([input])=>input.fresh===true)).toBe(true);
 });
});

describe("trust check cadence and reinstall",()=>{
 it("re-verifies on the first observe, then throttles until the interval elapses",async()=>{
  await setup();const key=keys();const gate=vi.fn(async()=>undefined);
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate},trustCheckMs:60_000});
  await installFile(h,packTree(extensionTree(),key.privateKey).file);
  const first=gate.mock.calls.length;await h.manager.observe();
  expect(gate.mock.calls.length).toBe(first+1);
  await h.manager.observe();
  expect(gate.mock.calls.length).toBe(first+1);
  h.now.value+=61_000;await h.manager.observe();
  expect(gate.mock.calls.length).toBe(first+2);
 });
 it("reinstalling a quarantined version restores runtime and browser publication",async()=>{
  await setup();const key=keys();let revoked=false;
  const gate=vi.fn(async()=>{if(revoked)throw new Error("revoked")});
  const swap=vi.fn(async()=>({swapped:true}));
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate},runtime:{available:()=>true,swap,remove:async()=>undefined}});
  const packed=packTree(extensionTree({backend:true}),key.privateKey);
  expect((await installFile(h,packed.file)).status).toBe("succeeded");
  revoked=true;await h.manager.observe();expect(h.manager.installed()[0]?.quarantine).toBe("revoked");
  revoked=false;swap.mockClear();h.published.length=0;
  const job=await installFile(h,packed.file);
  expect(job.status).toBe("succeeded");expect(job.outcome).toBe("installed");
  expect(swap).toHaveBeenCalled();expect(h.published.some(value=>Array.isArray(value.upsert))).toBe(true);
  expect(h.manager.installed()[0]?.quarantine).toBeUndefined();
 });
 it("rollback of a record without per-version evidence does not compare the old digest",async()=>{
  await setup();const key=keys();const calls:Array<{dir:string;record?:{filesDigest?:string;trust?:string}}>=[];
  const gate=vi.fn(async(input:{dir:string;record?:{filesDigest?:string;trust?:string}})=>{calls.push(input)});
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate}});
  await installFile(h,packTree(extensionTree({version:"1.0.0"}),key.privateKey).file);
  await installFile(h,packTree(extensionTree({version:"1.1.0"}),key.privateKey).file);
  // 模拟改版前写下的记录：没有 versions 表。
  const state=installations(h.managedRoot);delete state.extensions.demo.versions;
  fs.writeFileSync(path.join(h.managedRoot,"installations.json"),JSON.stringify(state));
  calls.length=0;
  const job=h.manager.rollback("demo",{actor:"tester"});const result=await h.manager.wait(job.jobId);
  expect(result?.status).toBe("succeeded");
  const target=calls.find(call=>call.dir.endsWith("/1.0.0"));
  expect(target?.record?.filesDigest).toBeUndefined();
  expect(target?.record?.trust).toBeUndefined();
 });
});


describe("evidence-free activation",()=>{
 it("does not quarantine a pre-v2 installation when the trust layer abstains",async()=>{
  await setup();const key=keys();
  const gate=vi.fn(async()=>null);
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate}});
  await installFile(h,packTree(extensionTree(),key.privateKey).file);
  // 模拟改动之前写下的记录：没有 versions、没有 filesDigest（管理器只有 v1 结论）。
  const state=installations(h.managedRoot);
  delete state.extensions.demo.versions;delete state.extensions.demo.filesDigest;
  fs.writeFileSync(path.join(h.managedRoot,"installations.json"),JSON.stringify(state));
  await h.manager.observe();
  expect(gate).toHaveBeenCalled();
  expect(h.manager.installed()[0]?.quarantine).toBeUndefined();
 });
});

describe("trust recovery regressions",()=>{
 it("invalidates the full verification throttle when signed metadata changes",async()=>{
  await setup();const key=keys();let generation="one",revoked=false;
  const gate=vi.fn(async()=>{if(revoked)throw new Error("revoked")});
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate,trustStateStamp:()=>generation}});
  await installFile(h,packTree(extensionTree(),key.privateKey).file);
  await h.manager.observe();const calls=gate.mock.calls.length;
  await h.manager.observe();expect(gate.mock.calls.length).toBe(calls);
  generation="two";revoked=true;await h.manager.observe();
  expect(h.manager.installed()[0]?.quarantine).toBe("revoked");
 });
 it("stops retrying quarantine cleanup after a successful retry",async()=>{
  await setup();const key=keys();let revoked=false,fail=true;
  const gate=vi.fn(async()=>{if(revoked)throw new Error("revoked")});
  const remove=vi.fn(async()=>{if(fail)throw new Error("remove failed")});
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate},runtime:{available:()=>true,swap:async()=>({swapped:true}),remove}});
  await installFile(h,packTree(extensionTree(),key.privateKey).file);revoked=true;
  await h.manager.observe();expect(h.manager.installed()[0]?.restartRequired).toBe(true);
  fail=false;await h.manager.observe();const calls=remove.mock.calls.length;
  expect(installations(h.managedRoot).extensions.demo.quarantineCleanupPending).toBe(false);
  expect(h.manager.installed()[0]?.restartRequired).toBe(false);
  await h.manager.observe();expect(remove.mock.calls.length).toBe(calls);
 });
 it("does not clear quarantine when the reused installed tree is corrupt",async()=>{
  await setup();const key=keys();let revoked=false;
  const gate=vi.fn(async()=>{if(revoked)throw new Error("revoked")});
  const h=await harness({trustedKeys:[{keyId:key.keyId,publicKey:key.raw}],toolkit:{...toolkit,verifyManagedActivation:gate}});
  const packed=packTree(extensionTree(),key.privateKey);await installFile(h,packed.file);
  revoked=true;await h.manager.observe();revoked=false;
  fs.writeFileSync(path.join(h.managedRoot,"installed/demo/1.0.0/extension.json"),"{}");
  expect((await installFile(h,packed.file)).status).toBe("failed");
  expect(h.manager.installed()[0]?.quarantine).toBe("revoked");
 });
});
