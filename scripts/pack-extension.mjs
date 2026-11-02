/**
 * 打包扩展为 .wxt：pnpm pack:extension <extensionDir> [--key <ed25519.pem>] [--out <file.wxt>] [--skip-build]
 *                  pnpm pack:extension --genkey <prefix>
 * （change: 2026-10-21-add-extension-marketplace-point，任务 3.2 / design D4）。
 *
 * 流程：
 * 1. build:browser（有 src/frontend 约定入口时）与 build:backend（有后端声明时），--skip-build 时复用现有产物；
 * 2. 在临时暂存目录组装包树：extension.json 的后端模块子路径全部改写为 ./backend-dist/entry，
 *    package.json 只保留身份字段 + exports 映射（去掉 workspace: 依赖与脚本）；version / engines 缺省时补齐；
 * 3. 对暂存树跑受管预检（preflightDirectory managed），不通过不出包；
 * 4. 生成 FILES.json，给了 --key 时 Ed25519 签名，写出 .wxt（缺省 artifacts/extensions/<id>-<version>.wxt）。
 *
 * --genkey <prefix>：生成一对 Ed25519 密钥（<prefix>.key 私钥 PEM 0600、<prefix>.pub.pem 公钥），并打印
 * keyId 与 base64 原始公钥，便于写进本机信任根 extensions.marketplace.trustedKeys。
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HOST_ENGINES, validateExtensionDescriptor } from "./lib/extension-descriptor.mjs";
import { PACKAGE_EXTENSION, PACKAGE_TOP_LEVEL, keyIdOf, packDirectory } from "./lib/extension-package.mjs";
import { readTrustDocument } from "./lib/extension-trust/store.mjs";
import { hasBrowserEntry } from "./lib/extension-scan.mjs";
import { preflightDirectory } from "./extensions-preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BACKEND_ENTRY_SUBPATH = "./backend-dist/entry";
const BACKEND_ENTRY_TARGET = "./backend-dist/entry.mjs";

export class PackExtensionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PackExtensionError";
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

/** 由宿主 engines 派生缺省 range（同主版本兼容）。 */
export function defaultEngines(host = HOST_ENGINES) {
  const caret = (version) => "^" + version.split(".")[0] + ".0.0";
  return { hostAbi: caret(host.hostAbi), sdkAbi: caret(host.sdkAbi), protocolVersion: host.protocolVersion };
}

/** 改写声明：所有后端模块指向单文件产物（打包后包里没有 src / dist）。 */
export function rewriteDescriptorForPackage(descriptor, { version, engines, hasBackend }) {
  const next = structuredClone(descriptor);
  next.version = next.version ?? version;
  next.engines = next.engines ?? engines;
  if (hasBackend) {
    for (const field of ["backend", "hostPlugin", "metadata"]) if (next[field]) next[field].module = BACKEND_ENTRY_SUBPATH;
    for (const route of next.publicRoutes ?? []) if (route.publicPathExport) route.module = BACKEND_ENTRY_SUBPATH;
  }
  return next;
}

/** 包内 package.json：只保留身份与 ESM 声明；后端产物经 exports 映射。 */
export function packagedPackageJson(pkg, { version, hasBackend }) {
  const out = { name: pkg.name, version, private: true, type: "module" };
  // displayName 是市场目录的展示名；保留它，受管安装的预检与运行期都不读它。
  if (typeof pkg.displayName === "string" && pkg.displayName.trim().length > 0) out.displayName = pkg.displayName;
  if (typeof pkg.description === "string") out.description = pkg.description;
  if (typeof pkg.license === "string") out.license = pkg.license;
  if (hasBackend) out.exports = { [BACKEND_ENTRY_SUBPATH]: BACKEND_ENTRY_TARGET };
  return out;
}

function copyRecursive(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new PackExtensionError("扩展目录里不能打包符号链接：" + from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to);
  }
}

/**
 * 打包一个扩展目录。返回 { outFile, packageDigest, extensionId, version, signed, keyId, files, preflight }。
 * 预检失败抛 PackExtensionError（.issues 为预检错误列表）。
 */
export async function packExtension({ dir, out = null, privateKey = null, certificateChain = null, skipBuild = false, repoRoot = REPO_ROOT, logger = () => undefined } = {}) {
  const extensionDir = path.resolve(dir);
  const descriptorFile = path.join(extensionDir, "extension.json");
  if (!fs.existsSync(descriptorFile)) throw new PackExtensionError("缺少 extension.json：" + extensionDir);
  const validated = validateExtensionDescriptor(JSON.parse(fs.readFileSync(descriptorFile, "utf8")));
  if (!validated.ok) throw new PackExtensionError("extension.json 无效：\n  " + validated.errors.join("\n  "));
  const descriptor = validated.value;
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
  const version = descriptor.version ?? pkg.version;
  if (typeof version !== "string") throw new PackExtensionError("无法确定版本：extension.json 与 package.json 都没有 version");
  if (descriptor.engines === undefined) logger({ event: "pack-default-engines", engines: defaultEngines() });

  const hasBrowser = hasBrowserEntry(extensionDir);
  let backend = null;
  if (!skipBuild) {
    if (hasBrowser) {
      const { buildExtensionBrowser } = await import("../web/scripts/build-extension-browser.mjs");
      const result = await buildExtensionBrowser({ cwd: extensionDir, outDir: path.join(extensionDir, "browser-dist"), stagingDir: path.join(extensionDir, ".browser-build") });
      logger({ event: "pack-browser-built", artifactId: result.artifactId });
    }
  }
  const { buildExtensionBackend, declaredBackendExports } = await import("../web/scripts/build-extension-backend.mjs");
  const hasBackend = declaredBackendExports(descriptor).length > 0;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-pack-"));
  try {
    if (hasBackend) {
      if (skipBuild && fs.existsSync(path.join(extensionDir, "backend-dist", "entry.mjs"))) {
        copyRecursive(path.join(extensionDir, "backend-dist"), path.join(stage, "backend-dist"));
      } else {
        backend = await buildExtensionBackend({ cwd: extensionDir, outDir: path.join(stage, "backend-dist") });
        logger({ event: "pack-backend-built", exports: backend.exports });
      }
    }
    for (const name of PACKAGE_TOP_LEVEL) {
      if (name === "extension.json" || name === "package.json" || name === "backend-dist") continue;
      const from = path.join(extensionDir, name);
      if (fs.existsSync(from)) copyRecursive(from, path.join(stage, name));
    }
    const packagedDescriptor = rewriteDescriptorForPackage(descriptor, { version, engines: defaultEngines(), hasBackend });
    fs.writeFileSync(path.join(stage, "extension.json"), JSON.stringify(packagedDescriptor, null, 2) + "\n");
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(packagedPackageJson(pkg, { version, hasBackend }), null, 2) + "\n");

    const preflight = await preflightDirectory(stage, { managed: true });
    if (!preflight.ok) {
      throw new PackExtensionError("受管预检未通过：\n  " + preflight.errors.map((error) => "[" + error.code + "] " + error.message).join("\n  "), { issues: preflight.errors });
    }
    const outFile = path.resolve(out ?? path.join(repoRoot, "artifacts", "extensions", descriptor.extensionId + "-" + version + PACKAGE_EXTENSION));
    const packed = packDirectory({ treeDir: stage, outFile, privateKey, certificateChain });
    return {
      outFile: packed.outFile,
      packageDigest: packed.packageDigest,
      extensionId: descriptor.extensionId,
      version,
      signed: packed.signature !== null,
      keyId: packed.signature?.keyId ?? packed.signature?.envelope?.signatures[0]?.keyId ?? null,
      files: packed.files,
      requiresRestart: preflight.requiresRestart,
      preflight
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 生成 Ed25519 密钥对：<prefix>.key（0600）与 <prefix>.pub.pem。 */
export function generateSigningKey(prefix) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = path.resolve(prefix + ".key");
  const pubFile = path.resolve(prefix + ".pub.pem");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }));
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
  return { keyFile, pubFile, keyId: keyIdOf(publicKey), publicKey: raw };
}

function readArg(name) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

async function main() {
  const genkey = readArg("genkey");
  if (genkey) {
    const result = generateSigningKey(genkey);
    process.stdout.write(JSON.stringify({ keyId: result.keyId, publicKey: result.publicKey, keyFile: result.keyFile, pubFile: result.pubFile }, null, 2) + "\n");
    return;
  }
  const positional = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !(index > 0 && ["--key", "--out", "--certificate-chain"].includes(all[index - 1])));
  const dir = positional[0];
  if (!dir) {
    process.stderr.write("用法：pnpm pack:extension <extensionDir> [--key <ed25519.pem>] [--certificate-chain <chain.json>] [--out <file.wxt>] [--skip-build]\n       pnpm pack:extension --genkey <prefix>\n");
    process.exitCode = 1;
    return;
  }
  const keyPath = readArg("key");
  const result = await packExtension({
    dir: path.resolve(process.cwd(), dir),
    out: readArg("out") ? path.resolve(process.cwd(), readArg("out")) : null,
    privateKey: keyPath ? fs.readFileSync(path.resolve(process.cwd(), keyPath), "utf8") : null,
    certificateChain: readArg("certificate-chain") ? readTrustDocument(path.resolve(process.cwd(), readArg("certificate-chain"))) : null,
    skipBuild: process.argv.includes("--skip-build"),
    logger: (event) => process.stderr.write("[pack-extension] " + JSON.stringify(event) + "\n")
  });
  process.stdout.write(
    "[pack-extension] " + path.relative(process.cwd(), result.outFile) + " " + result.extensionId + "@" + result.version +
      " " + result.packageDigest + " " + (result.signed ? "signed:" + result.keyId : "unsigned") +
      (result.requiresRestart ? "（含后端，安装后需受控重启）" : "（纯前端，可热登记）") + "\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write("[pack-extension] " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
