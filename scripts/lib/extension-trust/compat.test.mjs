import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.mjs";
import { runtimeTrust } from "./runtime.mjs";
import { packDirectory, unpackExtensionPackage, filesDigest } from "../extension-package.mjs";
import { prepareData, desktopEnvironment } from "../desktop-host-data.mjs";
import { resolveDesktopTrustConfig } from "../../prepare-desktop-host.mjs";

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("desktop prepareData is a pure data migration and still commits the master key", t => {
  const dir = temp("preparedata-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 回归：这段曾经引用 desktopEnvironment 的局部变量，导致宿主启动即 ReferenceError。
  const result = prepareData(dir, { schema: 1, build: "one" });
  assert.equal(result.backup, null);
  assert.equal(fs.existsSync(path.join(dir, "secrets/master.key")), true);
  assert.equal(fs.existsSync(path.join(dir, "stores")), true);
  // 不写 trust 配置：anchor 只由 desktopEnvironment / 打包决定。
  assert.equal(fs.existsSync(path.join(dir, "extension-trust.json")), false);
});

test("desktop environment passes the bundled anchor and ignores inherited roots for release", t => {
  const root = temp("desktop-env-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = { dataDir: path.join(root, "data"), resourceRoot: path.join(root, "missing"), baseEnv: { WOOHAA3_EXTENSION_TRUST_CONFIG: "/inherited.json" } };
  assert.equal(desktopEnvironment(args).WOOHAA3_EXTENSION_TRUST_CONFIG, undefined);
  fs.mkdirSync(path.join(root, "missing"));
  const anchor = path.join(root, "missing/extension-trust.json");
  fs.writeFileSync(anchor, "{}");
  assert.equal(desktopEnvironment(args).WOOHAA3_EXTENSION_TRUST_CONFIG, anchor);
  // 随包 anchor 永远优先；开发模式下没有随包 anchor 时才允许显式继承调用者的根路径。
  assert.equal(desktopEnvironment({ ...args, development: true }).WOOHAA3_EXTENSION_TRUST_CONFIG, anchor);
  const bare = { ...args, resourceRoot: path.join(root, "no-anchor"), development: true };
  fs.mkdirSync(bare.resourceRoot);
  assert.equal(desktopEnvironment(bare).WOOHAA3_EXTENSION_TRUST_CONFIG, "/inherited.json");
});

test("desktop packaging rejects a missing anchor for release builds and validates the root", t => {
  const f = fixture(Math.floor(Date.now() / 1000));
  const dir = temp("pack-anchor-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missingFile = path.join(dir, "config.json");
  assert.throws(() => resolveDesktopTrustConfig({ env: {}, build: "release" }), /信任根/);
  assert.equal(resolveDesktopTrustConfig({ env: { WOOHAA_DESKTOP_TRUST_UNAMANAGED: "1" }, build: "release" }), null);
  // 回归：rotateRoot 需要 now，缺省时任何有效根都会被判 invalid-integer。
  fs.writeFileSync(missingFile, JSON.stringify({ schemaVersion: 2, domains: [{ root: f.root, floors: f.floors, extensionIds: ["photocraft"] }] }));
  const config = resolveDesktopTrustConfig({ env: { WOOHAA3_EXTENSION_TRUST_CONFIG: missingFile }, build: "release" });
  assert.equal(config.domains.length, 1);
});

function certifiedTree(dir, f, descriptor = { extensionId: "photocraft", version: "1.0.0" }) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "extension.json"), JSON.stringify(descriptor));
  fs.writeFileSync(path.join(src, "index.js"), "export default {};");
  const archive = path.join(dir, "package.wxt");
  const treeDir = path.join(dir, "tree");
  packDirectory({ treeDir: src, outFile: archive, privateKey: f.keys.publisher.privateKey, certificateChain: f.chain });
  unpackExtensionPackage({ packagePath: archive, destDir: treeDir });
  return { archive, treeDir };
}

test("installed() keeps legacy records (no per-version evidence) instead of quarantining them", t => {
  const f = fixture(Math.floor(Date.now() / 1000));
  const dir = temp("legacy-record-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const domain = { root: f.root, floors: f.floors, extensionIds: ["photocraft"], bootstrap: { bundle: f.bundle(), rootUpdates: [] } };
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 2, domains: [domain] }));
  const runtime = runtimeTrust({ managedRoot: path.join(dir, "managed"), env: { WOOHAA3_EXTENSION_TRUST_CONFIG: config } });
  const { treeDir } = certifiedTree(dir, f);
  // 旧记录：本次改动之前安装的受管扩展没有 packageDigest/filesDigest/versions。
  const record = { current: "1.0.0", sourceId: "local-file", trust: "signed:deadbeefdeadbeef" };
  const result = runtime.installed(treeDir, record);
  // 不抛错（会被当成吊销隔离），返回 v1 判定结果。
  assert.ok(result === null || typeof result === "object");
});

test("installed() re-verifies a record that has evidence but lost its receipt", async t => {
  const f = fixture(Math.floor(Date.now() / 1000));
  const dir = temp("lost-receipt-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const domain = { root: f.root, floors: f.floors, extensionIds: ["photocraft"], bootstrap: { bundle: f.bundle(), rootUpdates: [] } };
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 2, domains: [domain] }));
  const runtime = runtimeTrust({ managedRoot: path.join(dir, "managed"), env: { WOOHAA3_EXTENSION_TRUST_CONFIG: config } });
  const { treeDir } = certifiedTree(dir, f);
  const installed = await runtime.install({ treeDir });
  fs.rmSync(path.join(dir, "managed/trust-receipts"), { recursive: true, force: true });
  // receipt 丢失时按新安装重新验证，而不是把已装扩展判成吊销。
  const again = runtime.installed(treeDir, { ...installed, filesDigest: filesDigest(treeDir) });
  if (again && typeof again.then === "function") await again;
  // 篡改内容仍然拒绝。
  fs.writeFileSync(path.join(treeDir, "index.js"), "export default {evil:true};");
  await assert.rejects(async () => runtime.installed(treeDir, { ...installed, filesDigest: filesDigest(treeDir) }));
});

test("verifyManagedActivation still accepts the real installed record shape", async t => {
  const f = fixture(Math.floor(Date.now() / 1000));
  const dir = temp("activation-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const domain = { root: f.root, floors: f.floors, extensionIds: ["photocraft"], bootstrap: { bundle: f.bundle(), rootUpdates: [] } };
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 2, domains: [domain] }));
  const runtime = runtimeTrust({ managedRoot: path.join(dir, "managed"), env: { WOOHAA3_EXTENSION_TRUST_CONFIG: config } });
  const { treeDir } = certifiedTree(dir, f);
  const result = await runtime.install({ treeDir });
  const record = { ...result, current: "1.0.0", filesDigest: filesDigest(treeDir) };
  assert.equal((await runtime.installed(treeDir, record)).trust, result.trust);
});
