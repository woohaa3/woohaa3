/**
 * 跨语言签名测试向量（change: 2026-10-21-add-server-extension-marketplace，任务 1.3 / design D3）。
 *
 * 服务端（Go）与客户端（JS）各有一份 `.wxt` 签名实现：规范 JSON、keyId、Ed25519 签名必须**字节级一致**，
 * 否则一侧签出的合法包会在另一侧验签失败。向量只由本脚本（JS 实现）生成，Go 只读不写：
 *
 *   node scripts/lib/extension-signature-vectors.mjs --write   # 重新生成 scripts/fixtures/marketplace/signature-vectors.json
 *   node scripts/lib/extension-signature-vectors.mjs --check   # 与当前实现比对（CI / 单测用）
 *
 * 覆盖的边界：对象键按 UTF-16 码元排序（BMP 高位字符与代理对的先后与码点序相反）、`<>&` 不转义、
 * U+2028/2029 不转义、控制字符的 \\uXXXX 小写形式、非 ASCII 路径、大整数 size（最大安全整数）。
 * 私钥由固定种子派生，Ed25519 签名是确定性的，因此向量可复现。
 */
import { createPrivateKey, createPublicKey, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import os from "node:os";

import { canonicalJson, filesDigest, keyIdOf, packDirectory, signFilesManifest, unpackExtensionPackage } from "./extension-package.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SIGNATURE_VECTORS_FILE = path.resolve(HERE, "..", "fixtures", "marketplace", "signature-vectors.json");
export const SIGNATURE_VECTORS_SCHEMA = 1;
/** 由 packDirectory（与 pack-extension 同一打包函数）产出的真实签名包，供 Go 侧解包 / 验签 / 声明检查。 */
export const SAMPLE_PACKAGE_FILE = path.resolve(HERE, "..", "fixtures", "marketplace", "signed-sample.wxt");

/** 样例包内容：合法的受管扩展声明 + 一个非 ASCII 文件名。 */
const SAMPLE_TREE = {
  "extension.json": JSON.stringify({ schemaVersion: 1, extensionId: "vector-sample", version: "1.2.3", engines: { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 }, site: { name: "向量样例", description: "跨语言签名测试样例包", version: "1.2.3", configSchema: { schemaId: "vector-sample-config", schemaVersion: 1 }, capabilities: [], defaultEnabled: false, order: 999 }, icon: { glyph: "migration" } }, null, 2) + "\n",
  "package.json": JSON.stringify({ name: "@woohaa3/extension-vector-sample", version: "1.2.3", private: true, type: "module", description: "跨语言签名测试样例包" }, null, 2) + "\n",
  "assets/说明.txt": "样例 \u2028 内容\n",
  "README.md": "# vector-sample\n"
};

/** 在临时目录里打出样例包，返回字节与元数据（临时目录随即删除）。 */
export function buildSamplePackage(privateKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-vector-sample-"));
  try {
    const tree = path.join(dir, "tree");
    for (const [rel, content] of Object.entries(SAMPLE_TREE)) {
      const full = path.join(tree, ...rel.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const packed = packDirectory({ treeDir: tree, outFile: path.join(dir, "sample.wxt"), privateKey });
    const out = path.join(dir, "out");
    unpackExtensionPackage({ packagePath: packed.outFile, destDir: out });
    return { bytes: fs.readFileSync(packed.outFile), packageDigest: packed.packageDigest, keyId: packed.signature.keyId, filesDigest: filesDigest(out), files: packed.files };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** PKCS#8 DER 前缀：拼上 32 字节种子即得 Ed25519 私钥。 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** 由 32 字节种子（hex）派生 Ed25519 私钥。 */
export function privateKeyFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("种子必须是 32 字节");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

const SEEDS = {
  primary: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  other: "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100"
};

const HEX = (char) => char.repeat(64);

/** 规范 JSON 用例：`input` 是普通 JSON 文本（JSON.stringify 产出），两侧都从同一段文本解析后再规范化。 */
const CANONICAL_CASES = [
  { name: "空对象与空数组", value: { b: [], a: {} } },
  { name: "键按 UTF-16 码元排序：U+FF5E 排在代理对（U+1F600）之后", value: { "\uff5e": 1, "\u{1f600}": 2, z: 3, Z: 4, "\u00e9": 5 } },
  { name: "HTML 字符不转义", value: { s: '<a href="x">&amp;</a>' } },
  { name: "U+2028 / U+2029 不转义", value: { s: "line\u2028sep\u2029end" } },
  { name: "控制字符与转义", value: { s: "\u0000\u0001\b\t\n\u000b\f\r\u001f\"\\/\u007f" } },
  { name: "非 ASCII 原样输出", value: { s: "中文 · 絵文字 \u{1f600} \u00f1" } },
  { name: "整数：0、负数、2^32、最大安全整数", value: { n: [0, -1, 4294967296, 9007199254740991, -9007199254740991] } },
  { name: "布尔与 null", value: { t: true, f: false, n: null } },
  { name: "嵌套对象键序", value: { outer: { b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] } } }
];

/** 签名用例：FILES 清单（与 FILES.json 同形）。 */
function fileCases() {
  return [
    {
      name: "基本清单",
      files: [
        { path: "extension.json", sha256: HEX("a"), size: 120 },
        { path: "package.json", sha256: HEX("b"), size: 64 }
      ]
    },
    {
      name: "非 ASCII 路径（按 UTF-16 码元排序）",
      files: [
        { path: "assets/\u{ff5e}.txt", sha256: HEX("1"), size: 1 },
        { path: "assets/\u{1f600}.png", sha256: HEX("2"), size: 2 },
        { path: "assets/中文.md", sha256: HEX("3"), size: 3 },
        { path: "browser-dist/entry-ab12.js", sha256: HEX("4"), size: 4 }
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    {
      name: "大整数 size 与空文件",
      files: [
        { path: "backend-dist/entry.mjs", sha256: HEX("c"), size: 9007199254740991 },
        { path: "empty.txt", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0 },
        { path: "large.bin", sha256: HEX("d"), size: 4294967296 }
      ]
    },
    { name: "空清单", files: [] }
  ];
}

function spkiBase64(publicKey) {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

/** 由当前 JS 实现生成全部向量。 */
export function buildSignatureVectors() {
  const keys = Object.fromEntries(
    Object.entries(SEEDS).map(([name, seed]) => {
      const privateKey = privateKeyFromSeed(seed);
      const publicKey = createPublicKey(privateKey);
      return [name, { seedHex: seed, publicKeySpkiBase64: spkiBase64(publicKey), keyId: keyIdOf(publicKey), privateKey, publicKey }];
    })
  );
  const canonical = CANONICAL_CASES.map((entry) => {
    const input = JSON.stringify(entry.value);
    return { name: entry.name, input, canonical: canonicalJson(JSON.parse(input)) };
  });
  const signatures = [];
  for (const entry of fileCases()) {
    const text = canonicalJson(entry.files);
    const signature = signFilesManifest(entry.files, keys.primary.privateKey);
    signatures.push({ name: entry.name, key: "primary", files: entry.files, canonical: text, keyId: signature.keyId, sig: signature.sig, valid: true });
  }
  // 负例：签名与清单不匹配、公钥不匹配。验签方必须给出 false。
  const base = signatures[0];
  signatures.push({
    name: "负例：清单被篡改（size 变化）",
    key: "primary",
    files: base.files.map((file, index) => (index === 0 ? { ...file, size: file.size + 1 } : file)),
    canonical: canonicalJson(base.files.map((file, index) => (index === 0 ? { ...file, size: file.size + 1 } : file))),
    keyId: base.keyId,
    sig: base.sig,
    valid: false
  });
  signatures.push({ name: "负例：用另一把公钥验签", key: "other", files: base.files, canonical: base.canonical, keyId: base.keyId, sig: base.sig, valid: false });
  const sample = buildSamplePackage(keys.primary.privateKey);
  return {
    sample,
    schema: SIGNATURE_VECTORS_SCHEMA,
    generatedBy: "scripts/lib/extension-signature-vectors.mjs",
    note: "Generated from the JS implementation. Do not edit by hand; Go tests only read this file.",
    alg: "ed25519",
    keyIdRule: "first 16 lowercase hex characters of sha256(SPKI DER)",
    keys: Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, { seedHex: key.seedHex, publicKeySpkiBase64: key.publicKeySpkiBase64, keyId: key.keyId }])),
    canonical,
    signatures,
    samplePackage: {
      file: path.basename(SAMPLE_PACKAGE_FILE),
      key: "primary",
      extensionId: "vector-sample",
      version: "1.2.3",
      label: "向量样例",
      packageDigest: sample.packageDigest,
      filesDigest: sample.filesDigest,
      keyId: sample.keyId,
      files: sample.files
    }
  };
}

/** 用 JS 验签判定一个签名向量（供单测断言 valid 字段与实现一致）。 */
export function verifyVector(vectors, entry) {
  const publicKey = createPublicKey({ key: Buffer.from(vectors.keys[entry.key].publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
  return cryptoVerify(null, Buffer.from(canonicalJson(entry.files), "utf8"), publicKey, Buffer.from(entry.sig, "base64"));
}

export function serializeVectors(vectors) {
  const { sample: _sample, ...rest } = vectors;
  return JSON.stringify(rest, null, 2) + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  const vectors = buildSignatureVectors();
  const expected = serializeVectors(vectors);
  if (mode === "--write") {
    fs.mkdirSync(path.dirname(SIGNATURE_VECTORS_FILE), { recursive: true });
    fs.writeFileSync(SIGNATURE_VECTORS_FILE, expected);
    fs.writeFileSync(SAMPLE_PACKAGE_FILE, vectors.sample.bytes);
    console.log("written", SIGNATURE_VECTORS_FILE, SAMPLE_PACKAGE_FILE);
  } else {
    const current = fs.existsSync(SIGNATURE_VECTORS_FILE) ? fs.readFileSync(SIGNATURE_VECTORS_FILE, "utf8") : null;
    const sample = fs.existsSync(SAMPLE_PACKAGE_FILE) ? fs.readFileSync(SAMPLE_PACKAGE_FILE) : null;
    if (current !== expected || !sample || !sample.equals(vectors.sample.bytes)) {
      console.error("signature-vectors.json 与 JS 实现不一致；运行 node scripts/lib/extension-signature-vectors.mjs --write 后审阅差异");
      process.exit(1);
    }
    console.log("signature vectors up to date");
  }
}