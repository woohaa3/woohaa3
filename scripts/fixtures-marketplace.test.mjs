/**
 * 市场 fixture 自检（change: 2026-10-21-isolate-extension-host-process，任务 10.1）。
 *
 * 每个含后端 fixture：build:backend 产出自包含 entry.mjs 与合法 config-schema.json，受管预检通过；
 * 在**独立 node 子进程**里装上出网守卫后加载插件，验证 fixture 的行为符合端到端的预期
 * （echo 真实走 doGenerate 与 jobs；crashy 的 exit 让进程退出；greedy 的越权探针被拒）。
 * 不启动宿主；完整宿主 + HTTP 的端到端在 web/backend/tests/extension-host-e2e.test.ts。
 *
 * 运行：`node --test scripts/fixtures-marketplace.test.mjs`
 * 导出 `packFixture` 供端到端复用（在临时副本里改版本再打包，不动仓库文件）。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packExtension } from "./pack-extension.mjs";
import { preflightDirectory } from "./extensions-preflight.mjs";
import { unpackExtensionPackage } from "./lib/extension-package.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const MARKETPLACE_FIXTURES = path.join(HERE, "fixtures", "marketplace");
const GUARD = path.join(REPO_ROOT, "web", "backend", "src", "extension-host", "child", "network-guard.ts");

/**
 * 打包一个 fixture。`version` 给出时在临时副本里同步改 extension.json / package.json / shared.ts 的版本。
 * 返回 packExtension 的结果（含 outFile、packageDigest、keyId）。
 */
export async function packFixture(name, { version, privateKey = null, outDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-fixture-")) } = {}) {
  const work = path.join(outDir, `${name}-src`);
  fs.cpSync(path.join(MARKETPLACE_FIXTURES, name), work, { recursive: true });
  if (version) {
    for (const file of ["extension.json", "package.json"]) {
      const json = JSON.parse(fs.readFileSync(path.join(work, file), "utf8"));
      json.version = version;
      fs.writeFileSync(path.join(work, file), JSON.stringify(json, null, 2));
    }
    const shared = path.join(work, "src", "shared.ts");
    if (fs.existsSync(shared)) fs.writeFileSync(shared, fs.readFileSync(shared, "utf8").replace(/version: "[^"]+"/, `version: "${version}"`));
  }
  const id = JSON.parse(fs.readFileSync(path.join(work, "extension.json"), "utf8")).extensionId;
  return packExtension({ dir: work, out: path.join(outDir, `${id}-${version ?? "1.0.0"}.wxt`), privateKey, repoRoot: REPO_ROOT });
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-fixtures-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 打包并解包到临时目录，返回解包树。 */
async function unpacked(t, name, options = {}) {
  const work = tmp(t);
  const packed = await packFixture(name, { ...options, outDir: work });
  const tree = path.join(work, "tree");
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: tree });
  return { packed, tree };
}

/** 在子进程脚本里调用 fixture 自己登记的路由处理器（模拟宿主转发），返回 { status, body }。 */
const CALL_ROUTE = `
const callRoute = async (method, url) => {
  for (const handler of routes) {
    let status = 0; let body = "";
    const handled = await handler({ method, url }, { writeHead: (s) => { status = s; }, end: (b) => { body = b; } });
    if (handled) return { status, body: body ? JSON.parse(body) : null };
  }
  return { status: 404, body: null };
};`;

/**
 * 在独立 node 子进程里：装出网守卫（allowedHosts = permissions.network，lockdown）→ 加载 entry → 用最小 ctx 调 apply →
 * 执行 `script`（拿到 { plugin, regs, routes, ctx, mod }）→ stdout 输出 JSON。用 --experimental-strip-types 直接加载守卫源码。
 */
function runInChild(tree, script, { ctxExtras = "{}" } = {}) {
  const descriptor = JSON.parse(fs.readFileSync(path.join(tree, "extension.json"), "utf8"));
  const entry = pathToFileURL(path.join(tree, "backend-dist", "entry.mjs")).href;
  const source = `
const { installNetworkGuard } = await import(${JSON.stringify(pathToFileURL(GUARD).href)});
installNetworkGuard({ allowedHosts: ${JSON.stringify(descriptor.permissions?.network ?? [])}, lockdown: true });
const mod = await import(${JSON.stringify(entry)});
const regs = []; const routes = [];
const ctx = Object.assign({
  log: { scope: () => () => undefined },
  generation: { register: (r) => (regs.push(r), () => undefined) },
  gateway: { route: (order, handler, declaration) => { if (declaration?.prefix && !declaration.prefix.startsWith("/api/extensions/${descriptor.extensionId}/")) throw Object.assign(new Error("越权路由"), { code: "permission-denied" }); routes.push(handler); return () => undefined; } },
  get: () => undefined,
  effect: (fn) => fn()
}, ${ctxExtras});
const plugin = mod[${JSON.stringify(descriptor.hostPlugin.factory)}]();
await plugin.apply(ctx, Object.fromEntries(Object.entries(plugin.Config.fields).map(([k, f]) => [k, f.default])));
${CALL_ROUTE}
const result = await (async () => { ${script} })();
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], {
    cwd: path.join(REPO_ROOT, "web", "backend"),
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }
  });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, json: run.status === 0 && run.stdout ? JSON.parse(run.stdout) : null };
}

for (const name of ["fixture-echo-provider", "fixture-crashy", "fixture-greedy"]) {
  test(`${name}：build:backend 产出 config-schema.json，受管预检通过，包内无 src/`, async (t) => {
    const { packed, tree } = await unpacked(t, name);
    assert.equal(packed.requiresRestart, true);
    assert.ok(fs.existsSync(path.join(tree, "backend-dist", "config-schema.json")));
    assert.ok(!fs.existsSync(path.join(tree, "src")));
    const preflight = await preflightDirectory(tree, { managed: true });
    assert.equal(preflight.ok, true, JSON.stringify(preflight.errors));
    // 产物只 import node: 内置模块。
    const entry = fs.readFileSync(path.join(tree, "backend-dist", "entry.mjs"), "utf8");
    for (const match of entry.matchAll(/^import .* from "([^"]+)";$/gm)) assert.match(match[1], /^node:/);
  });
}

test("fixture-echo-provider：在守卫子进程里真实走 doGenerate 与 jobs，结果带子进程 pid", async (t) => {
  const { tree } = await unpacked(t, "fixture-echo-provider");
  const run = runInChild(tree, `
    const provider = regs[0].provider;
    const text = await provider.languageModel("echo-text").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    const handle = await provider.jobs.start({ model: provider.imageModel("echo-image"), input: { prompt: "x", n: 1 } });
    const image = await handle.wait({});
    const record = await provider.jobs.status(handle.id);
    return { text: text.content[0].text, pid: text.providerMetadata["fixture-echo"].pid, self: process.pid, imageBytes: image.images[0].length, state: record.state, models: regs[0].models.map((m) => m.providerModelId) };
  `);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.text, "echo: hello");
  assert.equal(run.json.pid, run.json.self);
  assert.notEqual(run.json.pid, process.pid);
  assert.ok(run.json.imageBytes > 0);
  assert.equal(run.json.state, "succeeded");
  assert.deepEqual(run.json.models, ["echo-text", "echo-image"]);
});

test("fixture-echo-provider：可以升级到新版本（临时副本改版本），config-schema 与包摘要随之变化", async (t) => {
  const work = tmp(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  const v1 = await packFixture("fixture-echo-provider", { outDir: work, privateKey });
  const v2 = await packFixture("fixture-echo-provider", { outDir: work, privateKey, version: "1.1.0" });
  assert.equal(v2.version, "1.1.0");
  assert.notEqual(v1.packageDigest, v2.packageDigest);
  assert.equal(v1.keyId, v2.keyId);
});

test("fixture-crashy：exit 模式让子进程以 42 退出；ping 正常", async (t) => {
  const { tree } = await unpacked(t, "fixture-crashy");
  const ping = runInChild(tree, "return (await callRoute('POST', '/api/extensions/fixture-crashy/ping')).body;");
  assert.equal(ping.status, 0, ping.stderr);
  assert.equal(ping.json.ok, true);
  const exit = runInChild(tree, "await callRoute('POST', '/api/extensions/fixture-crashy/exit'); return null;");
  assert.equal(exit.status, 42);
  // 生成调用里的退出：在途调用随进程消失（宿主侧以 extension-crashed 收尾）。
  const inFlight = runInChild(tree, "await regs[0].provider.languageModel('crash-exit').doGenerate({ prompt: [] }); return null;");
  assert.equal(inFlight.status, 42);
  // 未知模式交给下游（不处理）。
  const unknown = runInChild(tree, "return (await callRoute('POST', '/api/extensions/fixture-crashy/nope')).status;");
  assert.equal(unknown.json, 404);
  const models = runInChild(tree, "return regs[0].models.map((m) => m.providerModelId);");
  assert.deepEqual(models.json, ["crash-ok", "crash-exit", "crash-hang"]);
});

test("fixture-greedy：越权出网 / 派生进程 / 越权路由 / 未授予服务都被拒绝，自己声明的仍可用", async (t) => {
  const { tree } = await unpacked(t, "fixture-greedy");
  const run = runInChild(
    tree,
    "const { body } = await callRoute('GET', '/api/extensions/fixture-greedy/probes'); return { pid: body.pid, probes: Object.fromEntries(body.probes.map((p) => [p.name, p])) };",
    { ctxExtras: `{ storage: { bucket: (ns) => { if (ns !== "greedy-cache") throw Object.assign(new Error("未授予命名空间"), { code: "permission-denied" }); return {}; } } }` }
  );
  assert.equal(run.status, 0, run.stderr);
  const probes = run.json.probes;
  for (const name of ["fetch-denied", "fetch-private", "net-denied"]) assert.equal(probes[name].code, "EXTENSION_NETWORK_DENIED", name);
  assert.equal(probes.spawn.code, "permission-denied");
  assert.equal(probes["route-outside"].code, "permission-denied");
  assert.equal(probes["storage-other"].code, "permission-denied");
  assert.equal(probes["storage-own"].ok, true);
  assert.equal(probes.canvas.detail, "undefined");
  assert.equal(probes.marketplace.detail, "undefined");
  assert.equal(probes.env.detail, "none");
});
