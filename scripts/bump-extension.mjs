#!/usr/bin/env node
/**
 * 推进一个扩展的分发版本
 * （change: 2026-11-13-add-extension-version-governance，design D2）。
 *
 *   pnpm ext:bump <extensionId|目录> (--patch|--minor|--major|--version <semver>)
 *                  [--note <说明>] [--dry-run] [--json]
 *
 * 只做纯数据变换：读四处版本声明 → 校验此刻互等 → 计算新版本 → 原子写回 → 追加 CHANGELOG。
 * **不推断**这次改动算不算破坏兼容：patch / minor / major 的语义由调用方决定。
 *
 * 新版本必须严格高于当前值。目标不更高时失败且不写任何文件——重复执行说明调用方对
 * 「当前版本」的判断与仓库不一致，应当失败而不是静默成功。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  EXTENSION_VERSION_CODES,
  alignVersionDeclarations,
  appendChangelog,
  compareVersions,
  headCommitSubject,
  highestDeclaredVersion,
  readVersionDeclarations,
  resolveNextVersion,
  versionProblems,
  writeVersionDeclarations
} from "./lib/extension-version.mjs";
import { scanExtensions } from "./lib/extension-scan.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class BumpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BumpError";
    this.code = details.code ?? "EXTENSION_BUMP_FAILED";
    Object.assign(this, details);
  }
}

export function usage() {
  return [
    "推进扩展分发版本",
    "",
    "  pnpm ext:bump <extensionId|目录> --patch|--minor|--major",
    "  pnpm ext:bump <extensionId|目录> --version <semver>",
    "  pnpm ext:bump <extensionId|目录> --align        # 把历史分叉收口到最高值",
    "",
    "选项：",
    "  --note <说明>   追加到 CHANGELOG 的说明（缺省取当前提交信息首行）",
    "  --dry-run       只打印将要写入的内容，不改文件",
    "  --json          以 JSON 输出结果",
    "",
    "一次改全四处：extension.json 的 version 与 site.version、package.json 的 version、",
    "以及 src/frontend/metadata.ts / src/shared.ts 里的 version 字面量。",
    "新版本必须严格高于当前值。",
    ""
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { target: null, kind: null, version: null, note: null, dryRun: false, align: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new BumpError(`${arg} 缺少值`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--patch":
      case "--minor":
      case "--major":
        if (options.kind !== null) throw new BumpError("只能指定一种递增方式");
        options.kind = arg.slice(2);
        break;
      case "--version":
        if (options.kind !== null) throw new BumpError("--version 不能与 --patch / --minor / --major 同时使用");
        options.version = value();
        break;
      case "--note":
        options.note = value();
        break;
      case "--align":
        options.align = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new BumpError(`未知参数：${arg}`);
        if (options.target !== null) throw new BumpError("只能指定一个扩展");
        options.target = arg;
    }
  }
  if (options.help) return options;
  if (!options.target) throw new BumpError("需要指定扩展 extensionId 或目录");
  if (options.align) {
    if (options.kind !== null || options.version !== null) {
      throw new BumpError("--align 不能与 --patch / --minor / --major / --version 同时使用");
    }
    return options;
  }
  if (options.kind === null && options.version === null) {
    throw new BumpError("需要 --patch / --minor / --major 或 --version <semver>（或用 --align 收口历史分叉）");
  }
  return options;
}

/**
 * 由 extensionId 或目录定位扩展。
 *
 * 目录可以直接给（`web/extensions/foo`），也可以给相对仓库根的路径；否则按扫描结果匹配
 * extensionId。停用目录（`.` 前缀）也参与匹配——它们同样需要版本声明。
 */
export function resolveExtensionDirectory(target, { repoRoot = REPO_ROOT } = {}) {
  const direct = path.resolve(repoRoot, target);
  if (fs.existsSync(path.join(direct, "extension.json"))) return direct;

  const scan = scanExtensions({ repoRoot });
  const candidates = [
    ...scan.extensions.map((entry) => ({ id: entry.extensionId, dir: entry.dir })),
    ...scan.disabled.map((entry) => ({ id: path.basename(entry.dir).replace(/^\.+/, ""), dir: entry.dir }))
  ];
  const matches = candidates.filter((entry) => entry.id === target);
  if (matches.length === 1) return matches[0].dir;
  if (matches.length > 1) {
    throw new BumpError(`扩展 ${target} 有多个目录，请直接指定目录：\n  ${matches.map((entry) => entry.dir).join("\n  ")}`);
  }
  throw new BumpError(`找不到扩展 ${target}：既不是含 extension.json 的目录，也不在扫描结果里`);
}

/**
 * 执行一次 bump。返回 `{ extensionId, directory, from, to, changed, changelog, dryRun }`。
 *
 * `dry-run` 时只计算，不写任何文件。
 */
export function bumpExtension(target, { kind, version, note = null, dryRun = false, align = false, repoRoot = REPO_ROOT, now = new Date() } = {}) {
  const directory = resolveExtensionDirectory(target, { repoRoot });
  const declarations = readVersionDeclarations(directory);
  const extensionId = declarations.extensionId;

  // --align：把历史分叉收口到各处声明的最高值，不要求它们在「此刻一致」。
  if (align) {
    const target0 = highestDeclaredVersion(declarations);
    if (target0 === null) {
      throw new BumpError(`${extensionId} 没有任何可比较的版本声明，无法对齐`);
    }
    if (dryRun) {
      return { extensionId, directory, from: declarations.distributionVersion, to: target0, changed: [], changelog: null, dryRun: true, aligned: true };
    }
    const changed = alignVersionDeclarations(declarations, target0);
    const subject = note && note.trim() ? note.trim() : headCommitSubject(repoRoot);
    const changelog = appendChangelog(directory, { from: declarations.distributionVersion ?? "（未声明）", to: target0, note: `版本对齐${subject ? `：${subject}` : ""}`, date: now });
    return { extensionId, directory, from: declarations.distributionVersion, to: target0, changed: [...changed, changelog], changelog, dryRun: false, aligned: true };
  }

  // 常规 bump：先确认四处此刻一致。不一致时无法判断「新值是否更高」，直接改会把分叉固化下来。
  const problems = versionProblems({
    extensionId,
    descriptor: declarations.descriptor,
    packageVersion: declarations.packageJson?.version,
    metadataVersions: declarations.metadataVersions
  });
  if (problems.length > 0) {
    const hint = highestDeclaredVersion(declarations);
    throw new BumpError(
      `${extensionId} 的版本声明当前不一致，先运行 \`pnpm ext:bump ${extensionId} --align\`${hint ? `（对齐到 ${hint}）` : ""} 或手工修正：\n  ${problems
        .map((problem) => `[${problem.code}] ${problem.message}`)
        .join("\n  ")}`,
      { code: EXTENSION_VERSION_CODES.mismatch, issues: problems }
    );
  }

  const from = declarations.distributionVersion;
  const to = resolveNextVersion(from, { kind, version });
  if (compareVersions(to, from) !== 1) {
    throw new BumpError(`目标版本 ${to} 不高于当前版本 ${from}`);
  }

  if (dryRun) {
    return { extensionId, directory, from, to, changed: [], changelog: null, dryRun: true };
  }

  const changed = writeVersionDeclarations(declarations, to);
  const subject = note && note.trim() ? note.trim() : headCommitSubject(repoRoot);
  const changelog = appendChangelog(directory, { from, to, note: subject, date: now });
  return { extensionId, directory, from, to, changed: [...changed, changelog], changelog, dryRun: false };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`[ext:bump] ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    stdout.write(usage());
    return 0;
  }

  let result;
  try {
    result = bumpExtension(options.target, {
      kind: options.kind,
      version: options.version,
      note: options.note,
      dryRun: options.dryRun,
      align: options.align
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? "EXTENSION_BUMP_FAILED", message }, null, 2)}\n`);
    else stderr.write(`[ext:bump] 失败：${message}\n`);
    return 1;
  }

  const payload = {
    ok: true,
    extensionId: result.extensionId,
    directory: path.relative(process.cwd(), result.directory) || ".",
    from: result.from,
    to: result.to,
    changed: result.changed,
    dryRun: result.dryRun
  };
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const prefix = result.dryRun ? "（预演，未写文件）" : "";
  stdout.write(
    `[ext:bump] ${result.extensionId} ${result.from} → ${result.to}${prefix}\n` +
      (result.dryRun ? "" : `[ext:bump] 已更新：${result.changed.join("、")}\n`)
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[ext:bump] 失败：${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
