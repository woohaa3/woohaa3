import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
  for(const value of ["0","false","yes"])assert.throws(()=>resolveDesktopTrustConfig({env:{WOOHAA_DESKTOP_TRUST_UNAMANAGED:value},build:"release"}),/信任根/);
  // 回归：rotateRoot 需要 now，缺省时任何有效根都会被判 invalid-integer。
  fs.writeFileSync(missingFile, JSON.stringify({ schemaVersion: 2, domains: [{ root: f.root, floors: f.floors, extensionIds: ["photocraft"] }] }));
  const config = resolveDesktopTrustConfig({ env: { WOOHAA3_EXTENSION_TRUST_CONFIG: missingFile }, build: "release" });
  assert.equal(config.domains.length, 1);
});

test("explicit release profile allows v1 without a CI shell, while configured roots and environment remain authoritative", t => {
  assert.equal(resolveDesktopTrustConfig({ env: {}, build: "release", allowUnmanaged: true }), null);
  for (const value of ["0", "false", "yes", " 1 "]) {
    assert.throws(() => resolveDesktopTrustConfig({ env: { WOOHAA_DESKTOP_TRUST_UNAMANAGED: value }, build: "release", allowUnmanaged: true }), /当前 WOOHAA_DESKTOP_TRUST_UNAMANAGED=/);
  }
  const dir = temp("profile-anchor-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trust.json");
  const f = fixture(Math.floor(Date.now() / 1000));
  const config = { schemaVersion: 2, domains: [{ root: f.root, floors: f.floors, extensionIds: ["photocraft"] }] };
  fs.writeFileSync(file, JSON.stringify(config));
  const args = { env: { WOOHAA3_EXTENSION_TRUST_CONFIG: file, WOOHAA_DESKTOP_TRUST_UNAMANAGED: "1" }, build: "release", allowUnmanaged: true };
  assert.equal(JSON.stringify(resolveDesktopTrustConfig(args)), JSON.stringify(config));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, domains: [] }));
  assert.throws(() => resolveDesktopTrustConfig(args), /invalid-trust-config/);
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

test("legacy v1 activation requires original archive evidence and an exact signed grant", async t => {
 const f=fixture(Math.floor(Date.now()/1000));const dir=temp("legacy-evidence-");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const src=path.join(dir,"src");fs.mkdirSync(src);fs.writeFileSync(path.join(src,"extension.json"),JSON.stringify({extensionId:"photocraft",version:"1.0.0"}));
 const archive=path.join(dir,"v1.wxt"),treeDir=path.join(dir,"tree");
 packDirectory({treeDir:src,outFile:archive,privateKey:f.keys.publisher.privateKey});unpackExtensionPackage({packagePath:archive,destDir:treeDir});
 const packageDigest="sha256:"+createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
 const record={current:"1.0.0",packageDigest,filesDigest:filesDigest(treeDir),trust:"signed:old-key"};
 const grant={extensionId:"photocraft",version:"1.0.0",archiveDigest:packageDigest.slice(7),filesDigest:record.filesDigest.slice(7),publicKey:f.keys.publisher.publicKey,publisherId:"test-publisher",expiresAt:f.now+600};
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{root:f.root,floors:f.floors,extensionIds:["photocraft"],bootstrap:{bundle:f.bundle({...f.targets,legacy:[grant]}),rootUpdates:[]}}]}));
 const runtime=runtimeTrust({managedRoot:path.join(dir,"managed"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:config}});
 // 没有任何证据的记录：本层不作判断（返回 null），管理器沿用原 v1 结论，不再误隔离。
 assert.equal(await runtime.installed(treeDir,{current:"1.0.0"}),null);
 // 必须新鲜授权的路径仍然拒绝。
 await assert.rejects(runtime.installed(treeDir,{current:"1.0.0"},{fresh:true}),/missing-trust-evidence/);
 // 有证据但目录内容对不上：拒绝。
 await assert.rejects(runtime.installed(treeDir,{...record,filesDigest:"sha256:"+"0".repeat(64)}),/installed-content-changed/);
 // 缺归档证据时不能借 legacy 迁移通过。
 await assert.rejects(runtime.installed(treeDir,{...record,packageDigest:undefined}),/legacy-package-not-authorized/);
 const result=await runtime.installed(treeDir,record);assert.equal(result.evidence.legacy,true);
 assert.equal((await runtime.installed(treeDir,record)).trust,result.trust);
});

test("an evidence-free record cannot vouch for a certified tree", async t => {
 const f=fixture(Math.floor(Date.now()/1000));const dir=temp("evidence-free-certified-");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{root:f.root,floors:f.floors,extensionIds:["photocraft"],bootstrap:{bundle:f.bundle(),rootUpdates:[]}}]}));
 const runtime=runtimeTrust({managedRoot:path.join(dir,"managed"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:config}});
 const {treeDir}=certifiedTree(dir,f);
 await assert.rejects(runtime.installed(treeDir,{current:"1.0.0"}),/missing-trust-evidence/);
});

test("certified activation fails closed on lost receipts; explicit reinstall restores evidence", async t => {
 const f=fixture(Math.floor(Date.now()/1000));const dir=temp("lost-receipt-");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{root:f.root,floors:f.floors,extensionIds:["photocraft"],bootstrap:{bundle:f.bundle(),rootUpdates:[]}}]}));
 const runtime=runtimeTrust({managedRoot:path.join(dir,"managed"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:config}});
 const {treeDir,archive}=certifiedTree(dir,f);const packageDigest="sha256:"+createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
 const installed=await runtime.install({treeDir,packageDigest});const record={...installed,packageDigest,filesDigest:filesDigest(treeDir)};
 fs.rmSync(path.join(dir,"managed/trust-receipts"),{recursive:true,force:true});
 await assert.rejects(runtime.installed(treeDir,record),/missing-trust-receipt/);
 await runtime.install({treeDir,packageDigest});assert.equal((await runtime.installed(treeDir,record)).trust,installed.trust);
 fs.writeFileSync(path.join(treeDir,"index.js"),"tampered");await assert.rejects(runtime.installed(treeDir,record));
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
