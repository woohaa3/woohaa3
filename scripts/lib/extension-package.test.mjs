/**
 * .wxt 包单测（change: 2026-10-21-add-extension-marketplace-point，任务 3.3）。
 *
 * 覆盖：打包可复现、签名与信任根、篡改/多余/缺失文件、未签名开关，以及恶意包（路径穿越、绝对路径、
 * 符号链接、硬链接、设备文件、重复条目、条目数与解压总量上限、非 gzip、gzip 炸弹）都在暂存目录外不落文件。
 *
 * 运行：`node --test scripts/lib/extension-package.test.mjs`
 */
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  FILES_MANIFEST_NAME,
  SIGNATURE_NAME,
  buildFilesManifest,
  canonicalJson,
  computePackageDigest,
  createTarGz,
  filesDigest,
  keyIdOf,
  packDirectory,
  unpackExtensionPackage,
  unsafePathReason,
  verifyExtensionPackage
} from "./extension-package.mjs";

function tmp(t, prefix = "woohaa-wxt-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }), publicRaw: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"), keyId: keyIdOf(publicKey) };
}

function writeTree(dir, files = { "extension.json": '{"schemaVersion":1}\n', "package.json": '{"name":"@woohaa3/extension-x"}\n', "browser-dist/entry.js": "export {};\n" }) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return dir;
}

/** 手写一个 ustar 条目（不走 createTarGz，用来构造恶意包）。 */
function rawEntry({ name, type = "0", body = Buffer.alloc(0), linkname = "" }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, pad]);
}

function rawPackage(dir, entries) {
  const file = path.join(dir, "evil.wxt");
  fs.writeFileSync(file, gzipSync(Buffer.concat([...entries.map(rawEntry), Buffer.alloc(1024, 0)])));
  return file;
}

function assertUnsafe(t, packagePath, pattern, options = {}) {
  const work = tmp(t);
  const destDir = path.join(work, "staging", "tree");
  const before = fs.readdirSync(work);
  assert.throws(
    () => unpackExtensionPackage({ packagePath, destDir, ...options }),
    (error) => (error.code === "MARKETPLACE_ARCHIVE_UNSAFE" || error.code === options.code) && (!pattern || pattern.test(error.message))
  );
  // 暂存目录被删除，暂存区之外没有新文件。
  assert.equal(fs.existsSync(destDir), false);
  assert.deepEqual(fs.readdirSync(work), before);
}

test("unsafePathReason：拒绝绝对路径、..、反斜杠、空段", () => {
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "C:/x", ".", ""]) assert.notEqual(unsafePathReason(bad), null, bad);
  for (const good of ["a", "browser-dist/entry.js", "assets/icon.png"]) assert.equal(unsafePathReason(good), null, good);
});

test("打包 → 解包 → 校验：签名可信、文件一致、摘要可复现", (t) => {
  const dir = tmp(t);
  const tree = writeTree(path.join(dir, "tree"));
  const keys = keyPair();
  const first = packDirectory({ treeDir: tree, outFile: path.join(dir, "a.wxt"), privateKey: keys.privateKey });
  const second = packDirectory({ treeDir: tree, outFile: path.join(dir, "b.wxt"), privateKey: keys.privateKey });
  assert.equal(first.packageDigest, second.packageDigest, "同输入同字节（mtime=0、条目排序）");
  assert.equal(first.signature.keyId, keys.keyId);
  const unpacked = unpackExtensionPackage({ packagePath: first.outFile, destDir: path.join(dir, "out") });
  assert.deepEqual(unpacked.descriptor, { schemaVersion: 1 });
  assert.equal(unpacked.packageJson.name, "@woohaa3/extension-x");
  assert.ok(unpacked.files.some((file) => file.path === FILES_MANIFEST_NAME));
  const verified = verifyExtensionPackage({ treeDir: path.join(dir, "out"), trustedKeys: [{ publicKey: keys.publicPem }] });
  assert.equal(verified.trust, `signed:${keys.keyId}`);
  assert.equal(verifyExtensionPackage({ treeDir: path.join(dir, "out"), trustedKeys: [{ publicKey: keys.publicRaw }] }).keyId, keys.keyId);
  // 信任根以 <别名>=<公钥> 配置：按公钥指纹匹配包内 keyId，trust 显示别名。
  assert.equal(verifyExtensionPackage({ treeDir: path.join(dir, "out"), trustedKeys: [{ keyId: "corp", publicKey: keys.publicRaw }] }).trust, "signed:corp");
  // base64 的 SPKI DER（PEM 去掉头尾行）也接受。
  const spkiBase64 = String(keys.publicPem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  assert.equal(verifyExtensionPackage({ treeDir: path.join(dir, "out"), trustedKeys: [{ publicKey: spkiBase64 }] }).keyId, keys.keyId);
  assert.equal(filesDigest(path.join(dir, "out")), filesDigest(path.join(dir, "out")));
});

test("computePackageDigest 与 packDirectory 一致，格式为 sha256:<hex>", async (t) => {
  const dir = tmp(t);
  const packed = packDirectory({ treeDir: writeTree(path.join(dir, "tree")), outFile: path.join(dir, "a.wxt") });
  assert.match(packed.packageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await computePackageDigest(packed.outFile), packed.packageDigest);
});

test("签名公钥不在信任根 / 签名被篡改：MARKETPLACE_SIGNATURE_INVALID", (t) => {
  const dir = tmp(t);
  const signer = keyPair();
  const other = keyPair();
  const packed = packDirectory({ treeDir: writeTree(path.join(dir, "tree")), outFile: path.join(dir, "a.wxt"), privateKey: signer.privateKey });
  const out = path.join(dir, "out");
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: out });
  assert.throws(() => verifyExtensionPackage({ treeDir: out, trustedKeys: [{ publicKey: other.publicPem }] }), (error) => error.code === "MARKETPLACE_SIGNATURE_INVALID");
  // 冒用信任根里的 keyId，但签名不是它签的。
  const signature = JSON.parse(fs.readFileSync(path.join(out, SIGNATURE_NAME), "utf8"));
  fs.writeFileSync(path.join(out, SIGNATURE_NAME), JSON.stringify({ ...signature, keyId: other.keyId }));
  assert.throws(() => verifyExtensionPackage({ treeDir: out, trustedKeys: [{ publicKey: other.publicPem }] }), (error) => error.code === "MARKETPLACE_SIGNATURE_INVALID");
});

test("签名有效但树被改：多余、缺失、篡改都是 MARKETPLACE_DIGEST_MISMATCH", (t) => {
  const dir = tmp(t);
  const keys = keyPair();
  const packed = packDirectory({ treeDir: writeTree(path.join(dir, "tree")), outFile: path.join(dir, "a.wxt"), privateKey: keys.privateKey });
  const trustedKeys = [{ publicKey: keys.publicPem }];
  const fresh = (name) => {
    const out = path.join(dir, name);
    unpackExtensionPackage({ packagePath: packed.outFile, destDir: out });
    return out;
  };
  const extra = fresh("extra");
  fs.writeFileSync(path.join(extra, "backdoor.mjs"), "export {}");
  assert.throws(() => verifyExtensionPackage({ treeDir: extra, trustedKeys }), (error) => error.code === "MARKETPLACE_DIGEST_MISMATCH" && /未列出/.test(error.message));
  const missing = fresh("missing");
  fs.rmSync(path.join(missing, "browser-dist", "entry.js"));
  assert.throws(() => verifyExtensionPackage({ treeDir: missing, trustedKeys }), (error) => error.code === "MARKETPLACE_DIGEST_MISMATCH" && /缺失/.test(error.message));
  const tampered = fresh("tampered");
  fs.writeFileSync(path.join(tampered, "browser-dist", "entry.js"), "alert(1)\n");
  assert.throws(() => verifyExtensionPackage({ treeDir: tampered, trustedKeys }), (error) => error.code === "MARKETPLACE_DIGEST_MISMATCH");
  // 改 FILES.json 让它与篡改后的文件一致：签名不再覆盖 → 签名失败。
  fs.writeFileSync(path.join(tampered, FILES_MANIFEST_NAME), JSON.stringify(buildFilesManifest(tampered)));
  assert.throws(() => verifyExtensionPackage({ treeDir: tampered, trustedKeys }), (error) => error.code === "MARKETPLACE_SIGNATURE_INVALID");
});

test("未签名包：缺省拒绝；allowUnsigned 时接受并标记 unsigned；有无效签名不会降级", (t) => {
  const dir = tmp(t);
  const packed = packDirectory({ treeDir: writeTree(path.join(dir, "tree")), outFile: path.join(dir, "a.wxt") });
  const out = path.join(dir, "out");
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: out });
  assert.throws(() => verifyExtensionPackage({ treeDir: out }), (error) => error.code === "MARKETPLACE_UNSIGNED_REJECTED");
  assert.equal(verifyExtensionPackage({ treeDir: out, allowUnsigned: true }).trust, "unsigned");
  fs.writeFileSync(path.join(out, SIGNATURE_NAME), JSON.stringify({ keyId: "deadbeef", alg: "ed25519", sig: "AAAA" }));
  assert.throws(() => verifyExtensionPackage({ treeDir: out, allowUnsigned: true }), (error) => error.code === "MARKETPLACE_SIGNATURE_INVALID");
});

test("缺少 FILES.json：MARKETPLACE_DIGEST_MISMATCH", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "a.wxt");
  fs.writeFileSync(file, createTarGz([{ path: "extension.json", bytes: Buffer.from("{}") }]));
  const out = path.join(dir, "out");
  unpackExtensionPackage({ packagePath: file, destDir: out });
  assert.throws(() => verifyExtensionPackage({ treeDir: out, allowUnsigned: true }), (error) => error.code === "MARKETPLACE_DIGEST_MISMATCH");
});

test("恶意包：路径穿越 ../../escape.js", (t) => {
  assertUnsafe(t, rawPackage(tmp(t), [{ name: "../../escape.js", body: Buffer.from("x") }]), /不安全路径/);
});

test("恶意包：绝对路径、中间 ..、反斜杠", (t) => {
  for (const name of ["/tmp/abs.js", "browser-dist/../../x.js", "a\\..\\b.js"]) {
    assertUnsafe(t, rawPackage(tmp(t), [{ name, body: Buffer.from("x") }]), /不安全路径/);
  }
});

test("恶意包：符号链接、硬链接、字符设备、FIFO、pax 头", (t) => {
  const cases = [["2", /符号链接/], ["1", /硬链接/], ["3", /字符设备/], ["6", /FIFO/], ["x", /pax/]];
  for (const [type, pattern] of cases) {
    assertUnsafe(t, rawPackage(tmp(t), [{ name: "link", type, linkname: "/etc/passwd" }]), pattern);
  }
});

test("恶意包：先放符号链接目录再写入（链接被拒绝，写入不会穿出）", (t) => {
  assertUnsafe(t, rawPackage(tmp(t), [{ name: "dir", type: "2", linkname: "/tmp" }, { name: "dir/pwned.js", body: Buffer.from("x") }]), /符号链接/);
});

test("恶意包：重复条目", (t) => {
  assertUnsafe(t, rawPackage(tmp(t), [{ name: "a.js", body: Buffer.from("1") }, { name: "a.js", body: Buffer.from("2") }]), /重复条目/);
});

test("恶意包：条目数、单文件与解压总量超限；包本身超限", (t) => {
  const dir = tmp(t);
  const many = rawPackage(dir, Array.from({ length: 5 }, (_, index) => ({ name: `f${index}`, body: Buffer.from("x") })));
  assertUnsafe(t, many, /条目数/, { limits: { maxEntries: 3 } });
  const big = rawPackage(tmp(t), [{ name: "big.bin", body: Buffer.alloc(4096, 1) }]);
  assertUnsafe(t, big, /单个文件/, { limits: { maxFileBytes: 1024 } });
  const total = rawPackage(tmp(t), [{ name: "a", body: Buffer.alloc(800, 1) }, { name: "b", body: Buffer.alloc(800, 1) }]);
  assertUnsafe(t, total, /解压总量/, { limits: { maxUnpackedBytes: 1000, maxFileBytes: 1000 } });
  const work = tmp(t);
  assert.throws(
    () => unpackExtensionPackage({ packagePath: big, destDir: path.join(work, "out"), limits: { maxPackageBytes: 10 } }),
    (error) => error.code === "MARKETPLACE_PACKAGE_TOO_LARGE"
  );
  assert.equal(fs.existsSync(path.join(work, "out")), false);
});

test("恶意包：gzip 炸弹（解压后远超上限）在解压阶段被截断", (t) => {
  const dir = tmp(t);
  const bomb = path.join(dir, "bomb.wxt");
  fs.writeFileSync(bomb, gzipSync(Buffer.alloc(64 * 1024 * 1024, 0)));
  assertUnsafe(t, bomb, /上限/, { limits: { maxUnpackedBytes: 1024 * 1024, maxEntries: 10 } });
});

test("不是 gzip / 不是 tar：MARKETPLACE_ARCHIVE_UNSAFE", (t) => {
  const dir = tmp(t);
  const text = path.join(dir, "plain.wxt");
  fs.writeFileSync(text, "hello");
  assertUnsafe(t, text, /gzip/);
  const notTar = path.join(dir, "nottar.wxt");
  fs.writeFileSync(notTar, gzipSync(Buffer.alloc(1024, 7)));
  assertUnsafe(t, notTar, /校验和|ustar|数值字段/);
});

test("解包目标目录非空：拒绝且不删除已有内容", (t) => {
  const dir = tmp(t);
  const packed = packDirectory({ treeDir: writeTree(path.join(dir, "tree")), outFile: path.join(dir, "a.wxt") });
  const dest = path.join(dir, "dest");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "keep"), "1");
  assert.throws(() => unpackExtensionPackage({ packagePath: packed.outFile, destDir: dest }), (error) => error.code === "MARKETPLACE_ARCHIVE_UNSAFE");
  assert.equal(fs.readFileSync(path.join(dest, "keep"), "utf8"), "1");
});

test("打包拒绝扩展树里的符号链接", (t) => {
  const dir = tmp(t);
  const tree = writeTree(path.join(dir, "tree"));
  fs.symlinkSync("/etc/hosts", path.join(tree, "hosts"));
  assert.throws(() => packDirectory({ treeDir: tree, outFile: path.join(dir, "a.wxt") }), (error) => error.code === "MARKETPLACE_ARCHIVE_UNSAFE");
});

// ---------------------------------------------------------------------------
// 跨语言签名向量（change: 2026-10-21-add-server-extension-marketplace，任务 1.3）
// Go 侧 server/internal/marketplace/pkgformat 读同一份文件；任一侧改格式都会让这里或 Go 单测失败。
// ---------------------------------------------------------------------------

test("签名向量：文件与当前 JS 实现一致（未手改、未漂移）", async () => {
  const { SIGNATURE_VECTORS_FILE, buildSignatureVectors, serializeVectors } = await import("./extension-signature-vectors.mjs");
  assert.equal(fs.readFileSync(SIGNATURE_VECTORS_FILE, "utf8"), serializeVectors(buildSignatureVectors()));
});

test("签名向量：规范 JSON、keyId 与验签结果逐条成立", async () => {
  const { SIGNATURE_VECTORS_FILE, privateKeyFromSeed, verifyVector } = await import("./extension-signature-vectors.mjs");
  const vectors = JSON.parse(fs.readFileSync(SIGNATURE_VECTORS_FILE, "utf8"));
  assert.equal(vectors.alg, "ed25519");
  for (const key of Object.values(vectors.keys)) {
    assert.equal(keyIdOf(key.publicKeySpkiBase64), key.keyId);
    // 种子派生的私钥对应同一把公钥（Go 侧用 ed25519.NewKeyFromSeed 复现）。
    assert.equal(keyIdOf(createPublicKey(privateKeyFromSeed(key.seedHex))), key.keyId);
  }
  for (const entry of vectors.canonical) assert.equal(canonicalJson(JSON.parse(entry.input)), entry.canonical, entry.name);
  // 边界确实被覆盖：键序不是码点序、U+2028 与 DEL 原样、HTML 字符不转义。
  const byName = Object.fromEntries(vectors.canonical.map((entry) => [entry.name.split("：")[0], entry.canonical]));
  assert.ok(byName["键按 UTF-16 码元排序"].indexOf("\u{1f600}") < byName["键按 UTF-16 码元排序"].indexOf("\uff5e"));
  assert.ok(vectors.canonical.some((entry) => entry.canonical.includes("\u2028")));
  assert.ok(vectors.canonical.some((entry) => entry.canonical.includes("\u007f")));
  assert.ok(vectors.canonical.some((entry) => entry.canonical.includes("<a href")));
  for (const entry of vectors.signatures) {
    assert.equal(canonicalJson(entry.files), entry.canonical, entry.name);
    assert.equal(verifyVector(vectors, entry), entry.valid, entry.name);
  }
  assert.ok(vectors.signatures.some((entry) => entry.files.some((file) => file.size === Number.MAX_SAFE_INTEGER)));
  assert.ok(vectors.signatures.some((entry) => entry.files.some((file) => /[^\x00-\x7f]/.test(file.path))));
});

test("签名向量：签名包按向量公钥可在 verifyExtensionPackage 中通过", async (t) => {
  const { SIGNATURE_VECTORS_FILE, privateKeyFromSeed } = await import("./extension-signature-vectors.mjs");
  const vectors = JSON.parse(fs.readFileSync(SIGNATURE_VECTORS_FILE, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-vectors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tree = path.join(dir, "tree");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "extension.json"), "{}\n");
  const packed = packDirectory({ treeDir: tree, outFile: path.join(dir, "x.wxt"), privateKey: privateKeyFromSeed(vectors.keys.primary.seedHex) });
  assert.equal(packed.signature.keyId, vectors.keys.primary.keyId);
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: path.join(dir, "out") });
  const verified = verifyExtensionPackage({ treeDir: path.join(dir, "out"), trustedKeys: [{ publicKey: vectors.keys.primary.publicKeySpkiBase64 }] });
  assert.equal(verified.keyId, vectors.keys.primary.keyId);
});
