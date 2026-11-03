/**
 * 扩展分发包 .wxt：打包、安全解包、文件清单与签名
 * （change: 2026-10-21-add-extension-marketplace-point，任务 3.3 / design D4、D5、D6）。
 *
 * 包是 tar.gz（ustar），条目只能是普通文件或目录：
 *
 *   extension.json  package.json  browser-dist/  backend-dist/entry.mjs  assets/ README.md CHANGELOG.md
 *   FILES.json      # 规范化文件清单 [{ path, sha256, size }]，按 path 排序；不含自身与 SIGNATURE
 *   SIGNATURE       # { keyId, alg: "ed25519", sig }，sig = sign(canonicalJson(FILES.json))
 *
 * 安全边界：
 * - 解包拒绝绝对路径、..、反斜杠、空段、符号/硬链接、设备文件、FIFO、pax/GNU 扩展头、重复条目，
 *   以及条目数、单文件与解压总量超限（MARKETPLACE_ARCHIVE_UNSAFE）；包本身超限 MARKETPLACE_PACKAGE_TOO_LARGE。
 * - 只写入调用方给出的空目标目录；失败时删除目标目录，目标之外不产生文件。
 * - 校验：签名只用调用方给出的信任根（核心配置），包内或来源给出的任何「已验证」信息都不参与；
 *   签名覆盖 FILES.json，树里每个文件的 sha256/size 必须与清单一致，多余或缺失文件即失败。
 *
 * 本模块不执行包内任何代码，只依赖 node 内置模块。
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { digest as trustDigest, exact, fingerprint, parseTrustJson, requireTrust, signEnvelope } from "./extension-trust/encoding.mjs";
import { verifyPackageSignature } from "./extension-trust/verify.mjs";
import { readTrustDocument } from "./extension-trust/store.mjs";

export const PACKAGE_EXTENSION = ".wxt";
export const FILES_MANIFEST_NAME = "FILES.json";
export const SIGNATURE_NAME = "SIGNATURE";
export const SIGNATURE_ALG = "ed25519";
export const CERTIFICATE_CHAIN_NAME = "CERTIFICATES.json";
export const SIGNATURE_V2_ALG = "ed25519-wxt-v2";
const MiB = 1024 * 1024;
export const DEFAULT_PACKAGE_LIMITS = Object.freeze({
  maxPackageBytes: 200 * MiB,
  maxUnpackedBytes: 512 * MiB,
  maxFileBytes: 200 * MiB,
  maxEntries: 10_000
});
/** 打包时收录的顶层条目（其余文件——源码、测试、node_modules——不进包）。 */
export const PACKAGE_TOP_LEVEL = ["extension.json", "package.json", "browser-dist", "backend-dist", "assets", "README.md", "CHANGELOG.md", "LICENSE"];

const BLOCK = 512;
/** Ed25519 SubjectPublicKeyInfo DER 前缀：拼上 32 字节原始公钥即得 SPKI。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class ExtensionPackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExtensionPackageError";
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

const unsafe = (message, details) => new ExtensionPackageError("MARKETPLACE_ARCHIVE_UNSAFE", message, details);

/** 规范 JSON：键排序、无空白；签名与摘要都基于它，保证跨平台可复现。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 整个 .wxt 文件的摘要，格式与 ReleaseRef.packageDigest 一致：sha256:<hex>。流式计算。 */
export async function computePackageDigest(packagePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(packagePath).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve);
  });
  return "sha256:" + hash.digest("hex");
}

/** 规范化的相对路径校验（包内路径用 /）。返回 null 表示安全，否则返回原因。 */
export function unsafePathReason(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return "空路径";
  if (entryPath.includes("\0")) return "路径含 NUL";
  if (entryPath.includes("\\")) return "路径含反斜杠";
  if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) return "绝对路径";
  const segments = entryPath.replace(/\/$/, "").split("/");
  for (const segment of segments) {
    if (segment === "" ) return "空路径段";
    if (segment === "." || segment === "..") return "含 . 或 .. 路径段";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文件清单
// ---------------------------------------------------------------------------

function walkFiles(rootDir, { allowSymlinks = false } = {}) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!allowSymlinks) throw unsafe("扩展树里不允许符号链接：" + relative, { path: relative });
        continue;
      }
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) out.push({ relative, full });
      else throw unsafe("扩展树里不允许特殊文件：" + relative, { path: relative });
    }
  };
  walk(rootDir, "");
  return out;
}

/** 计算目录的文件清单（不含 FILES.json 与 SIGNATURE），按 path 排序。 */
export function buildFilesManifest(treeDir) {
  return walkFiles(treeDir)
    .filter((file) => file.relative !== FILES_MANIFEST_NAME && file.relative !== SIGNATURE_NAME)
    .map((file) => {
      const bytes = fs.readFileSync(file.full);
      return { path: file.relative, sha256: sha256Hex(bytes), size: bytes.length };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function validateFilesManifest(raw) {
  if (!Array.isArray(raw)) return "FILES.json 必须是数组";
  const seen = new Set();
  let previous = null;
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "FILES.json[" + index + "] 必须是对象";
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "path,sha256,size") return "FILES.json[" + index + "] 只能有 path / sha256 / size";
    const reason = unsafePathReason(entry.path);
    if (reason) return "FILES.json[" + index + "].path 不安全（" + reason + "）：" + String(entry.path);
    if (entry.path === FILES_MANIFEST_NAME || entry.path === SIGNATURE_NAME) return "FILES.json 不得列出 " + entry.path;
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) return "FILES.json[" + index + "].sha256 必须是 64 位小写 hex";
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) return "FILES.json[" + index + "].size 必须是非负整数";
    if (seen.has(entry.path)) return "FILES.json 重复条目：" + entry.path;
    if (previous !== null && !(previous < entry.path)) return "FILES.json 必须按 path 升序";
    seen.add(entry.path);
    previous = entry.path;
  }
  return null;
}

/** 读取并校验树根的 FILES.json；缺失或格式错误抛 MARKETPLACE_DIGEST_MISMATCH。 */
export function readPackageFiles(treeDir) {
  const file = path.join(treeDir, FILES_MANIFEST_NAME);
  if (!fs.existsSync(file)) throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", "包缺少 FILES.json 文件清单");
  let parsed;
  try {
    parsed = readTrustDocument(file, 32 * MiB);
  } catch (error) {
    throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", "FILES.json 不是合法 JSON：" + error.message);
  }
  const problem = validateFilesManifest(parsed);
  if (problem) throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", problem);
  return parsed;
}

/** 对树内容求稳定摘要（规范化 FILES.json 的 sha256）：同版本目录内容比较用，不受签名差异影响。 */
export function filesDigest(treeDir) {
  return "sha256:" + sha256Hex(Buffer.from(canonicalJson(readPackageFiles(treeDir)), "utf8"));
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

/**
 * 把信任根里的公钥转成 KeyObject。接受：PEM；base64 的 32 字节原始 Ed25519 公钥；
 * base64 的 SPKI DER（即 PEM 去掉头尾行，运维最常直接粘贴的形式）。
 */
export function toEd25519PublicKey(publicKey) {
  if (typeof publicKey !== "string" || publicKey.trim().length === 0) throw new Error("公钥为空");
  const value = publicKey.trim();
  let key;
  if (value.includes("BEGIN")) {
    key = createPublicKey(value);
  } else {
    const bytes = Buffer.from(value.replace(/\s+/g, ""), "base64");
    const der = bytes.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, bytes]) : bytes;
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("公钥不是 Ed25519");
  return key;
}

/** 公钥的稳定 keyId：sha256(SPKI DER) 前 16 位 hex。 */
export function keyIdOf(publicKey) {
  const key = typeof publicKey === "string" ? toEd25519PublicKey(publicKey) : publicKey;
  return sha256Hex(key.export({ format: "der", type: "spki" })).slice(0, 16);
}

/** 对文件清单签名，返回 SIGNATURE 内容对象。privateKey 为 PEM 或 KeyObject。 */
export function signFilesManifest(files, privateKey, { keyId } = {}) {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("签名私钥必须是 Ed25519");
  const sig = cryptoSign(null, Buffer.from(canonicalJson(files), "utf8"), key).toString("base64");
  return { keyId: keyId ?? keyIdOf(createPublicKey(key)), alg: SIGNATURE_ALG, sig };
}

function readSignature(treeDir) {
  const file = path.join(treeDir, SIGNATURE_NAME);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = readTrustDocument(file, 64 * 1024);
  } catch {
    throw new ExtensionPackageError("MARKETPLACE_SIGNATURE_INVALID", "SIGNATURE 不是合法 JSON");
  }
  if (parsed?.alg === SIGNATURE_V2_ALG) {
    exact(parsed, ["alg", "envelope"]);
    return parsed;
  }
  if (!parsed || typeof parsed !== "object" || parsed.alg !== SIGNATURE_ALG || typeof parsed.keyId !== "string" || typeof parsed.sig !== "string" || Object.keys(parsed).sort().join(",") !== "alg,keyId,sig") {
    throw new ExtensionPackageError("MARKETPLACE_SIGNATURE_INVALID", "SIGNATURE 格式非法（需要 { keyId, alg: \"ed25519\", sig }）");
  }
  return parsed;
}

/**
 * 校验已解包的树：签名（信任根）+ 每个文件与 FILES.json 一致。
 *
 * - trustedKeys：[{ keyId?, publicKey }]，来自本机核心配置；keyId 缺省按公钥派生。
 * - allowUnsigned / acceptUntrusted：是否接受**没有 SIGNATURE** 的包。
 *   acceptUntrusted 另外接受「签名格式合法，但公钥不在信任根」的包，记为 unsigned
 *   （公钥不在本地，签名本身无法核验；逐文件摘要仍然要过）。
 *   信任根里的公钥对不上、签名格式非法、或证书链失败，都不会因此降级。
 *
 * v2 additionally requires a verified trustContext; no source-provided key or unsigned fallback.
 * Returns trust/keyId/files, plus structured evidence for certified packages.
 */
export function verifyExtensionPackage({ treeDir, trustedKeys = [], allowUnsigned = false, acceptUntrusted = false, trustContext, now } = {}) {
  const files = readPackageFiles(treeDir);
  const signature = readSignature(treeDir);
  let trust;
  let keyId = null;
  let evidence;
  const chainPath = path.join(treeDir, CERTIFICATE_CHAIN_NAME);
  if (signature?.alg !== SIGNATURE_V2_ALG && fs.existsSync(chainPath)) {
    throw new ExtensionPackageError("MARKETPLACE_SIGNATURE_INVALID", "证书包不能降级为裸公钥或未签名包");
  }
  const permitUnsigned = allowUnsigned || acceptUntrusted;
  if (signature === null) {
    if (!permitUnsigned) throw new ExtensionPackageError("MARKETPLACE_UNSIGNED_REJECTED", "包没有签名");
    trust = "unsigned";
  } else if (signature.alg === SIGNATURE_V2_ALG) {
    requireTrust(fs.existsSync(chainPath), "missing-chain");
    const chain = readTrustDocument(chainPath);
    const descriptor = readTrustDocument(path.join(treeDir, "extension.json"));
    evidence = verifyPackageSignature({ envelope: signature.envelope, chain, context: trustContext, extensionId: descriptor.extensionId, filesDigest: trustDigest(files), now });
    keyId = evidence.keyId;
    trust = "certified:" + evidence.trustDomain + ":" + evidence.publisherId;
  } else {
    const candidates = [];
    for (const entry of trustedKeys) {
      try {
        const key = toEd25519PublicKey(entry.publicKey);
        // 包里的 keyId 是签名方公钥的指纹；按指纹匹配信任根。配置里的 keyId 只是展示别名，
        // 不能用来匹配（否则按 <别名>=<公钥> 配置时，合法签名永远对不上）。
        const fingerprint = keyIdOf(key);
        if (fingerprint === signature.keyId || entry.keyId === signature.keyId) {
          candidates.push({ id: entry.keyId ?? fingerprint, key });
        }
      } catch {
        // 信任根里的坏公钥不能让校验通过，跳过即可。
      }
    }
    if (candidates.length === 0) {
      if (!acceptUntrusted) {
        throw new ExtensionPackageError("MARKETPLACE_SIGNATURE_UNTRUSTED", "签名公钥 " + signature.keyId + " 不在本机信任根中", { keyId: signature.keyId });
      }
      // 用户已确认风险。公钥不在本机，签名无法核验，只保留后面的逐文件摘要检查。
      trust = "unsigned";
    } else {
      const data = Buffer.from(canonicalJson(files), "utf8");
      const sig = Buffer.from(signature.sig, "base64");
      const match = candidates.find((candidate) => {
        try {
          return cryptoVerify(null, data, candidate.key, sig);
        } catch {
          return false;
        }
      });
      if (!match) throw new ExtensionPackageError("MARKETPLACE_SIGNATURE_INVALID", "签名校验失败（keyId " + signature.keyId + "）", { keyId: signature.keyId });
      keyId = match.id;
      trust = "signed:" + match.id;
    }
  }

  const listed = new Map(files.map((entry) => [entry.path, entry]));
  const actual = walkFiles(treeDir).filter((file) => file.relative !== FILES_MANIFEST_NAME && file.relative !== SIGNATURE_NAME);
  for (const file of actual) {
    const entry = listed.get(file.relative);
    if (!entry) throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", "包里有 FILES.json 未列出的文件：" + file.relative, { path: file.relative });
    const bytes = fs.readFileSync(file.full);
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", "文件内容与 FILES.json 不一致：" + file.relative, { path: file.relative });
    }
    listed.delete(file.relative);
  }
  if (listed.size > 0) {
    throw new ExtensionPackageError("MARKETPLACE_DIGEST_MISMATCH", "FILES.json 列出的文件缺失：" + [...listed.keys()].slice(0, 5).join("、"));
  }
  return { trust, keyId, files, ...(evidence ? { evidence } : {}) };
}

// ---------------------------------------------------------------------------
// tar（ustar 子集）
// ---------------------------------------------------------------------------

function writeString(header, value, offset, length) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("tar 字段过长：" + value);
  bytes.copy(header, offset);
}

function writeOctal(header, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error("tar 数值超出 ustar 范围：" + value);
  header.write(text + "\0", offset, length, "ascii");
}

function splitUstarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let index = name.lastIndexOf("/"); index > 0; index = name.lastIndexOf("/", index - 1)) {
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error("路径过长，无法写入 ustar：" + name);
}

function tarHeader({ name, size, type }) {
  const header = Buffer.alloc(BLOCK, 0);
  const split = splitUstarName(name);
  writeString(header, split.name, 0, 100);
  writeOctal(header, type === "5" ? 0o755 : 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime=0：同输入产出同字节
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeString(header, split.prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/** 把一组 { path, bytes } 与目录写成 tar.gz（条目稳定排序、mtime=0，可复现）。 */
export function createTarGz(entries) {
  const chunks = [];
  const dirs = new Set();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
  }
  const all = [
    ...[...dirs].map((dir) => ({ path: dir + "/", dir: true })),
    ...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes }))
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of all) {
    if (entry.dir) {
      chunks.push(tarHeader({ name: entry.path, size: 0, type: "5" }));
      continue;
    }
    chunks.push(tarHeader({ name: entry.path, size: entry.bytes.length, type: "0" }));
    chunks.push(entry.bytes);
    const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function readField(header, offset, length) {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

function readOctal(header, offset, length) {
  if (header[offset] & 0x80) throw unsafe("tar 使用了 base-256 数值（超大条目），拒绝");
  const text = readField(header, offset, length).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) throw unsafe("tar 头数值字段非法（包损坏或不是 ustar）");
  return parseInt(text, 8);
}

function checksumOk(header) {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum === stored;
}

/** 解析 tar 字节，产出条目列表（只解析，不落盘）。所有不安全条目在这里拒绝。 */
export function parseTar(buffer, limits = DEFAULT_PACKAGE_LIMITS) {
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let total = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw unsafe("tar 头校验和错误（包损坏或不是 tar）");
    const magic = readField(header, 257, 6);
    if (magic !== "ustar") throw unsafe("只接受 ustar 格式的 tar");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readField(header, 345, 155);
    const rawName = readField(header, 0, 100);
    const name = prefix ? prefix + "/" + rawName : rawName;
    const size = readOctal(header, 124, 12);
    offset += BLOCK;
    if (type !== "0" && type !== "5") {
      const kind = { 1: "硬链接", 2: "符号链接", 3: "字符设备", 4: "块设备", 6: "FIFO", x: "pax 扩展头", g: "pax 全局头", L: "GNU 长文件名", K: "GNU 长链接" }[type] ?? "类型 " + type;
      throw unsafe("包里不允许" + kind + "条目：" + name, { path: name });
    }
    const normalized = name.replace(/^\.\//, "").replace(/\/+$/, "");
    const reason = unsafePathReason(normalized);
    if (reason) throw unsafe("包里有不安全路径（" + reason + "）：" + name, { path: name });
    if (seen.has(normalized)) throw unsafe("包里有重复条目：" + normalized, { path: normalized });
    seen.add(normalized);
    if (entries.length + 1 > limits.maxEntries) throw unsafe("包条目数超过上限 " + limits.maxEntries);
    if (type === "5") {
      if (size !== 0) throw unsafe("目录条目不应有内容：" + name);
      entries.push({ path: normalized, type: "dir" });
      continue;
    }
    if (size > limits.maxFileBytes) throw unsafe("单个文件超过上限：" + normalized, { path: normalized });
    total += size;
    if (total > limits.maxUnpackedBytes) throw unsafe("解压总量超过上限 " + limits.maxUnpackedBytes + " 字节");
    if (offset + size > buffer.length) throw unsafe("tar 条目被截断：" + normalized);
    entries.push({ path: normalized, type: "file", bytes: buffer.subarray(offset, offset + size) });
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/**
 * 安全解包到 destDir（必须不存在或为空目录）。
 *
 * 返回 { files: [{ path, size }], descriptor, packageJson }（descriptor / packageJson 只做 JSON 解析，
 * 不做 schema 校验——那是预检的职责；缺失时为 null）。任何失败都删除 destDir 并抛 ExtensionPackageError。
 */
export function unpackExtensionPackage({ packagePath, destDir, limits = {} } = {}) {
  const effective = { ...DEFAULT_PACKAGE_LIMITS, ...limits };
  const stat = fs.statSync(packagePath);
  if (!stat.isFile()) throw unsafe("包不是普通文件：" + packagePath);
  if (stat.size > effective.maxPackageBytes) {
    throw new ExtensionPackageError("MARKETPLACE_PACKAGE_TOO_LARGE", "包大小 " + stat.size + " 字节超过上限 " + effective.maxPackageBytes);
  }
  const target = path.resolve(destDir);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw unsafe("解包目标目录不为空：" + target);
  let tar;
  try {
    // maxOutputLength 包含 tar 头与填充，留出余量；超出抛 RangeError（防 gzip 炸弹）。
    tar = gunzipSync(fs.readFileSync(packagePath), { maxOutputLength: effective.maxUnpackedBytes + (effective.maxEntries + 2) * BLOCK * 2 });
  } catch (error) {
    if (error instanceof RangeError || error?.code === "ERR_BUFFER_TOO_LARGE") throw unsafe("解压总量超过上限（疑似压缩炸弹）");
    throw unsafe("包不是合法的 gzip：" + (error?.message ?? String(error)));
  }
  const entries = parseTar(tar, effective);
  fs.mkdirSync(target, { recursive: true });
  try {
    const files = [];
    for (const entry of entries) {
      const full = path.resolve(target, ...entry.path.split("/"));
      if (!full.startsWith(target + path.sep)) throw unsafe("条目越出解包目录：" + entry.path, { path: entry.path });
      if (entry.type === "dir") {
        fs.mkdirSync(full, { recursive: true, mode: 0o755 });
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o755 });
      // wx：目标已存在（含此前创建的同名目录）即失败，杜绝覆盖。
      fs.writeFileSync(full, entry.bytes, { flag: "wx", mode: 0o644 });
      files.push({ path: entry.path, size: entry.bytes.length });
    }
    const readJson = (name) => {
      const file = path.join(target, name);
      if (!fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    };
    return { files, descriptor: readJson("extension.json"), packageJson: readJson("package.json") };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (error instanceof ExtensionPackageError) throw error;
    throw unsafe("解包失败：" + (error?.message ?? String(error)));
  }
}

/**
 * 把一个已准备好的包目录（只含要分发的文件）打成 .wxt：生成 FILES.json，可选签名。
 * 返回 { outFile, packageDigest, files, signature }。准备目录（构建、改写 package.json）见 scripts/pack-extension.mjs。
 */
export function packDirectory({ treeDir, outFile, privateKey = null, keyId, certificateChain = null } = {}) {
  if (certificateChain) {
    requireTrust(privateKey && !keyId, "certificate-signing-key-required");
    certificateChain = parseTrustJson(JSON.stringify(certificateChain));
    exact(certificateChain, ["issuer", "publisher"]);
    const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
    const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
    requireTrust(fingerprint(pub) === fingerprint(certificateChain.publisher.signed.publicKey), "certificate-key-mismatch");
    const descriptor = parseTrustJson(fs.readFileSync(path.join(treeDir, "extension.json"), "utf8"));
    requireTrust(descriptor.extensionId === certificateChain.publisher.signed.extensionId, "publisher-scope");
    fs.writeFileSync(path.join(treeDir, CERTIFICATE_CHAIN_NAME), JSON.stringify(certificateChain) + "\n");
  } else {
    requireTrust(!fs.existsSync(path.join(treeDir, CERTIFICATE_CHAIN_NAME)), "certificate-chain-required");
  }
  for (const name of [FILES_MANIFEST_NAME, SIGNATURE_NAME]) fs.rmSync(path.join(treeDir, name), { force: true });
  const files = buildFilesManifest(treeDir);
  const entries = files.map((entry) => ({ path: entry.path, bytes: fs.readFileSync(path.join(treeDir, ...entry.path.split("/"))) }));
  entries.push({ path: FILES_MANIFEST_NAME, bytes: Buffer.from(JSON.stringify(files, null, 2) + "\n", "utf8") });
  let signature = null;
  if (privateKey) {
    signature = certificateChain ? {
      alg: SIGNATURE_V2_ALG,
      envelope: signEnvelope({
        schemaVersion: 2, kind: "package", trustDomain: certificateChain.publisher.signed.trustDomain,
        extensionId: certificateChain.publisher.signed.extensionId, filesDigest: trustDigest(files),
        certificateId: trustDigest(certificateChain.publisher.signed)
      }, [privateKey])
    } : signFilesManifest(files, privateKey, { keyId });
    entries.push({ path: SIGNATURE_NAME, bytes: Buffer.from(JSON.stringify(signature, null, 2) + "\n", "utf8") });
  }
  const archive = createTarGz(entries);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, archive);
  return { outFile: path.resolve(outFile), packageDigest: "sha256:" + sha256Hex(archive), files, signature };
}
