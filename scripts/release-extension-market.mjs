#!/usr/bin/env node
/**
 * 把内置扩展发布到市场
 * （change: 2026-11-13-add-extension-version-governance，design D4）。
 *
 *   pnpm ext:release <extensionId|目录> [--bump-base <rev>] [--notes <text>] [--approve]
 *                   [--key <ed25519.pem>] [--certificate-chain <chain.json>] [--dry-run] [--json]
 *
 * 本命令只做**前置判定**，打包/签名/上传/提交/审核仍由父仓既有的
 * `pnpm release:extension` 完成（同一份 pack-extension，签名与预检只有一份实现）。
 *
 * 判定两件事，都在打包之前：
 *
 * 1. **能否被市场覆盖**。站点 `backend` 工厂与 `bootstrap` 槽位扩展装不进市场：
 *    运行期 `checkBuiltinUpgrade` 会直接拒绝（站点后端不支持覆盖升级），受管根也禁止
 *    `bootstrap`。在这里失败比「传到一半才被告知不行」有用。
 * 2. **版本是否已推进**。工作树有改动而分发版本没变时拒绝——发布一个与上次内容相同、
 *    版本号也相同的包没有意义，且市场侧会因 `MARKETPLACE_VERSION_CONTENT_CONFLICT` 拒绝。
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { preflightDirectory } from "./extensions-preflight.mjs";
import { EXTENSION_VERSION_CODES, unreleasedChanges } from "./lib/extension-version.mjs";
import { resolveExtensionDirectory } from "./bump-extension.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class ReleaseGateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReleaseGateError";
    this.code = details.code ?? "EXTENSION_RELEASE_BLOCKED";
    Object.assign(this, details);
  }
}

export function usage() {
  return [
    "把扩展发布到市场（前置判定后转调 release:extension）",
    "",
    "  pnpm ext:release <extensionId|目录> [--bump-base <rev>] [--notes <text>] [--approve]",
    "",
    "选项：",
    "  --bump-base <rev>   检查版本单调性的 git 基线（缺省 HEAD）",
    "  --notes <text>      发布说明",
    "  --approve           提交后立即审核通过（需要 marketplace.review）",
    "  --key <pem>         签名私钥（转交给 pack-extension）",
    "  --certificate-chain <json>  证书链（v2 信任域）",
    "  --dry-run           只做判定，不打包不发布",
    "  --json              JSON 输出",
    "",
    "不可被市场覆盖的形态（站点 backend 工厂、bootstrap 槽位）会被拒绝并说明只能随客户端发版。",
    ""
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    target: null,
    bumpBase: "HEAD",
    notes: "",
    approve: false,
    key: null,
    certificateChain: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new ReleaseGateError(`${arg} 缺少值`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--bump-base": options.bumpBase = value(); break;
      case "--notes": options.notes = value(); break;
      case "--approve": options.approve = true; break;
      case "--key": options.key = value(); break;
      case "--certificate-chain": options.certificateChain = value(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        if (arg.startsWith("--")) throw new ReleaseGateError(`未知参数：${arg}`);
        if (options.target !== null) throw new ReleaseGateError("只能指定一个扩展");
        options.target = arg;
    }
  }
  if (options.help) return options;
  if (!options.target) throw new ReleaseGateError("需要指定扩展 extensionId 或目录");
  return options;
}

/**
 * 发布前判定。返回 `{ extensionId, directory, version, preflight }`；不合格时抛
 * `ReleaseGateError` 并带上稳定码。
 *
 * 不打包、不上传、不签发任何东西：纯粹读声明与 git 状态。
 */
export async function checkReleaseReady(target, { repoRoot = REPO_ROOT, bumpBase = "HEAD" } = {}) {
  const directory = resolveExtensionDirectory(target, { repoRoot });
  const preflight = await preflightDirectory(directory);
  if (!preflight.ok) {
    throw new ReleaseGateError(
      `${preflight.extensionId ?? target} 未通过受管预检，先修好再发布：\n  ${preflight.errors
        .map((error) => `[${error.code}] ${error.message}`)
        .join("\n  ")}`,
      { code: "EXTENSION_RELEASE_BLOCKED", issues: preflight.errors }
    );
  }

  const descriptor = preflight.descriptor ?? {};
  // bootstrap 槽位只允许内建根，受管根（市场安装位置）声明它就是非法组合。
  if (descriptor.bootstrap) {
    throw new ReleaseGateError(
      `${preflight.extensionId} 声明了 bootstrap 槽位实现：这类扩展只能随客户端发版，市场装不了（受管根禁止 bootstrap）`,
      { code: "EXTENSION_RELEASE_NOT_DISTRIBUTABLE", extensionId: preflight.extensionId }
    );
  }
  // 站点 backend 工厂：运行期 checkBuiltinUpgrade 会以 MARKETPLACE_BUILTIN_CONFLICT 拒绝覆盖。
  if (descriptor.backend && !preflight.hotSwappable) {
    throw new ReleaseGateError(
      `${preflight.extensionId} 使用站点 backend 工厂，运行期不支持市场覆盖升级（checkBuiltinUpgrade 会拒绝）；请随客户端版本发布`,
      { code: "EXTENSION_RELEASE_NOT_DISTRIBUTABLE", extensionId: preflight.extensionId }
    );
  }

  const change = unreleasedChanges({ repoRoot, base: bumpBase, dir: directory, currentVersion: preflight.version });
  if (change.available && !change.bumped) {
    throw new ReleaseGateError(
      `${preflight.extensionId} 有未发版的改动（${change.changed.slice(0, 3).join("、")}${change.changed.length > 3 ? " 等" : ""}），当前版本 ${preflight.version}；先运行 \`pnpm ext:bump ${preflight.extensionId} --patch\``,
      { code: EXTENSION_VERSION_CODES.notBumped, extensionId: preflight.extensionId }
    );
  }

  return {
    extensionId: preflight.extensionId,
    directory,
    version: preflight.version,
    hotSwappable: preflight.hotSwappable,
    bumpBaseChecked: change.available,
    preflight
  };
}

/** 由判定结果拼出父仓发布命令的参数（不含令牌与服务器，那些由 release:extension 自己取）。 */
export function releaseCommandArgs(ready, options) {
  const args = [ready.directory];
  if (options.key) args.push("--key", options.key);
  if (options.certificateChain) args.push("--certificate-chain", options.certificateChain);
  if (options.notes) args.push("--notes", options.notes);
  if (options.approve) args.push("--approve");
  return args;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, publish = null } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`[ext:release] ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    stdout.write(usage());
    return 0;
  }

  let ready;
  try {
    ready = await checkReleaseReady(options.target, { bumpBase: options.bumpBase });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code ?? "EXTENSION_RELEASE_BLOCKED";
    if (options.json) stdout.write(`${JSON.stringify({ ok: false, code, message }, null, 2)}\n`);
    else stderr.write(`[ext:release] 拒绝发布：${message}\n`);
    return 1;
  }

  const args = releaseCommandArgs(ready, options);
  if (options.dryRun) {
    const payload = {
      ok: true,
      dryRun: true,
      extensionId: ready.extensionId,
      version: ready.version,
      directory: path.relative(process.cwd(), ready.directory) || ".",
      command: ["pnpm", "release:extension", ...args]
    };
    if (options.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      stdout.write(`[ext:release] ${ready.extensionId}@${ready.version} 可以发布（预演，未打包）\n`);
      stdout.write(`[ext:release] 将执行：pnpm release:extension ${args.join(" ")}\n`);
    }
    return 0;
  }

  stdout.write(`[ext:release] ${ready.extensionId}@${ready.version} 通过前置判定，转交市场发布\n`);
  const run = publish ?? defaultPublish;
  const code = await run(args);
  return code;
}

/** 转调父仓 `pnpm release:extension`（工作目录是父仓根）。 */
async function defaultPublish(args) {
  const { spawn } = await import("node:child_process");
  const parentRoot = path.resolve(REPO_ROOT, "..");
  const child = spawn("pnpm", ["release:extension", ...args], { cwd: parentRoot, stdio: "inherit", shell: false });
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[ext:release] 失败：${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
