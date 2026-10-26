/**
 * 运行期浏览器发布目录单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 5.2 / 5.3 / design D4、D7）。
 *
 * 运行：`node --test scripts/lib/extension-release-catalog.test.mjs`
 *
 * 覆盖：同内容同 hash、缺 artifact 不登记、ABI/React 不符失败、文件 hash 不符失败、manifest
 * 非法失败、重复 identity 失败、目录端与不可变资源托管、未知路径与越界路径不接管。
 * 夹具直接复制真实扩展的已构建 `browser-dist`，保证走的是生产契约而不是简化替身。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ExtensionReleaseError,
  RELEASE_DISCOVERY_PATH,
  buildBrowserRelease,
  canonicalJson,
  createBrowserReleaseHandler,
  createBrowserReleasePublisher,
  sha256Hex,
  verifyArtifactFiles
} from "./extension-release-catalog.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contracts = await (await import("./extension-release-protocol.mjs")).loadExtensionContracts();
function writeValidBrowserArtifact(dir, extensionId, { sdkAbi = contracts.EXTENSION_SDK_ABI_VERSION, reactMajor = contracts.HOST_REACT_MAJOR } = {}) {
  const entryName = "entry.js";
  const bytes = Buffer.from("export default {};\n", "utf8");
  fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "browser-dist", entryName), bytes);
  const manifest = {
    schemaVersion: contracts.EXTENSION_BROWSER_PROTOCOL_VERSION,
    artifactId: sha256Hex(bytes),
    metadata: {
      extensionId,
      version: "1.0.0",
      label: `${extensionId} 标签`,
      description: `${extensionId} 描述`,
      activation: "server-active",
      configScope: "site",
      required: false,
      sdkAbi
    },
    protocolVersion: contracts.EXTENSION_BROWSER_PROTOCOL_VERSION,
    sdkAbi,
    reactMajor,
    entry: entryName,
    styles: [],
    requiredSdkGroups: ["core"],
    requiredSdkExports: ["defineExtensionPlugin"],
    imports: [],
    files: [{ path: entryName, bytes: bytes.length, gzipBytes: 0, sha256: sha256Hex(bytes), kind: "entry" }]
  };
  fs.writeFileSync(path.join(dir, "browser-dist", "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function makeArtifactDir() {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-catalog-"));
 writeValidBrowserArtifact(dir, "fixture");
 return dir;
}

function manifestPath(dir) {
  return path.join(dir, "browser-dist", "artifact-manifest.json");
}
function readManifest(dir) {
  return JSON.parse(fs.readFileSync(manifestPath(dir), "utf8"));
}
function writeManifest(dir, manifest) {
  fs.writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function artifactsOf(...dirs) {
  return dirs.map((dir, index) => ({ extensionId: `fixture-${index}`, directory: dir }));
}

/** 收集响应的替身（支持 pipeline 写入）。 */
function makeRes() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.statusCode = 0;
  res.headers = {};
  const end = res.end.bind(res);
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers ?? {}; };
  res.end = (body) => { if (body) chunks.push(Buffer.from(body)); return end(); };
  res.body = () => Buffer.concat(chunks).toString("utf8");
  return res;
}

function makeReq(url, method = "GET") {
  return { url, method, headers: {} };
}

function callHandler(handler, res, url, method = "GET") {
  return new Promise((resolve) => {
    const handled = handler(makeReq(url, method), res);
    if (!handled) {
      resolve(false);
      return;
    }
    res.on("finish", () => resolve(true));
    // sendJson 走同步 end；serveFile 走 pipeline，二者都会触发 finish。
    if (res.writableFinished) resolve(true);
  });
}

test("同内容同 hash：releaseId 与 catalog 确定性", async () => {
  const dir = makeArtifactDir();
  const first = await buildBrowserRelease({ artifacts: artifactsOf(dir) });
  const second = await buildBrowserRelease({ artifacts: artifactsOf(dir) });
  assert.equal(first.releaseId, second.releaseId);
  assert.equal(first.catalogJson, second.catalogJson);
  assert.match(first.releaseId, /^[0-9a-f]{64}$/);
  assert.equal(first.href, `/extension-releases/${first.releaseId}.json`);
  assert.equal(first.entries.length, 1);
  // releaseId 由 canonical catalog 决定，与文件系统位置无关。
  assert.equal(first.releaseId, sha256Hex(Buffer.from(canonicalJson({ ...first.catalog, releaseId: undefined }), "utf8")));
});

test("缺 artifact 的扩展不登记", async () => {
  const dir = makeArtifactDir();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "release-catalog-bare-"));
  const release = await buildBrowserRelease({ artifacts: artifactsOf(dir, bare) });
  assert.equal(release.entries.length, 1);
  assert.deepEqual(release.skipped.map((entry) => entry.reason), ["no-browser-artifact"]);
});

test("React major 不符：失败并指出扩展", async () => {
  const dir = makeArtifactDir();
  const manifest = readManifest(dir);
  writeManifest(dir, { ...manifest, reactMajor: 17 });
  await assert.rejects(
    () => buildBrowserRelease({ artifacts: artifactsOf(dir) }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_INCOMPATIBLE"
  );
});

test("artifact 文件内容被改：hash 不符失败", async () => {
  const dir = makeArtifactDir();
  const manifest = readManifest(dir);
  const target = path.join(dir, "browser-dist", manifest.entry);
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\n// tampered\n`);
  await assert.rejects(
    () => buildBrowserRelease({ artifacts: artifactsOf(dir) }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_FILE_MISMATCH"
  );
});

test("artifact manifest 非法：失败", async () => {
  const dir = makeArtifactDir();
  writeManifest(dir, { ...readManifest(dir), artifactId: "not-a-hash" });
  await assert.rejects(
    () => buildBrowserRelease({ artifacts: artifactsOf(dir) }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_INVALID"
  );
});

test("重复 extensionId：失败", async () => {
  const one = makeArtifactDir();
  const two = makeArtifactDir();
  await assert.rejects(
    () => buildBrowserRelease({ artifacts: artifactsOf(one, two) }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_DUPLICATE"
  );
});

test("verifyArtifactFiles 直接校验 entry/styles 归属", async () => {
  const dir = makeArtifactDir();
  const artifactDir = path.join(dir, "browser-dist");
  const manifest = readManifest(dir);
  await verifyArtifactFiles(artifactDir, manifest);
  await assert.rejects(
    () => verifyArtifactFiles(artifactDir, { ...manifest, entry: "missing.js" }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_INVALID"
  );
});

test("目录端与不可变资源托管：命中当前 release，未知与越界路径不接管", async () => {
  const dir = makeArtifactDir();
  const release = await buildBrowserRelease({ artifacts: artifactsOf(dir) });
  const handler = createBrowserReleaseHandler(release);

  const discoveryRes = makeRes();
  assert.equal(await callHandler(handler, discoveryRes, RELEASE_DISCOVERY_PATH), true);
  assert.deepEqual(JSON.parse(discoveryRes.body()), { releaseId: release.releaseId, href: release.href });

  const catalogRes = makeRes();
  assert.equal(await callHandler(handler, catalogRes, release.href), true);
  assert.equal(catalogRes.statusCode, 200);
  assert.match(catalogRes.headers["cache-control"], /immutable/);
  assert.equal(catalogRes.body(), release.catalogJson);

  const [entryPath] = release.files.keys();
  const entryRes = makeRes();
  assert.equal(await callHandler(handler, entryRes, entryPath), true);
  assert.equal(entryRes.statusCode, 200);
  assert.match(entryRes.headers["cache-control"], /immutable/);
  assert.equal(entryRes.body(), fs.readFileSync(release.files.get(entryPath), "utf8"));

  // 别的 64-hex releaseId（旧 release）与未知资源交给下游（保留窗口目录回退）。
  const otherRes = makeRes();
  const otherId = release.releaseId.replace(/.$/, release.releaseId.endsWith("0") ? "1" : "0");
  assert.equal(await callHandler(handler, otherRes, `/extension-releases/${otherId}.json`), false);

  const traversalRes = makeRes();
  assert.equal(await callHandler(handler, traversalRes, "/extensions/../../etc/passwd"), false);
  const notFoundRes = makeRes();
  assert.equal(await callHandler(handler, notFoundRes, "/extensions/unknown/deadbeef/entry.js"), false);

  // 非 GET/HEAD 不接管。
  const postRes = makeRes();
  assert.equal(await callHandler(handler, postRes, release.href, "POST"), false);
});

test("真实仓库：releaseId 与已装配发布目录逐字节一致", async (t) => {
  const assembledDir = path.join(REPO_ROOT, "web", "frontend", "dist", "extension-releases");
  if (!fs.existsSync(assembledDir)) {
    t.skip("未找到已装配发布目录（web/frontend/dist）；跳过对照");
    return;
  }
  const { loadExtensionHost } = await import("./extension-host.mjs");
  const host = await loadExtensionHost({ repoRoot: REPO_ROOT, env: {} });
  const release = await buildBrowserRelease({ artifacts: host.browserArtifacts });
  const catalogPath = path.join(assembledDir, `${release.releaseId}.json`);
  if (!fs.existsSync(catalogPath)) { t.skip("当前扩展尚未装配发布目录"); return; }
  const assembled = fs.readFileSync(catalogPath, "utf8");
  assert.equal(release.catalogJson, assembled);
});

// ── 运行期发布器（change: 2026-10-21-add-extension-marketplace-point，任务 6.1 / design D8）──

/** 复制一份夹具 artifact，并把 metadata.extensionId 改成指定 id（artifactId 随之重算）。 */
function makeNamedArtifactDir(extensionId, { tweak = "" } = {}) {
  const dir = makeArtifactDir();
  const manifest = readManifest(dir);
  const metadata = { ...manifest.metadata, extensionId };
  let entryBytes = fs.readFileSync(path.join(dir, "browser-dist", manifest.entry));
  if (tweak) {
    entryBytes = Buffer.concat([entryBytes, Buffer.from(`\n// ${tweak}\n`)]);
    fs.writeFileSync(path.join(dir, "browser-dist", manifest.entry), entryBytes);
  }
  const files = manifest.files.map((file) =>
    file.path === manifest.entry ? { ...file, bytes: entryBytes.length, sha256: sha256Hex(entryBytes) } : file
  );
  const artifactId = sha256Hex(Buffer.from(`${extensionId}:${tweak}:${manifest.artifactId}`));
  writeManifest(dir, { ...manifest, metadata, files, artifactId });
  return dir;
}

async function getBody(handler, url) {
  const res = makeRes();
  const handled = await callHandler(handler, res, url);
  return handled ? res.body() : null;
}

test("发布器：新增条目后切换指针，旧 release 与旧文件继续可读", async () => {
  const base = makeNamedArtifactDir("alpha");
  const initial = await buildBrowserRelease({ artifacts: [{ extensionId: "alpha", directory: base }] });
  const publisher = createBrowserReleasePublisher({ release: initial, artifacts: [{ extensionId: "alpha", directory: base }] });
  const seen = [];
  publisher.subscribe((change) => seen.push(change));
  const handler = (req, res) => publisher.handler(req, res);

  const added = makeNamedArtifactDir("beta");
  const result = await publisher.publish({ upsert: [{ extensionId: "beta", directory: added }] });
  assert.equal(result.changed, true);
  assert.notEqual(result.releaseId, initial.releaseId);
  assert.deepEqual(seen, [{ releaseId: result.releaseId, href: result.href }]);
  assert.deepEqual(JSON.parse(await getBody(handler, RELEASE_DISCOVERY_PATH)), { releaseId: result.releaseId, href: result.href });

  // 新 release 是旧 release 的超集：旧条目的 artifactId 不变。
  const next = JSON.parse(await getBody(handler, result.href));
  const old = JSON.parse(await getBody(handler, initial.href));
  assert.deepEqual(next.entries.map((entry) => entry.metadata.extensionId), ["alpha", "beta"]);
  assert.equal(next.entries[0].artifactId, old.entries[0].artifactId);
  // 旧 release 的资源仍可读。
  for (const url of initial.files.keys()) assert.notEqual(await getBody(handler, url), null);
  for (const url of publisher.current().files.keys()) assert.notEqual(await getBody(handler, url), null);
});

test("发布器：升级替换条目，旧 artifact 保留；移除条目；同内容重放幂等", async () => {
  const v1 = makeNamedArtifactDir("alpha");
  const initial = await buildBrowserRelease({ artifacts: [{ extensionId: "alpha", directory: v1 }] });
  const publisher = createBrowserReleasePublisher({ release: initial, artifacts: [{ extensionId: "alpha", directory: v1 }] });
  const handler = (req, res) => publisher.handler(req, res);
  const v2 = makeNamedArtifactDir("alpha", { tweak: "v2" });
  const upgraded = await publisher.publish({ upsert: [{ extensionId: "alpha", directory: v2 }] });
  assert.equal(upgraded.changed, true);
  const catalog = JSON.parse(await getBody(handler, upgraded.href));
  assert.notEqual(catalog.entries[0].artifactId, initial.entries[0].artifactId);
  for (const url of initial.files.keys()) assert.notEqual(await getBody(handler, url), null, `旧 artifact 仍可读：${url}`);

  const replay = await publisher.publish({ upsert: [{ extensionId: "alpha", directory: v2 }] });
  assert.equal(replay.changed, false);
  assert.equal(replay.releaseId, upgraded.releaseId);

  const removed = await publisher.publish({ remove: ["alpha"] });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(await getBody(handler, removed.href)).entries, []);
  assert.notEqual(await getBody(handler, upgraded.href), null);
});

test("发布器：新条目校验失败不切换，当前 release 与输入集合不变", async () => {
  const base = makeNamedArtifactDir("alpha");
  const initial = await buildBrowserRelease({ artifacts: [{ extensionId: "alpha", directory: base }] });
  const publisher = createBrowserReleasePublisher({ release: initial, artifacts: [{ extensionId: "alpha", directory: base }] });
  const seen = [];
  publisher.subscribe((change) => seen.push(change));
  const broken = makeNamedArtifactDir("beta");
  const manifest = readManifest(broken);
  fs.appendFileSync(path.join(broken, "browser-dist", manifest.entry), "// tampered\n");
  await assert.rejects(
    () => publisher.publish({ upsert: [{ extensionId: "beta", directory: broken }] }),
    (error) => error instanceof ExtensionReleaseError && error.code === "EXTENSION_ARTIFACT_FILE_MISMATCH"
  );
  assert.equal(publisher.current().releaseId, initial.releaseId);
  assert.deepEqual(seen, []);
  // 失败后的下一次发布不带上坏条目。
  const ok = await publisher.publish({ upsert: [] });
  assert.equal(ok.changed, false);
  await assert.rejects(() => publisher.publish({ upsert: [{ extensionId: "x" }] }), (error) => error.code === "EXTENSION_RELEASE_INPUT_INVALID");
});
