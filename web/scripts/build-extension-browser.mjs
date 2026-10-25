#!/usr/bin/env node
/**
 * 单 extension 独立 browser build（change: 2026-10-12-build-and-load-extensions-independently，
 * 任务 3.1–3.5、3.8 / design D1/D3/D5）。
 *
 *   node scripts/build-extension-browser.mjs [--cwd <extensionDir>] [--all] [--watch] [--outdir browser-dist]
 *
 * `--all` 构建 workspace 内所有具备约定 browser 入口的生产扩展（稳定排序；fixture/仅后端包跳过）。
 *
 * 产出（`browser-dist/`，不清除后端/包 `dist/`）：
 * - 薄 ESM activation 入口（`entry-<hash>.js`）：只静态依赖私有 runtime-binding 与纯 metadata，
 *   导出 `loadExtension(bindings)`；绑定宿主 runtime 后才动态 import 实现。
 * - implementation / private chunks：由 esbuild code splitting 生成，相对 ESM import。
 * - 完整样式（`styles-<hash>.css`，`cssCodeSplit` 语义 = 单文件）。
 * - `metadata.json` 与 `artifact-manifest.json`（schema/ABI/文件 hash/大小/raw+gzip/requirements）。
 *
 * 约束（design D2/D3）：
 * - React / `react/jsx-runtime` / `@woohaa3/frontend/extension-api` 经生成的具名 shim 解析为宿主
 *   runtime 绑定；MUST NOT 内联第二份 React/SDK/Cordis。
 * - `@deepseek-ai/cordis` 只允许 type-only（运行时被擦除）；node builtin、后端 SDK、宿主私有路径
 *   与其他 extension 业务源码一律拒绝。
 * - `@woohaa3/contracts` 的 browser-safe 纯函数按需 tree-shake 进产物。
 * - extension 私有 dynamic import（如 mediabunny）保持独立异步 chunk。
 * - 可复现：artifactId 由全部输出内容与规范化 metadata/ABI 确定性计算，不含时间/绝对路径。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

import {
  ExtensionScanError,
  browserExtensions,
  checkRootsCoveredByWorkspace,
  formatWorkspaceCoverageHint,
  readExtensionDescriptor,
  scanExtensions
} from "../../scripts/lib/extension-scan.mjs";
import { validateExtensionDescriptor } from "../../scripts/lib/extension-descriptor.mjs";
import { extensionIconPublicPath } from "../../scripts/lib/extension-icon-assets.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..");

const EXTENSION_API_SPECIFIER = "@woohaa3/frontend/extension-api";
const CONTRACTS_SPECIFIER = "@woohaa3/contracts";
const CORDIS_SPECIFIER = "@deepseek-ai/cordis";
const REACT_SPECIFIER = "react";
const JSX_RUNTIME_SPECIFIER = "react/jsx-runtime";
const JSX_DEV_RUNTIME_SPECIFIER = "react/jsx-dev-runtime";
const PROTOCOL_VERSION = 1;
const SDK_ABI_VERSION = 1;
const REACT_MAJOR = 18;
const SDK_GROUPS = ["core", "ui", "model", "authoring"];

/** 禁止进入 browser 产物的依赖（后端 SDK/Node/宿主私有/其他扩展）。 */
const FORBIDDEN_PACKAGES = [
  "@woohaa3/backend",
  "@woohaa3/canvas-service",
  "@woohaa3/task-service",
  "@woohaa3/media-service",
  "@woohaa3/mcp-service",
  "@woohaa3/application-service",
  "@openai/codex-sdk",
  "jose",
  "mongodb",
  "cos-nodejs-sdk-v5",
  "@sdppp/pptask",
  "@sdppp/pptask-worker-server"
];

/** 允许内联的裸依赖（extension 私有 browser 依赖 / 纯 contracts）；其余裸依赖拒绝。 */
const ALLOWED_BUNDLED_PACKAGES = [
  CONTRACTS_SPECIFIER,
  "mediabunny",
  "lib0",
  "yjs"
];

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const extensionDir = path.resolve(readArg("cwd") ?? process.cwd());
const outDirName = readArg("outdir") ?? "browser-dist";
const watch = process.argv.includes("--watch");
const outDir = path.join(extensionDir, outDirName);
const stagingDir = path.join(extensionDir, ".browser-build");

const ENTRY_SOURCE = path.join(extensionDir, "src", "frontend", "index.ts");
const METADATA_SOURCE = path.join(extensionDir, "src", "frontend", "metadata.ts");
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// 生成物：runtime-binding、dependency shims、薄入口
// ---------------------------------------------------------------------------

const RUNTIME_BINDING_SOURCE = `/**
 * 生成物：artifact 私有的 app-level runtime binding（change: 2026-10-12-...）。
 * 唯一 binding 实例；薄入口与全部 shim 引用同一模块，禁止跨 artifact/跨 app 覆盖。
 */
let bound = null;
export function bindRuntime(next) {
  if (!next || typeof next !== "object") throw new TypeError("extension runtime bindings 非法");
  if (!next.token || typeof next.token !== "object") throw new TypeError("extension runtime token 非法");
  if (bound && bound.token !== next.token) {
    throw new Error("extension runtime binding 冲突：不同 app runtime token");
  }
  bound = next;
}
export function getRuntime() {
  if (!bound) throw new Error("extension runtime 尚未绑定");
  return bound;
}
export function isBound() { return bound !== null; }
`;

function shimSource(target, names) {
  const lines = [
    `/** 生成物：把 ${target} 的具名导入解析为宿主 runtime 绑定（真实引用，禁止内联第二份实现）。 */`,
    `import { getRuntime } from "./runtime-binding.js";`,
    // 顶层执行发生在 bindRuntime 之后（shim 只被动态 import 的实现 chunk 引用），
    // 因此这里可以安全地读取真实引用并直接转出——保持 hooks/class/组件同一实例。
    `const runtime = getRuntime();`
  ];
  for (const name of names) {
    lines.push(`export const ${name} = runtime.${target}[${JSON.stringify(name)}];`);
  }
  lines.push(`export default runtime.${target};`);
  return lines.join("\n");
}

/** TypeScript 编译器（AST 解析 SDK 运行时需求；不放宽为文本匹配）。 */
let tsModulePromise = null;
function loadTypescript(baseDir) {
  if (!tsModulePromise) {
    // extension 包各自声明 typescript devDependency；回退到宿主目录解析。
    const bases = [baseDir, path.join(WEB_DIR, "frontend"), WEB_DIR];
    let resolved = null;
    for (const base of bases) {
      try {
        resolved = createRequire(path.join(base, "package.json")).resolve("typescript");
        break;
      } catch {
        // 尝试下一个 base。
      }
    }
    if (!resolved) throw new Error("extension browser build 需要 typescript（AST 依赖分析）");
    tsModulePromise = import(pathToFileURL(resolved).href);
  }
  return tsModulePromise;
}

/**
 * 用 TS AST 收集扩展实现真正从公共 API 请求的**具名**运行时导出。
 *
 * - 只有 `ImportDeclaration`/`ExportDeclaration` 的 module specifier 命中公共入口才计入，
 *   文档注释/字符串中的同名文本不会被误判（implementation-guide §2 要求 AST，不用正则替换）；
 * - `import type` / 具名 `type X` 规格子句 / `export type` 不形成运行时需求（type-only 擦除）；
 * - namespace（`import * as`）与 default（`import X`）运行时导入首期拒绝（design D2）；
 * - `export { X } from "@woohaa3/frontend/extension-api"` 的具名转出是运行时需求。
 */
async function collectSdkRequirements(entryFiles, baseDir) {
  const ts = await loadTypescript(baseDir);
  const names = new Set();
  const namespaceImports = [];
  const isSdk = (specifier) => specifier === EXTENSION_API_SPECIFIER;
  const collectNames = (bindingNames) => {
    for (const name of bindingNames) {
      if (name) names.add(name);
    }
  };
  for (const file of entryFiles) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier) || !isSdk(specifier.text)) continue;
        const clause = statement.importClause;
        if (!clause) continue; // 副作用导入：无运行时具名需求
        if (clause.isTypeOnly) continue;
        if (clause.name) namespaceImports.push(file); // default import
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          namespaceImports.push(file); // import * as
        } else if (bindings && ts.isNamedImports(bindings)) {
          collectNames(bindings.elements.filter((el) => !el.isTypeOnly).map((el) => el.propertyName?.text ?? el.name.text));
        }
      } else if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !isSdk(specifier.text)) continue;
        if (statement.isTypeOnly) continue;
        const bindings = statement.exportClause;
        if (bindings && ts.isNamedExports(bindings)) {
          collectNames(bindings.elements.filter((el) => !el.isTypeOnly).map((el) => el.propertyName?.text ?? el.name.text));
        } else if (bindings && ts.isNamespaceExport(bindings)) {
          namespaceImports.push(file);
        }
      }
    }
  }
  return { names: [...names].sort(), namespaceImports };
}

/** Follow local runtime dependencies from the stable facade across responsibility directories. */
async function collectFrontendSources(entrySource, baseDir) {
  const ts = await loadTypescript(baseDir);
  const visited = new Set();
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX
  };
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const follow = (specifier) => {
      if (!specifier.startsWith(".")) return;
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
      if (resolved && !resolved.resolvedFileName.endsWith(".d.ts")) visit(resolved.resolvedFileName);
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.importClause?.isTypeOnly) follow(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.isTypeOnly) follow(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        follow(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entrySource);
  return [...visited].sort();
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function classifyFile(relative, entryRelative) {
  if (relative === entryRelative) return "entry";
  if (relative.endsWith(".css")) return "style";
  if (relative.endsWith(".map")) return "sourcemap";
  if (relative.endsWith(".js")) return "private-chunk";
  return "asset";
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/**
 * 运行一次 browser build。`cwd` 为 extension 目录。
 */
export async function buildExtensionBrowser(options = {}) {
  const dir = options.cwd ?? extensionDir;
  const targetOut = options.outDir ?? path.join(dir, options.outDirName ?? "browser-dist");
  const targetStaging = options.stagingDir ?? path.join(dir, ".browser-build");
  const entrySource = options.entrySource ?? path.join(dir, "src", "frontend", "index.ts");
  const metadataSource = options.metadataSource ?? path.join(dir, "src", "frontend", "metadata.ts");

  if (!existsSync(entrySource)) throw new Error(`缺少约定前端入口：${entrySource}`);
  if (!existsSync(metadataSource)) throw new Error(`缺少纯 metadata：${metadataSource}`);

  const sources = await collectFrontendSources(entrySource, dir);
  const { names: sdkNames, namespaceImports } = await collectSdkRequirements(sources, dir);
  if (namespaceImports.length > 0) {
    throw new Error(
      `extension 前端使用 SDK namespace/default 导入（首期不支持，请改为具名导入）：\n` +
        namespaceImports.map((file) => `  ${path.relative(dir, file)}`).join("\n")
    );
  }

  // 生成 staging 源码。browser-dist 是 builder 独占产物目录：每次构建先清空，避免
  // 旧 entry/chunk hash 残留（manifest 与 artifactId 只反映本次输入，复现性要求目录无陈旧文件）。
  await fs.rm(targetStaging, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  await fs.mkdir(targetStaging, { recursive: true });
  await fs.rm(targetOut, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  await fs.mkdir(targetOut, { recursive: true });
  // 先求值纯 metadata（唯一身份来源），薄入口内联其值，避免入口静态依赖 metadata 模块。
  const metadataValue = await evaluateMetadata(metadataSource, targetStaging);
  // 声明与实现的身份交叉校验：extension.json 是宿主注册表的事实来源，metadata 是浏览器侧唯一身份；
  // 两者不一致时构建失败并指出目录，避免「登记了 A、浏览器实现为 B」的静默错位（任务 2.3）。
  assertDescriptorMetadataIdentity(dir, metadataValue.extensionId);
  // 品牌图形：扩展包内资产 → 约定逻辑路径，注入 metadata（浏览器侧扩展行也用它，扩展源码不写死路径）。
  const declaredIcon = extensionIconPublicPath(readExtensionDescriptor(dir).descriptor ?? {}, metadataValue.extensionId);
  if (declaredIcon) metadataValue.icon = declaredIcon;
  const rel = (from) => {
    const value = path.relative(targetStaging, from).split(path.sep).join("/");
    return value.startsWith(".") ? value : `./${value}`;
  };
  await fs.writeFile(path.join(targetStaging, "runtime-binding.js"), RUNTIME_BINDING_SOURCE, "utf8");
  await fs.writeFile(
    path.join(targetStaging, "shim-react.js"),
    shimSource("react", options.reactNames ?? ["createElement", "useId", "useState", "useEffect", "useSyncExternalStore", "useCallback", "useMemo", "useRef", "useLayoutEffect", "useContext", "useReducer", "cloneElement", "isValidElement", "forwardRef", "memo", "createContext", "Fragment", "Children", "Component", "startTransition"]),
    "utf8"
  );
  await fs.writeFile(
    path.join(targetStaging, "shim-jsx-runtime.js"),
    shimSource("jsxRuntime", ["jsx", "jsxs", "Fragment", "jsxDEV"]),
    "utf8"
  );
  await fs.writeFile(
    path.join(targetStaging, "thin-entry.ts"),
    [
      `import { bindRuntime } from "./runtime-binding.js";`,
      `export const extensionMetadata = ${JSON.stringify(metadataValue)};`,
      `export async function loadExtension(bindings) {`,
      `  bindRuntime(bindings);`,
      `  const mod = await import(${JSON.stringify(rel(entrySource).replace(/\.ts$/, ".js"))});`,
      `  const descriptor = mod.descriptor;`,
      `  return { descriptor };`,
      `}`,
    ].join("\n"),
    "utf8"
  );

  // dependency shim 插件：把公共 bare 说明符重定向到生成的 shim / 拒绝路径。
  const shimPlugin = {
    name: "woohaa-extension-runtime-shims",
    setup(build) {
      const redirect = (filter, target) => {
        build.onResolve({ filter: new RegExp(`^${filter}$`) }, (args) => ({ path: path.join(targetStaging, target) }));
      };
      redirect(REACT_SPECIFIER, "shim-react.js");
      redirect(JSX_RUNTIME_SPECIFIER, "shim-jsx-runtime.js");
      redirect(JSX_DEV_RUNTIME_SPECIFIER, "shim-jsx-runtime.js");
      build.onLoad({ filter: /shim-(react|jsx-runtime)\.js$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8"),
        loader: "js",
        resolveDir: path.dirname(args.path)
      }));
      build.onLoad({ filter: /runtime-binding\.js$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8"),
        loader: "js",
        resolveDir: path.dirname(args.path)
      }));
      // extension-api 公共入口：解析到 shim，具名导出经宿主 runtime sdk。
      build.onResolve({ filter: /^@woohaa3\/frontend\/extension-api$/ }, () => ({
        path: path.join(targetStaging, "shim-extension-api.js")
      }));
      build.onLoad({ filter: /shim-extension-api\.js$/ }, () => ({
        contents: [
          `/** 生成物：把 @woohaa3/frontend/extension-api 具名导入解析为宿主 runtime sdk（真实引用）。 */`,
          `import { getRuntime } from "./runtime-binding.js";`,
          `const sdk = getRuntime().sdk;`,
          ...sdkNames.map((name) => `export const ${name} = sdk[${JSON.stringify(name)}];`)
        ].join("\n"),
        loader: "js",
        resolveDir: targetStaging
      }));
    }
  };

  // 守卫插件：拒绝禁止依赖 / 未声明裸依赖 / node builtin / 其他 extension 源码。
  const guardPlugin = {
    name: "woohaa-extension-dependency-guard",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const specifier = args.path;
        if (specifier.startsWith("node:") || specifier === "fs" || specifier === "path" || specifier === "crypto") {
          return { errors: [{ text: `extension browser build 不允许 Node builtin：${specifier}` }] };
        }
        if (FORBIDDEN_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
          return { errors: [{ text: `extension browser build 拒绝后端/宿主依赖：${specifier}` }] };
        }
        if (specifier.startsWith("@woohaa3/extension-")) {
          return { errors: [{ text: `extension browser build 不得引用其他 extension：${specifier}` }] };
        }
        if (specifier === CORDIS_SPECIFIER) {
          return { errors: [{ text: `extension browser build 不允许运行时 Cordis 导入（仅 type-only）` }] };
        }
        if (specifier === CONTRACTS_SPECIFIER || specifier.startsWith(`${CONTRACTS_SPECIFIER}/`)) {
          // 重新指向 contracts 源码，使纯函数按需 tree-shake（而非整包 dist 内联）。
          const rel = specifier === CONTRACTS_SPECIFIER ? "src/index.ts" : specifier.slice(CONTRACTS_SPECIFIER.length + 1);
          return { path: path.join(REPO_ROOT, "web/contracts", rel) };
        }
        if (ALLOWED_BUNDLED_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
          return undefined; // 交由 esbuild 正常打包（保持 splitting/按需）。
        }
        if (specifier.startsWith("@woohaa3/")) {
          return { errors: [{ text: `extension browser build 未知 workspace 依赖：${specifier}` }] };
        }
        return undefined; // 其它 npm 依赖按 extension 声明内联（mediabunny 等）。
      });
    }
  };

  const buildResult = await esbuild.build({
    entryPoints: [path.join(targetStaging, "thin-entry.ts")],
    outdir: targetOut,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxDev: false,
    define: {
      "process.env.NODE_ENV": '"production"'
    },
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "entry-[hash]",
    assetNames: "assets/[name]-[hash]",
    // 输出内容**不含绝对路径/时间**：chunk hash 只由内容派生，保证同输入跨 cwd 可复现
    // （否则 content hash 会被 esbuild 内部的路径输入污染，artifactId 漂移）。
    absWorkingDir: targetStaging,
    // 单文件 CSS：内部 lazy UI 的样式也纳入同一 stylesheet，避免原生动态 import 丢样式。
    loader: {
      ".css": "css"
    },
    minify: true,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
    plugins: [shimPlugin, guardPlugin],
    ...(options.esbuild ? options.esbuild : {})
  });

  // CSS 输出可能为 styles-*.css（由 esbuild 抽取）。收集全部输出。
  const metafile = buildResult.metafile;
  // esbuild metafile 输出路径相对 `absWorkingDir`（= targetStaging）；统一以其为基准解析。
  const metafileBase = targetStaging;
  const outputFiles = Object.keys(metafile.outputs).filter((file) => {
    const abs = path.resolve(metafileBase, file);
    return abs.startsWith(path.resolve(targetOut));
  });

  const fileRecords = [];
  let entryRelative = null;
  let stylesheetRelative = null;
  for (const file of outputFiles) {
    const abs = path.resolve(metafileBase, file);
    const relative = path.relative(targetOut, abs).split(path.sep).join("/");
    const bytes = await fs.readFile(abs);
    const kind = classifyFile(relative, null);
    if (relative.endsWith(".js") && relative.startsWith("entry-") && !entryRelative) entryRelative = relative;
    if (relative.endsWith(".css") && !stylesheetRelative) stylesheetRelative = relative;
    fileRecords.push({
      relative,
      abs,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: sha256Hex(bytes),
      kind
    });
  }
  // Optional package-owned iframe/WASM resources. No host-specific source paths or editor names.
  const publicRoot = path.join(dir, "public");
  async function publishAssets(folder, prefix = "") {
    if (!existsSync(folder)) return;
    for (const file of (await fs.readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const relative = `assets/${prefix}${file.name}`;
      if (file.isSymbolicLink()) throw new Error(`Extension public asset must not be a symlink: ${relative}`);
      if (file.isDirectory()) { await publishAssets(path.join(folder, file.name), `${prefix}${file.name}/`); continue; }
      if (!file.isFile()) throw new Error(`Invalid extension public asset: ${relative}`);
      const abs = path.join(targetOut, relative);
      if (existsSync(abs)) throw new Error(`Extension public asset collision: ${relative}`);
      const bytes = await fs.readFile(path.join(folder, file.name));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      fileRecords.push({ relative, abs, bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
        sha256: sha256Hex(bytes), kind: "asset" });
    }
  }
  if (existsSync(publicRoot) && (await fs.lstat(publicRoot)).isSymbolicLink()) throw new Error("Extension public asset root must not be a symlink");
  await publishAssets(publicRoot);
  if (!entryRelative) throw new Error("browser build 未产出 entry-*.js 薄入口");
  // 修正 entry 分类。
  for (const record of fileRecords) {
    if (!record.relative.startsWith("assets/")) record.kind = classifyFile(record.relative, entryRelative);
  }
  const styles = stylesheetRelative ? [stylesheetRelative] : [];

  // 依赖图：从打包器 metafile 读取真实 import 边（不用文本正则，避免误判字符串）。
  // 目标若在本次输出集合内 → resolved 为相对路径；否则视为外部依赖（list 为 null，装配时必须为空）。
  const outputSet = new Set(fileRecords.map((record) => record.relative));
  const imports = [];
  for (const file of outputFiles) {
    const abs = path.resolve(metafileBase, file);
    const from = path.relative(targetOut, abs).split(path.sep).join("/");
    const output = metafile.outputs[file];
    if (!output) continue;
    for (const edge of output.imports ?? []) {
      const targetAbs = path.resolve(metafileBase, edge.path);
      const targetRel = path.relative(targetOut, targetAbs).split(path.sep).join("/");
      const internal = edge.external ? null : outputSet.has(targetRel) ? targetRel : null;
      imports.push({ from, specifier: edge.path, resolved: internal });
    }
  }
  imports.sort((a, b) => (a.from === b.from ? (a.specifier < b.specifier ? -1 : 1) : a.from < b.from ? -1 : 1));
  const externalEdges = imports.filter((edge) => edge.resolved === null);
  if (externalEdges.length > 0) {
    throw new Error(
      `browser artifact 残留外部依赖（MUST 全部内联或由 shim 解析）：\n` +
        externalEdges.map((edge) => `  ${edge.from} -> ${edge.specifier}`).join("\n")
    );
  }

  // artifactId：由全部输出内容 + 规范 metadata/ABI + 依赖图确定性计算。
  const artifactInput = [
    `protocol=${PROTOCOL_VERSION}`,
    `sdkAbi=${SDK_ABI_VERSION}`,
    `reactMajor=${REACT_MAJOR}`,
    `metadata=${canonicalJson(metadataValue)}`,
    ...fileRecords
      .map((record) => `${record.relative}:${record.bytes}:${record.sha256}`)
      .sort(),
    ...imports.map((edge) => `${edge.from}->${edge.resolved}`).sort()
  ].join("\n");
  const artifactId = sha256Hex(Buffer.from(artifactInput, "utf8"));

  const manifest = {
    schemaVersion: PROTOCOL_VERSION,
    artifactId,
    metadata: metadataValue,
    protocolVersion: PROTOCOL_VERSION,
    sdkAbi: SDK_ABI_VERSION,
    reactMajor: REACT_MAJOR,
    entry: entryRelative,
    styles,
    requiredSdkGroups: SDK_GROUPS,
    requiredSdkExports: sdkNames,
    files: fileRecords.map((record) => ({
      path: record.relative,
      bytes: record.bytes,
      gzipBytes: record.gzipBytes,
      sha256: record.sha256,
      kind: record.kind
    })),
    imports
  };

  await fs.writeFile(path.join(targetOut, "metadata.json"), JSON.stringify(metadataValue, null, 2), "utf8");
  await fs.writeFile(path.join(targetOut, "artifact-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await fs.rm(targetStaging, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });

  return { artifactId, entry: entryRelative, styles, manifest, outDir: targetOut };
}

/** 用 esbuild 单独打包 metadata 并动态 import 求值（不触碰实现）。 */
async function evaluateMetadata(metadataSource, stagingDir) {
  const outfile = path.join(stagingDir, `metadata-out-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [metadataSource],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent"
  });
  const mod = await import(pathToFileURL(outfile).href);
  const value = mod.metadata ?? mod.FRONTEND_METADATA ?? Object.values(mod).find((entry) => entry && typeof entry === "object" && entry.extensionId);
  if (!value || typeof value.extensionId !== "string") {
    throw new Error(`metadata 模块必须导出含 extensionId 的纯 metadata：${metadataSource}`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  if (watch) {
    console.error("[extension-browser] --watch 由 dev 编排使用；此处执行一次构建后退出。");
  }
  if (process.argv.includes("--all")) {
    // 构建全部具备约定入口与纯 metadata 的生产扩展（fixture/仅后端包自动跳过）。
    const results = [];
    for (const entry of await discoverBrowserExtensions()) {
      const targetOut = path.join(entry.dir, outDirName);
      const result = await buildExtensionBrowser({
        cwd: entry.dir,
        outDir: targetOut,
        stagingDir: path.join(entry.dir, ".browser-build")
      });
      console.log(
        `[extension-browser] ${path.relative(REPO_ROOT, targetOut)} artifactId=${result.artifactId.slice(0, 12)} entry=${result.entry}`
      );
      results.push(result);
    }
    if (results.length === 0) throw new Error("未发现可构建的 browser extension（需 src/frontend/index.ts 与 metadata.ts）");
    return;
  }
  const result = await buildExtensionBrowser({ cwd: extensionDir, outDir, stagingDir });
  console.log(
    `[extension-browser] ${path.relative(REPO_ROOT, outDir)} artifactId=${result.artifactId.slice(0, 12)} entry=${result.entry}`
  );
}

/** 发现 workspace 内所有具备约定 browser 入口的扩展目录（稳定排序）。 */
/** 发现配置根内所有具备约定 browser 入口的扩展目录（多根、`.` 跳过、稳定排序）。 */
async function discoverBrowserExtensions() {
  const scan = scanExtensions({ repoRoot: REPO_ROOT });
  const coverage = checkRootsCoveredByWorkspace({ repoRoot: REPO_ROOT, roots: scan.roots });
  const hint = formatWorkspaceCoverageHint(coverage, { repoRoot: REPO_ROOT });
  if (hint) process.stderr.write(`${hint}\n`);
  return browserExtensions(scan).map((extension) => ({
    directory: extension.directory,
    dir: extension.dir,
    extensionId: extension.extensionId,
    root: extension.root
  }));
}

/**
 * 声明与浏览器 metadata 身份交叉校验（任务 2.3）。
 *
 * 无 `extension.json` 的纯浏览器扩展跳过；有声明时不允许多字段语义下的身份分叉。
 */
function assertDescriptorMetadataIdentity(dir, metadataExtensionId) {
  const { descriptor, descriptorPath } = readExtensionDescriptor(dir);
  if (!descriptorPath) return;
  const validated = validateExtensionDescriptor(descriptor);
  if (!validated.ok) {
    throw new ExtensionScanError("EXTENSION_DESCRIPTOR_INVALID", `${descriptorPath} 声明无效：\n  ${validated.errors.join("\n  ")}`);
  }
  if (validated.value.extensionId !== metadataExtensionId) {
    throw new ExtensionScanError(
      "EXTENSION_DESCRIPTOR_IDENTITY_MISMATCH",
      `扩展声明与浏览器 metadata 身份不一致：${path.basename(dir)} 声明 extensionId=${validated.value.extensionId}，` +
        `metadata 为 ${metadataExtensionId}（${descriptorPath}）`
    );
  }
}

if (isMain) {
  main().catch((error) => {
    console.error(`[extension-browser] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
