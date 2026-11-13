/**
 * 扩展分发版本的读取、一致性与推进
 * （change: 2026-11-13-add-extension-version-governance）。
 *
 * 分发版本的唯一真源是 `extension.json` 的 `version`：市场升级判定、受管覆盖比较与
 * `.wxt` 包名都取它（见 extension-scan 的 `distributionVersion`）。其余三处只是**同一事实的副本**：
 *
 * - `extension.json.site.version` —— 站点控制面与站点目录展示用（`siteEntryOf`）；
 * - `package.json.version` —— npm 口径，受管预检与 Go 侧 pkgformat 都会与之比对；
 * - `src/frontend/metadata.ts` / `src/shared.ts` 的 `version` 字面量 —— 浏览器 artifact 的展示版本。
 *
 * 副本允许"间接"（`version: SOME_CONSTANT.version`，如 remote-server 从 shared.ts 取）：
 * 那种写法静态读不到字面量，本模块**跳过**它，由构建期（metadata 已被求值）负责核对。
 *
 * 本模块只做纯数据变换与只读检查，不 import 任何执行期入口。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readExtensionDescriptor } from "./extension-scan.mjs";
import { rewriteJsonVersionLiterals } from "./json-version-rewrite.mjs";

/** 版本声明的稳定错误码（预检与命令共用，便于测试与日志断言）。 */
export const EXTENSION_VERSION_CODES = Object.freeze({
  /** `extension.json` 没有声明 `version`（分发版本无真源）。 */
  missing: "EXTENSION_VERSION_MISSING",
  /** 四处声明不是同一个值。 */
  mismatch: "EXTENSION_VERSION_MISMATCH",
  /** 扩展目录有改动但分发版本没推进。 */
  notBumped: "EXTENSION_VERSION_NOT_BUMPED"
});

/** 严格三段 semver（`1.2.3`；预发布/构建后缀不参与版本推进，见 design D2）。 */
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 声明 version 字面量的候选文件（相对扩展目录，按优先级）。 */
const METADATA_FILE = "src/frontend/metadata.ts";

/** `version: "1.2.3"` 字面量；`version: FOO.version` 这类间接写法不匹配。 */
const VERSION_LITERAL = /(\bversion:\s*)(["'])([^"']*)\2/g;

/**
 * 找出某个导出常量在源码里的**对象字面量区间**（`[start, end)`，指向 `{ ... }` 内容）。
 *
 * 为什么不能全文正则替换：`src/shared.ts` 里除了元数据，还可能有**其他** `version:` 字面量。
 * 典型例子是 `sdk-agent` 的 `sdkEngineForAdapter()`——那四处是 agent engine 版本描述符
 * （`engine: "codex-agent-sdk", version: "0.1.0"`），与扩展分发版本毫无关系；全文替换会把它们
 * 一起改掉，制造一个没有报错但语义错误的提交。
 *
 * 找不到该导出时返回 null，调用方退化为「不碰这个文件」而不是猜。
 */
export function metadataObjectRange(source, exportName) {
  if (typeof exportName !== "string" || exportName.length === 0) return null;
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `export const NAME ... = {` / `export const NAME: Type = {`
  const declaration = new RegExp(`export\\s+const\\s+${escaped}\\s*(?::[^=]+)?=\\s*\\{`);
  const match = declaration.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1; // 指向 `{`
  // 从 `{` 起配对花括号，跳过字符串与模板字面量，避免被其中的 `}` 提前截断。
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

/** 在给定区间内把 `version:` 字面量改成新值；返回替换次数（区间外一律不动）。 */
function replaceVersionLiteralsInRange(source, range, from, to) {
  const slice = source.slice(range.start, range.end);
  let count = 0;
  const next = slice.replace(VERSION_LITERAL, (whole, prefix, quote, value) => {
    if (value !== from) return whole;
    count += 1;
    return `${prefix}${quote}${to}${quote}`;
  });
  return { source: source.slice(0, range.start) + next + source.slice(range.end), count };
}

export function isStrictVersion(value) {
  return typeof value === "string" && STRICT_VERSION.test(value);
}

function parseTriple(value) {
  const match = STRICT_VERSION.exec(typeof value === "string" ? value : "");
  return match ? match.slice(1).map(Number) : null;
}

/** 三段比较；任一非法时返回 null（调用方按"无法比较"处理，不猜）。 */
export function compareVersions(a, b) {
  const left = parseTriple(a);
  const right = parseTriple(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** 按 patch / minor / major 递增；当前值非法时返回 null。 */
export function incrementVersion(current, kind) {
  const triple = parseTriple(current);
  if (!triple) return null;
  const [major, minor, patch] = triple;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  return null;
}

/**
 * 目标版本：`kind` 递增或显式 `version`。新值必须**严格更高**——等于或更低说明调用方对
 * "当前版本"的判断与仓库不一致，应失败而不是静默成功（design「失败语义」）。
 */
export function resolveNextVersion(current, { kind, version } = {}) {
  if (!isStrictVersion(current)) {
    throw new Error(`当前分发版本不是严格三段 semver：${String(current)}`);
  }
  // `version` 允许为 null（命令行未给该开关时的缺省）：null 与 undefined 都是「没指定」。
  // 只判 `!== undefined` 会把 null 当成显式目标版本，进而丢掉 `--patch` 这类递增开关。
  const explicit = version === undefined || version === null ? null : version;
  const next = explicit !== null ? explicit : incrementVersion(current, kind);
  if (next === null) throw new Error(`未指定递增方式：需要 --patch / --minor / --major 或 --version <semver>`);
  if (!isStrictVersion(next)) throw new Error(`目标版本不是严格三段 semver：${String(next)}`);
  const order = compareVersions(next, current);
  if (order === null) throw new Error(`无法比较版本：${next} 与 ${current}`);
  if (order <= 0) throw new Error(`目标版本 ${next} 不高于当前版本 ${current}`);
  return next;
}

/**
 * 读取一个扩展目录的全部版本声明。
 *
 * 返回 `{ dir, extensionId, descriptorPath, packagePath, descriptor, packageJson,
 * distributionVersion, metadataVersions }`。`metadataVersions` 是
 * `[{ file, value }]`，只含**字面量**写法；间接引用不出现在这里（由构建期核对）。
 */
export function readVersionDeclarations(dir) {
  const root = path.resolve(dir);
  const descriptorPath = path.join(root, "extension.json");
  const packagePath = path.join(root, "package.json");
  const { descriptor } = readExtensionDescriptor(root);
  if (!descriptor) throw new Error(`扩展目录缺少 extension.json：${root}`);
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const metadataVersions = [];
  for (const source of metadataSources(root, descriptor)) {
    const range = metadataObjectRange(source.text, source.exportName);
    if (!range) continue;
    const slice = source.text.slice(range.start, range.end);
    for (const match of slice.matchAll(VERSION_LITERAL)) {
      metadataVersions.push({ file: source.file, value: match[3] });
    }
  }
  const distributionVersion =
    typeof descriptor.version === "string" && descriptor.version.trim() ? descriptor.version.trim() : null;
  return {
    dir: root,
    extensionId: descriptor.extensionId,
    descriptorPath,
    packagePath,
    descriptor,
    packageJson,
    distributionVersion,
    metadataVersions
  };
}

/**
 * 可能承载版本声明的源码文件及其**权威导出名**。
 *
 * 两处，都必须读：
 *
 * - `src/frontend/metadata.ts`：浏览器侧的 `ExtensionFrontendMetadata`，导出名随扩展而异，按内容识别；
 * - `extension.json` 的 `metadata.export`（通常是 `src/shared.ts` 的 `ApplicationExtensionMetadata`）：
 *   导出名由声明给出，是这一处唯一可靠的定位方式。
 *
 * **为什么后端元数据必须纳入**：它的 `version` 也被设置面展示（没有 `site.version` 时优先它），
 * 历史上却被单独维护、已经与分发版本分叉（`runninghub-provider` 2.2.0、若干 provider 1.0.0，
 * 而 `extension.json` 是 0.1.0）。放着不管会让用户看到「v1.0.0」而升级逻辑认为「0.1.0」，
 * 之后发布 0.1.1 在用户眼里就是降级。因此这两处与 `extension.json` / `package.json` 一样，
 * 必须表达同一个数字。
 *
 * **为什么必须按导出名定位而不是全文扫描**：`src/shared.ts` 里还会有**无关**的 `version:` 字面量。
 * 典型是 `sdk-agent` 的 `sdkEngineForAdapter()`——那四处是 agent engine 版本
 * （`engine: "codex-agent-sdk", version: "0.161.0"`），与扩展版本毫无关系；全文替换会把它们改成
 * 扩展版本，制造一个不报错但语义错误的提交。`sdk-agent` 没有 `metadata` 声明，因此上面第二条
 * 不会读到它——这正是按声明定位的价值。
 */
function metadataSources(root, descriptor) {
  const sources = [];

  const frontendFile = path.join(root, METADATA_FILE);
  if (fs.existsSync(frontendFile)) {
    const text = fs.readFileSync(frontendFile, "utf8");
    sources.push({ file: METADATA_FILE, text, exportName: frontendMetadataExportName(text) });
  }

  const declared = descriptor?.metadata;
  if (declared && typeof declared.export === "string") {
    const moduleSubpath = typeof declared.module === "string" ? declared.module : "./shared";
    const relative = String(moduleSubpath).replace(/^\.\//, "");
    for (const candidate of [`src/${relative}.ts`, `src/${relative}/index.ts`]) {
      const absolute = path.join(root, candidate);
      if (!fs.existsSync(absolute)) continue;
      sources.push({ file: candidate, text: fs.readFileSync(absolute, "utf8"), exportName: declared.export });
      break;
    }
  }

  return sources;
}

/** 从 `src/frontend/metadata.ts` 的源码里认出被导出的元数据常量名（找不到返回 null）。 */
function frontendMetadataExportName(source) {
  const exported = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/.exec(source);
  return exported ? exported[1] : null;
}

/**
 * 一处版本声明的一致性检查。
 *
 * `metadataVersion` 是单个**已求值**版本（构建期从 artifact metadata 读），用于覆盖
 * `version: SOME_CONSTANT.version` 这种静态读不到的写法；`metadataVersions` 是静态读到的
 * 前端 metadata 字面量清单（预检用），每一条都必须等于分发版本。两者可同时给。
 *
 * **不覆盖后端共享元数据**（`src/shared.ts` 的 `ApplicationExtensionMetadata.version`）：
 * 那是后端插件描述符自己的版本，与分发版本独立维护（见 `metadataSources` 的说明）。
 *
 * 返回 `[{ code, field?, value?, message }]`；空数组表示一致。
 */
export function versionProblems({
  extensionId,
  descriptor,
  packageVersion,
  metadataVersion,
  metadataVersions,
  location
} = {}) {
  const problems = [];
  const where = location ? `（${location}）` : "";
  const label = extensionId ? `${extensionId}${where}` : where;
  const declared = typeof descriptor?.version === "string" ? descriptor.version.trim() : "";

  if (!declared) {
    problems.push({
      code: EXTENSION_VERSION_CODES.missing,
      field: "extension.json.version",
      message: `${label} 没有声明 extension.json 的 version：分发版本是市场升级与受管覆盖的唯一依据，必须显式声明。运行 \`pnpm ext:bump ${extensionId ?? "<id>"} --align\` 补齐（会把各处声明对齐到最高值）`
    });
    // 没有真源时其余比对没有意义（拿谁的值为准都不对），只报这一条。
    return problems;
  }
  if (!isStrictVersion(declared)) {
    problems.push({
      code: EXTENSION_VERSION_CODES.mismatch,
      field: "extension.json.version",
      value: declared,
      message: `${label} 的版本 ${declared} 不是严格三段 semver（如 1.0.0）`
    });
    return problems;
  }

  const compare = (field, value) => {
    if (value === undefined || value === null || value === "") return;
    if (value === declared) return;
    problems.push({
      code: EXTENSION_VERSION_CODES.mismatch,
      field,
      value,
      message: `${label} 的 ${field} 是 ${value}，与分发版本 ${declared} 不一致`
    });
  };

  compare("package.json.version", packageVersion);
  compare("extension.json.site.version", descriptor?.site?.version);
  compare("metadata.version", metadataVersion);
  for (const entry of metadataVersions ?? []) {
    const value = typeof entry === "string" ? entry : entry?.value;
    const file = typeof entry === "string" ? undefined : entry?.file;
    if (value === undefined || value === null || value === "") continue;
    if (value === declared) continue;
    problems.push({
      code: EXTENSION_VERSION_CODES.mismatch,
      field: "metadata.version",
      value,
      message: `${label} 的 metadata.version（${file ?? "metadata"}）是 ${value}，与分发版本 ${declared} 不一致`
    });
  }

  // 任何分叉都给同一条修复命令：对齐会把四处统一到最高值，之后再 bump 才有意义。
  if (problems.length > 0 && extensionId) {
    const hint = `运行 \`pnpm ext:bump ${extensionId} --align\` 把四处对齐到最高值（不要手改单个文件）`;
    for (const problem of problems) problem.message = `${problem.message}；${hint}`;
  }

  return problems;
}

/**
 * 把所有版本声明**对齐**到指定值（不要求当前值等于某个旧值）。
 *
 * 用于「历史已经分叉」的收口：某些扩展的来源元数据被单独维护过（如 2.2.0），而分发版本从未声明
 * 过（补成 0.1.0）。此时只能用对齐——按旧值替换的 `writeVersionDeclarations` 改不到那些分叉项。
 *
 * 目标值通常取各处声明的**最大值**：展示版本不变（用户看不到突然降级），升级判定也拿到同一个
 * 数字，之后 bump 从这个值继续单调递增。
 */
export function alignVersionDeclarations(declarations, targetVersion) {
  if (!isStrictVersion(targetVersion)) {
    throw new Error(`对齐目标不是严格三段 semver：${String(targetVersion)}`);
  }
  const { descriptorPath, packagePath, descriptor, packageJson, dir } = declarations;
  const changed = [];

  // 就地改写，不重新序列化：紧凑写法必须原样保留（见 json-version-rewrite.mjs 的说明）。
  const descriptorText = fs.readFileSync(descriptorPath, "utf8");
  const descriptorNext = rewriteJsonVersionLiterals(descriptorText, {
    top: targetVersion,
    site: descriptor.site ? targetVersion : undefined,
    insertTop: descriptor.version === undefined ? targetVersion : undefined
  });
  if (descriptorNext.changed) changed.push({ file: descriptorPath, contents: descriptorNext.text });

  const packageText = fs.readFileSync(packagePath, "utf8");
  const packageNext = rewriteJsonVersionLiterals(packageText, {
    top: targetVersion,
    insertTop: packageJson.version === undefined ? targetVersion : undefined
  });
  if (packageNext.changed) changed.push({ file: packagePath, contents: packageNext.text });

  for (const source of metadataSources(dir, descriptor)) {
    const range = metadataObjectRange(source.text, source.exportName);
    if (!range) continue;
    const slice = source.text.slice(range.start, range.end);
    // 对齐语义：元数据对象内的每一条 version 字面量都设成目标值，不按旧值过滤。
    let touched = false;
    const next = slice.replace(VERSION_LITERAL, (whole, prefix, quote, value) => {
      if (value === targetVersion) return whole;
      touched = true;
      return `${prefix}${quote}${targetVersion}${quote}`;
    });
    if (touched) {
      changed.push({ file: path.join(dir, source.file), contents: source.text.slice(0, range.start) + next + source.text.slice(range.end) });
    }
  }

  const staged = changed.map((entry) => {
    const temporary = `${entry.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, entry.contents, "utf8");
    return { ...entry, temporary };
  });
  for (const entry of staged) fs.renameSync(entry.temporary, entry.file);
  return changed.map((entry) => path.relative(dir, entry.file));
}

/** 各处声明的版本里最大的那个（非法值忽略）；没有可比的值时返回 null。 */
export function highestDeclaredVersion(declarations) {
  const candidates = [
    declarations.distributionVersion,
    declarations.packageJson?.version,
    declarations.descriptor?.site?.version,
    ...(declarations.metadataVersions ?? []).map((entry) => entry.value)
  ].filter((value) => isStrictVersion(value));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, value) => (compareVersions(value, best) > 0 ? value : best));
}

/**
 * 把版本声明一次性写到磁盘。
 *
 * 先写临时文件再 rename：任一 rename 失败不会让某个文件处于"写了一半"的状态。四处不一致会被
 * 下一次预检立刻抓到，因此失败是可见的，不会静默留下半成品。
 *
 * 返回 `{ changed: [...相对路径] }`。
 */
export function writeVersionDeclarations(declarations, nextVersion) {
  const { descriptorPath, packagePath, descriptor, packageJson, dir } = declarations;
  const previous = descriptor.version;
  const changed = [];

  // 就地改写，不重新序列化：仓库里的 extension.json 大量使用紧凑嵌套写法，整文件
  // `JSON.stringify(..., null, 2)` 会把它们展开成几十行格式噪音（见 json-version-rewrite.mjs）。
  const descriptorNext = rewriteJsonVersionLiterals(fs.readFileSync(descriptorPath, "utf8"), {
    top: nextVersion,
    site: descriptor.site ? nextVersion : undefined
  });
  if (descriptorNext.changed) changed.push({ file: descriptorPath, contents: descriptorNext.text });

  const packageNext = rewriteJsonVersionLiterals(fs.readFileSync(packagePath, "utf8"), { top: nextVersion });
  if (packageNext.changed) changed.push({ file: packagePath, contents: packageNext.text });

  // 源码只改**元数据对象内部**的 version 字面量（不是整个文件）。
  for (const source of metadataSources(dir, descriptor)) {
    const range = metadataObjectRange(source.text, source.exportName);
    if (!range) continue;
    const { source: next, count } = replaceVersionLiteralsInRange(source.text, range, previous, nextVersion);
    if (count > 0 && next !== source.text) changed.push({ file: path.join(dir, source.file), contents: next });
  }

  // 全部内容先落到同目录临时文件，再逐个 rename。
  const staged = changed.map((entry) => {
    const temporary = `${entry.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, entry.contents, "utf8");
    return { ...entry, temporary };
  });
  for (const entry of staged) fs.renameSync(entry.temporary, entry.file);
  return changed.map((entry) => path.relative(dir, entry.file));
}

/** 取提交信息首行（无 git 或无提交时返回空串，不阻断 bump）。 */
export function headCommitSubject(repoRoot) {
  try {
    return execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

/** 追加一条 CHANGELOG 记录（文件不存在时按标题建）。返回写入的相对路径。 */
export function appendChangelog(dir, { from, to, note, date = new Date() }) {
  const file = path.join(dir, "CHANGELOG.md");
  const day = date.toISOString().slice(0, 10);
  const line = `- ${day} \`${to}\`（上一版 \`${from}\`）${note ? `：${note}` : ""}`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# CHANGELOG\n\n## ${to}\n\n${line}\n`, "utf8");
    return "CHANGELOG.md";
  }
  const source = fs.readFileSync(file, "utf8");
  const heading = `## ${to}\n`;
  const next = source.includes(heading)
    ? source.replace(heading, `${heading}\n${line}\n`)
    : `${source.trimEnd()}\n\n${heading}\n${line}\n`;
  fs.writeFileSync(file, next, "utf8");
  return "CHANGELOG.md";
}

/**
 * 基线之后该目录是否有改动。
 *
 * 用 git 而不是 mtime：版本单调性需要跨 checkout / 跨 clone 复现，mtime 在 CI 上不可靠
 * （见 design D3）。`base` 无法解析时返回 `{ available: false }`，调用方按"跳过"处理。
 */
export function changedSince({ repoRoot, base, dir }) {
  if (!base) return { available: false, reason: "未提供 --bump-base" };
  const run = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    return { available: false, reason: `无法解析基线 ${base}`, invalidBase: true };
  }
  const relative = path.relative(repoRoot, path.resolve(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { available: false, reason: `目录不在仓库内：${dir}` };
  }
  try {
    // `git diff` 看不到未跟踪文件：新建的扩展目录在 `git add` 之前是 untracked 的，
    // 只看 diff 会让「新扩展还没 bump」漏检。两条命令合起来才是"相对基线的改动"。
    const tracked = run(["diff", "--name-only", base, "--", relative]);
    const untracked = run(["ls-files", "--others", "--exclude-standard", "--", relative]);
    const changed = [...new Set([...tracked.split("\n"), ...untracked.split("\n")].map((line) => line.trim()).filter(Boolean))].sort();
    return { available: true, changed };
  } catch (error) {
    return { available: false, reason: `git diff 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 基线上该扩展的分发版本；读不到返回 null（调用方退化为「只看有没有改动」）。 */
export function versionAtBase({ repoRoot, base, dir }) {
  try {
    const relative = path.relative(repoRoot, path.resolve(dir)).split(path.sep).join("/");
    const output = execFileSync("git", ["show", `${base}:${relative}/extension.json`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const version = JSON.parse(output)?.version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 「改了代码但没发版」的判定。
 *
 * 这是预检门禁与发布门禁的**同一处**判断，两处各写一遍必然漂移：预检说"该 bump"、
 * 发布说"可以发"就是自相矛盾的结论。
 *
 * - `skipped`：没有可用基线（或基线上读不到该扩展的声明），调用方按"跳过"处理；
 * - `changed`：基线之后有改动，且分发版本与基线相同。
 */
export function unreleasedChanges({ repoRoot, base, dir, currentVersion }) {
  const check = changedSince({ repoRoot, base, dir });
  if (!check.available) return { ...check, changed: [] };
  if (check.changed.length === 0) return { ...check, changed: [], bumped: true };
  const previous = versionAtBase({ repoRoot, base, dir });
  // 基线上根本没有这个扩展（新增目录）：首次发版不需要"推进"一个不存在的版本。
  if (previous === null) return { ...check, previous: null, bumped: true };
  return { ...check, previous, bumped: previous !== currentVersion };
}
