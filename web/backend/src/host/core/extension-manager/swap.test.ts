/**
 * Extension Manager 的蓝绿切换分支（change: 2026-10-21-isolate-extension-host-process，tasks 8.2 / 8.3）。
 *
 * 真实包工具 + 真实 .wxt；隔离端口（swap）用替身，记录调用并可注入失败。覆盖：
 * - 子进程托管的含后端扩展升级：requiresRestart=false、调 swap(新版本目录)、观察期从切换完成开始；
 * - 绿激活失败（MARKETPLACE_SWAP_FAILED）：蓝不受影响（未再调 swap 切走）、指针回到旧版本；
 * - 回滚也是一次 swap；同版本 swap 为 no-op；
 * - 隔离关闭（无端口）或首次安装（未托管）：仍 restart-required；
 * - 观察期内崩溃 → handleObservationCrash 回滚；没有上一版本时返回 false；
 * - 预检缺构建期描述 → 任务失败码 MARKETPLACE_PACKAGE_INVALID。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMarketplaceRegistry } from "../marketplace.js";
import { createExtensionManager, type ExtensionManagerDeps } from "./manager.js";
import type { ExtensionIsolationPort } from "./manager-types.js";
import { loadPackageToolkit } from "./toolkit.js";
import type { ExtensionPackageToolkit } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const ENGINES = { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 };

let toolkit: ExtensionPackageToolkit;
let packDirectory: (input: { treeDir: string; outFile: string }) => { outFile: string };
const temps: string[] = [];
const managers: Array<{ close(): void }> = [];

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  if (toolkit) return;
  const loaded = await loadPackageToolkit({ WOOHAA3_REPO_ROOT: REPO_ROOT });
  if (!loaded) throw new Error("找不到扩展包工具");
  toolkit = loaded;
  packDirectory = ((await import(path.join(REPO_ROOT, "scripts/lib/extension-package.mjs"))) as { packDirectory: typeof packDirectory }).packDirectory;
}

/** 含后端的受管扩展包（打包后形态：backend-dist/entry.mjs + config-schema.json）。 */
function backendPackage(version: string, { schema = true }: { schema?: boolean } = {}): string {
  const dir = temp("swap-tree-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@woohaa3/extension-demo", version, type: "module", exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } }));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    JSON.stringify({ schemaVersion: 1, extensionId: "demo", version, engines: ENGINES, hostPlugin: { module: "./backend-dist/entry", factory: "createPlugin", kind: "provider" } })
  );
  fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backend-dist", "entry.mjs"), `export function createPlugin() { return {}; } // ${version}\n`);
  if (schema) {
    fs.writeFileSync(
      path.join(dir, "backend-dist", "config-schema.json"),
      JSON.stringify({ schemaVersion: 1, extensionId: "demo", kind: "provider", factory: "createPlugin", plugin: { name: "demo", label: "demo", configPrefix: "providers.demo", fields: {}, health: false }, publicPaths: {} })
    );
  }
  return packDirectory({ treeDir: dir, outFile: path.join(temp("swap-pack-"), `demo-${version}.wxt`) }).outFile;
}

type SwapCall = { extensionId: string; directory: string };

/** 带运行期装配的隔离端口替身（首次安装热装，任务 8.4）。`attachFails` 让 attach 失败。 */
function attachingIsolation(options: { attachFails?: boolean } = {}) {
  const base = fakeIsolation([]);
  const attached = new Set<string>();
  const detached: string[] = [];
  const port: ExtensionIsolationPort = {
    ...base.port,
    isolated: (id) => attached.has(id),
    canAttach: () => true,
    async attach(extensionId, directory) {
      if (options.attachFails) throw Object.assign(new Error("就绪超时"), { code: "activation-timeout" });
      attached.add(extensionId);
      base.active.set(extensionId, directory);
      return { state: "active" };
    },
    async detach(extensionId) {
      attached.delete(extensionId);
      detached.push(extensionId);
    }
  };
  return { ...base, port, attached, detached };
}

/** 隔离端口替身：记录 swap；`failNext` 让下一次 swap 以 MARKETPLACE_SWAP_FAILED 失败；同目录返回 swapped:false。 */
function fakeIsolation(isolatedIds: string[] = ["demo"]) {
  const calls: SwapCall[] = [];
  const removed: string[] = [];
  const active = new Map<string, string>();
  const state = { failNext: false };
  const port: ExtensionIsolationPort = {
    isolated: (id) => isolatedIds.includes(id),
    async swap(extensionId, directory) {
      calls.push({ extensionId, directory });
      if (state.failNext) {
        state.failNext = false;
        throw Object.assign(new Error("绿实例激活超时"), { code: "MARKETPLACE_SWAP_FAILED", cause: { code: "activation-timeout" } });
      }
      if (active.get(extensionId) === directory) return { swapped: false };
      active.set(extensionId, directory);
      return { swapped: true };
    },
    async remove(extensionId) {
      removed.push(extensionId);
      active.delete(extensionId);
    }
  };
  return { port, calls, removed, active, state };
}

async function harness(overrides: Partial<ExtensionManagerDeps> = {}) {
  await setup();
  const managedRoot = temp("swap-root-");
  const published: Array<Record<string, unknown>> = [];
  const now = { value: Date.parse("2026-10-21T10:00:00Z") };
  const manager = createExtensionManager(
    {
      managedRoot,
      toolkit,
      marketplace: createMarketplaceRegistry(),
      trust: () => ({ trustedKeys: [], allowUnsignedLocal: true }),
      builtinIds: () => new Set(),
      publishBrowserRelease: async (change) => {
        published.push(change);
        return { releaseId: `r${published.length}`, href: "/x", changed: true };
      },
      restart: { supported: () => true, request: () => true },
      now: () => new Date(now.value),
      observeMs: 60_000,
      drainPollMs: 1,
      ...overrides
    },
    toolkit.openInstallations({ managedRoot, lock: true })
  );
  managers.push(manager);
  const install = async (file: string) => {
    const job = await manager.installFromFile({ body: fs.createReadStream(file), actor: "tester" });
    return (await manager.wait(job.jobId)) ?? job;
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(managedRoot, "installations.json"), "utf8")).extensions.demo;
  const versionDir = (version: string) => path.join(managedRoot, "installed", "demo", version);
  return { manager, managedRoot, published, now, install, record, versionDir };
}

describe("Extension Manager 蓝绿切换（隔离开启）", () => {
  it("子进程托管的含后端扩展升级：不需要重启，swap 到新版本目录，观察期从切换完成开始", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    // 首次安装时本进程已托管（模拟上次启动装配过）：也走 swap。
    expect((await h.install(backendPackage("1.0.0"))).outcome).toBe("installed");
    h.now.value += 5_000;
    const job = await h.install(backendPackage("1.1.0"));
    expect(job.status).toBe("succeeded");
    expect(job.outcome).toBe("installed");
    expect(iso.calls.at(-1)).toEqual({ extensionId: "demo", directory: h.versionDir("1.1.0") });
    const record = h.record();
    expect(record).toMatchObject({ current: "1.1.0", previous: "1.0.0", state: "observing", restartPending: false, observeAfterRestart: false });
    expect(Date.parse(record.observeUntil)).toBe(h.now.value + 60_000);
    expect(h.manager.installed()[0]!.restartRequired).toBe(false);
  });

  it("绿激活失败：MARKETPLACE_SWAP_FAILED，指针回到旧版本，蓝不被切走", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    await h.install(backendPackage("1.0.0"));
    iso.state.failNext = true;
    const job = await h.install(backendPackage("1.1.0"));
    expect(job.status).toBe("failed");
    expect(job.failure?.code).toBe("MARKETPLACE_SWAP_FAILED");
    expect(job.failure?.message).toContain("activation-timeout");
    expect(h.record()).toMatchObject({ current: "1.0.0", rejected: ["1.1.0"] });
    // 失败后没有再 swap 到别处：活跃实例仍是蓝（1.0.0）。
    expect(iso.active.get("demo")).toBe(h.versionDir("1.0.0"));
    expect(iso.calls.map((call) => path.basename(call.directory))).toEqual(["1.0.0", "1.1.0"]);
  });

  it("手动回滚也是一次 swap（到上一版本目录）；回滚的 swap 失败时指针恢复", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    await h.install(backendPackage("1.0.0"));
    await h.install(backendPackage("1.1.0"));
    const done = await h.manager.wait(h.manager.rollback("demo", { actor: "admin" }).jobId);
    expect(done?.status).toBe("succeeded");
    expect(done?.outcome).toBe("installed");
    expect(iso.calls.at(-1)).toEqual({ extensionId: "demo", directory: h.versionDir("1.0.0") });
    expect(h.record()).toMatchObject({ current: "1.0.0", previous: "1.1.0" });
    iso.state.failNext = true;
    const failed = await h.manager.wait(h.manager.rollback("demo", { actor: "admin" }).jobId);
    expect(failed?.failure?.code).toBe("MARKETPLACE_SWAP_FAILED");
    expect(h.record().current).toBe("1.0.0");
  });

  it("同版本同内容重装：already-current，不调 swap；swap 对同目录是 no-op", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    const file = backendPackage("1.0.0");
    await h.install(file);
    const callsBefore = iso.calls.length;
    expect((await h.install(file)).outcome).toBe("already-current");
    expect(iso.calls.length).toBe(callsBefore);
    await expect(iso.port.swap("demo", h.versionDir("1.0.0"))).resolves.toEqual({ swapped: false });
  });

  it("隔离关闭（无端口）：含后端扩展仍 restart-required，观察期推迟到重启后", async () => {
    const h = await harness();
    const job = await h.install(backendPackage("1.0.0"));
    expect(job.outcome).toBe("restart-required");
    expect(h.record()).toMatchObject({ restartPending: true, observeAfterRestart: true, observeUntil: null });
    expect(h.manager.installed()[0]!.restartRequired).toBe(true);
  });

  it("首次安装热装（8.4）：attach 成功即 installed，观察期从此刻开始；之后升级走 swap，卸载走 detach", async () => {
    const iso = attachingIsolation();
    const h = await harness({ isolation: iso.port });
    const job = await h.install(backendPackage("1.0.0"));
    expect(job.outcome).toBe("installed");
    expect(iso.attached.has("demo")).toBe(true);
    expect(iso.calls).toEqual([]);
    const record = h.record();
    expect(record).toMatchObject({ current: "1.0.0", state: "observing", restartPending: false });
    expect(Date.parse(record.observeUntil)).toBe(h.now.value + 60_000);
    expect(h.manager.installed()[0]!.restartRequired).toBe(false);
    await h.install(backendPackage("1.1.0"));
    expect(iso.calls.at(-1)).toEqual({ extensionId: "demo", directory: h.versionDir("1.1.0") });
    const done = await h.manager.wait(h.manager.uninstall("demo", { actor: "admin" }).jobId);
    expect(done?.status).toBe("succeeded");
    expect(iso.detached).toEqual(["demo"]);
  });

  it("首次安装热装失败：MARKETPLACE_SWAP_FAILED，安装记录被撤销", async () => {
    const iso = attachingIsolation({ attachFails: true });
    const h = await harness({ isolation: iso.port });
    const job = await h.install(backendPackage("1.0.0"));
    expect(job.failure?.code).toBe("MARKETPLACE_SWAP_FAILED");
    expect(job.failure?.message).toContain("activation-timeout");
    const state = JSON.parse(fs.readFileSync(path.join(h.managedRoot, "installations.json"), "utf8"));
    expect(state.extensions.demo).toBeUndefined();
  });

  it("隔离开启但本进程未托管且不支持运行期装配：restart-required，不调 swap", async () => {
    const iso = fakeIsolation([]);
    const h = await harness({ isolation: iso.port });
    expect((await h.install(backendPackage("1.0.0"))).outcome).toBe("restart-required");
    expect(iso.calls).toEqual([]);
  });

  it("观察期内崩溃：有上一版本 → 回滚（swap 到上一版本）返回 true；无上一版本 → false", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    await h.install(backendPackage("1.0.0"));
    expect(await h.manager.handleObservationCrash("demo")).toBe(false);
    await h.install(backendPackage("1.1.0"));
    expect(await h.manager.handleObservationCrash("demo")).toBe(true);
    expect(h.record()).toMatchObject({ current: "1.0.0", previous: "1.1.0", rejected: ["1.1.0"], state: "active" });
    expect(iso.active.get("demo")).toBe(h.versionDir("1.0.0"));
    // 回滚后不再处于观察期：再次崩溃交给 supervisor（返回 false）。
    expect(await h.manager.handleObservationCrash("demo")).toBe(false);
    expect(await h.manager.handleObservationCrash("unknown")).toBe(false);
  });

  it("卸载子进程托管的扩展：remove 子进程，不提示重启", async () => {
    const iso = fakeIsolation();
    const h = await harness({ isolation: iso.port });
    await h.install(backendPackage("1.0.0"));
    const done = await h.manager.wait(h.manager.uninstall("demo", { actor: "admin" }).jobId);
    expect(done?.status).toBe("succeeded");
    expect(iso.removed).toEqual(["demo"]);
    expect((h.manager as unknown as { restartPendingRemoved(): string[] }).restartPendingRemoved()).toEqual([]);
  });

  it("预检缺构建期描述（旧包）：任务失败码 MARKETPLACE_PACKAGE_INVALID", async () => {
    const h = await harness({ isolation: fakeIsolation().port });
    const job = await h.install(backendPackage("1.0.0", { schema: false }));
    expect(job.failure?.code).toBe("MARKETPLACE_PACKAGE_INVALID");
    expect(fs.existsSync(path.join(h.managedRoot, "installations.json"))).toBe(false);
  });
});