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
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { uiPublicApi } from "../ui/scripts/public-api.mjs";

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
const REACT_DOM_SPECIFIER = "react-dom";
const REACT_DOM_CLIENT_SPECIFIER = "react-dom/client";

/**
 * 重定向到宿主实例的 React 具名导出。扩展内联的第三方库（如 antd / rc-*）会按名字取这些导出；
 * 缺失项在 shim 里是静默的 `undefined`（构建期不报错、运行时才暴露），所以新增依赖前先对照
 * 这份清单，宿主 React 18 上实际存在的导出都应当列在这里。
 */
const DEFAULT_REACT_NAMES = [
  "createElement", "useId", "useState", "useEffect", "useSyncExternalStore", "useCallback", "useMemo",
  "useRef", "useLayoutEffect", "useContext", "useReducer", "cloneElement", "isValidElement", "forwardRef",
  "memo", "createContext", "Fragment", "Children", "Component", "startTransition",
  "useImperativeHandle", "useInsertionEffect", "useDeferredValue", "useTransition", "useDebugValue",
  "createRef", "PureComponent", "Suspense", "StrictMode", "Profiler", "lazy", "version"
];

/**
 * `react-dom` 必须由宿主提供：它内部经 `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED` 读取
 * React 的 dispatcher / batch config。内联第二份 react-dom 时，这些内部对象在 shim 上不存在，
 * 扩展实现在**加载阶段**就会抛 `Cannot read properties of undefined (reading 'ReactCurrentBatchConfig')`。
 */
const DEFAULT_REACT_DOM_NAMES = [
  "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED", "version", "createPortal", "flushSync",
  "unstable_batchedUpdates", "findDOMNode"
];
const DEFAULT_REACT_DOM_CLIENT_NAMES = ["createRoot", "hydrateRoot"];
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
    // TS7 的原生包不再提供 JS 编译器 API，构建脚本用 5.x 别名做 AST 依赖分析，
    // 回退到宿主目录解析（旧环境仍可直接解析 typescript）。
    const bases = [baseDir, path.join(WEB_DIR, "frontend"), path.join(WEB_DIR, "tooling"), WEB_DIR];
    let resolved = null;
    for (const name of ["typescript-legacy", "typescript"]) {
      for (const base of bases) {
        try {
          resolved = createRequire(path.join(base, "package.json")).resolve(name);
          break;
        } catch {
          // 尝试下一个 base。
        }
      }
      if (resolved) break;
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
  const uiApi = uiPublicApi(ts);
  const isUi = specifier => specifier === "@woohaa3/ui" || specifier.startsWith("@woohaa3/ui/");
  const isSdk = specifier => specifier === EXTENSION_API_SPECIFIER || isUi(specifier);
  const validateUi = (file, specifier, bindings, typeOnly = false) => {
    if (!isUi(specifier)) return;
    const allowed = uiApi.get(specifier);
    if (!allowed) throw new Error(`${file}: 不支持 UI 子路径/样式导入 ${specifier}`);
    if (!bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
      throw new Error(`${file}: UI ${specifier} 仅支持具名导入/导出，拒绝 namespace/default/side-effect`);
    }
    for (const el of bindings.elements) {
      const name = el.propertyName?.text ?? el.name.text;
      if (!allowed.has(name) || (!typeOnly && !el.isTypeOnly && !allowed.get(name))) {
        throw new Error(`${file}: ${specifier} 未知或非运行时 UI 导出 ${name}`);
      }
    }
  };
  const collectNames = (bindingNames) => {
    for (const name of bindingNames) {
      if (name) names.add(name);
    }
  };
  for (const file of entryFiles) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rejectDynamicUi = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && isUi(node.arguments[0].text)) {
        throw new Error(`${file}: UI 仅支持静态具名导入 ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, rejectDynamicUi);
    };
    rejectDynamicUi(sourceFile);
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier) || !isSdk(specifier.text)) continue;
        const clause = statement.importClause;
        validateUi(file, specifier.text, clause?.name ? undefined : clause?.namedBindings, clause?.isTypeOnly);
        if (!clause) continue;
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
        const bindings = statement.exportClause;
        validateUi(file, specifier.text, bindings, statement.isTypeOnly);
        if (statement.isTypeOnly) continue;
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
 * 扩展自带的构建配置：扩展目录 `package.json` 的 `woohaa.build`。
 *
 * 让「原本为 Vite 写的前端」不改源码就能进扩展构建：
 *   - `define`：`{ "<标识符>": "<JS 表达式>" }`，合并进 esbuild define（如 `import.meta.env.X`）；
 *   - `loader`：`{ ".md": "text" }`，合并进 esbuild loader；
 *   - `plugins`：相对扩展目录的模块路径，default 导出 esbuild 插件（或返回插件的工厂），
 *     追加在宿主的 shim 与依赖守卫**之后**——守卫（node 内置 / 其他扩展 / 后端依赖）照常生效。
 * 只作用于构建期，不进入产物。
 */
async function loadExtensionBuildConfig(dir) {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return { define: {}, loader: {}, plugins: [], nodePaths: [], requiredNonEmpty: [] };
  const config = JSON.parse(readFileSync(file, "utf8"))?.woohaa?.build ?? {};
  const nodePaths = (Array.isArray(config.nodePaths) ? config.nodePaths : []).map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new Error(`woohaa.build.nodePaths 只接受非空字符串：${file}`);
    return path.resolve(dir, entry);
  });
  const asRecord = (value, name) => {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`woohaa.build.${name} 必须是对象：${file}`);
    }
    return value;
  };
  const plugins = [];
  for (const specifier of Array.isArray(config.plugins) ? config.plugins : []) {
    if (typeof specifier !== "string" || !specifier.startsWith(".")) {
      throw new Error(`woohaa.build.plugins 只接受相对扩展目录的路径：${String(specifier)}（${file}）`);
    }
    const mod = await import(pathToFileURL(path.resolve(dir, specifier)).href);
    // 默认导出可以是插件、插件工厂，或工厂返回的插件数组（多插件时按数组声明）。
    const exported = typeof mod.default === "function" ? mod.default({ extensionDir: dir }) : mod.default;
    const list = Array.isArray(exported) ? exported : [exported];
    if (list.length === 0 || list.some((plugin) => !plugin || typeof plugin.setup !== "function")) {
      throw new Error(`woohaa.build.plugins 的模块必须默认导出 esbuild 插件（或插件数组）：${specifier}`);
    }
    plugins.push(...list);
  }
  /*
   * `requiredNonEmpty`：这些键的 define 值不允许是空串。
   *
   * 产物里没有残留不代表值是对的。把 anon key 写成 `""`、或主仓换了后端地址而这里没跟，
   * 断言全绿，扩展却连着另一个 Supabase 项目 / 后端 —— 表现是「令牌无效」「模板与扣费对不上」，
   * 和「漏写 define」一样难查。只对**对外服务地址与凭据**这一类声明，默认不启用。
   */
  const requiredNonEmpty = (Array.isArray(config.requiredNonEmpty) ? config.requiredNonEmpty : []).map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`woohaa.build.requiredNonEmpty 只接受非空字符串：${file}`);
    }
    return entry.trim();
  });
  return {
    define: asRecord(config.define, "define"),
    loader: asRecord(config.loader, "loader"),
    plugins,
    nodePaths,
    requiredNonEmpty
  };
}

/**
 * 运行一次 browser build。`cwd` 为 extension 目录。
 */
export async function buildExtensionBrowser(options = {}) {
  const dir = options.cwd ?? extensionDir;
  const targetOut = options.outDir ?? path.join(dir, options.outDirName ?? "browser-dist");
  const targetStaging = options.stagingDir ?? path.join(dir, ".browser-build");
  const entrySource = options.entrySource ?? path.join(dir, "src", "frontend", "index.ts");
  const metadataSource = options.metadataSource ?? path.join(dir, "src", "frontend", "metadata.ts");
  const extensionBuild = await loadExtensionBuildConfig(dir);

  if (!existsSync(entrySource)) throw new Error(`缺少约定前端入口：${entrySource}`);
  if (!existsSync(metadataSource)) throw new Error(`缺少纯 metadata：${metadataSource}`);

  const uiPublicApiCache = uiPublicApi(await loadTypescript(dir));
  const sources = await collectFrontendSources(entrySource, dir);
  const { names: sdkNames, namespaceImports } = await collectSdkRequirements(sources, dir);
  if (namespaceImports.length > 0) {
    throw new Error(
      `extension 前端使用 SDK namespace/default 导入（首期不支持，请改为具名导入）：\n` +
        namespaceImports.map((file) => `  ${path.relative(dir, file)}`).join("\n")
    );
  }

  // 生成 staging 源码。staging 目录每次重建（它是构建过程的临时工作区，与本目录无关）。
  await fs.rm(targetStaging, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  await fs.mkdir(targetStaging, { recursive: true });
  /*
   * **不要清空 `browser-dist`**（踩过，表现是「改一下扩展代码，四喜整块消失、只剩原生画布」）：
   *
   * 宿主在内存里登记的发布目录是 `URL → browser-dist/<file>` 的绝对路径映射，且**只增不删**。
   * 构建期间如果先 `rm -rf` 再把文件写回来，那么从删空到新 manifest 落盘这整段时间里，
   * 旧 release 指向的每个文件都是 404/500：正在加载的页面拿不到入口，扩展加载失败、
   * 整块界面不渲染。手动在宿主进程外跑一次构建就能稳定复现。
   *
   * 改成就地增量写：`entry-<hash>.js` / `chunks/<name>-<hash>.js` 都是**内容寻址**的，
   * 同名必然同内容，旧文件不会覆盖新文件，也不会污染 artifactId（它由本次的 fileRecords
   * 计算，与目录里残留什么无关）。于是新文件就位前，旧入口始终可读。
   * 陈旧文件由下面的 `pruneStaleOutputs` 在宽限期之后清理，避免长期堆积。
   */
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
    shimSource("react", options.reactNames ?? DEFAULT_REACT_NAMES),
    "utf8"
  );
  await fs.writeFile(
    path.join(targetStaging, "shim-react-dom.js"),
    shimSource("reactDom", options.reactDomNames ?? DEFAULT_REACT_DOM_NAMES),
    "utf8"
  );
  await fs.writeFile(
    path.join(targetStaging, "shim-react-dom-client.js"),
    shimSource("reactDomClient", options.reactDomClientNames ?? DEFAULT_REACT_DOM_CLIENT_NAMES),
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
      redirect(REACT_DOM_SPECIFIER, "shim-react-dom.js");
      redirect(REACT_DOM_CLIENT_SPECIFIER, "shim-react-dom-client.js");
      build.onLoad({ filter: /shim-(react|react-dom|react-dom-client|jsx-runtime)\.js$/ }, (args) => ({
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
      build.onResolve({ filter: /^@woohaa3\/ui(?:\/.*)?$/ }, args => {
        if (!uiPublicApiCache.has(args.path)) return { errors: [{ text: `不支持 UI 子路径/样式导入 ${args.path}` }] };
        return { path: path.join(targetStaging, "shim-extension-api.js") };
      });
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
      "process.env.NODE_ENV": '"production"',
      ...extensionBuild.define
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
      ".css": "css",
      ...extensionBuild.loader
    },
    minify: true,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
    plugins: [shimPlugin, guardPlugin, ...extensionBuild.plugins],
    ...(extensionBuild.nodePaths.length > 0 ? { nodePaths: extensionBuild.nodePaths } : {}),
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
  const styleRelatives = [];
  for (const file of outputFiles) {
    const abs = path.resolve(metafileBase, file);
    const relative = path.relative(targetOut, abs).split(path.sep).join("/");
    const bytes = await fs.readFile(abs);
    const kind = classifyFile(relative, null);
    if (relative.endsWith(".js") && relative.startsWith("entry-") && !entryRelative) entryRelative = relative;
    if (relative.endsWith(".css")) styleRelatives.push(relative);
    fileRecords.push({
      relative,
      abs,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: sha256Hex(bytes),
      kind,
      // JS 原文留在这里：下面的 env 断言要扫它，不必把同一批产物再读一遍（串行 60+ 次）。
      ...(relative.endsWith(".js") ? { text: bytes.toString("utf8") } : {})
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
      const bytes = await fs.readFile(path.join(folder, file.name));
      /*
       * `public/` 资源**不走内容寻址**：产物名沿用源路径（`assets/editor/app.js`），所以
       * 「同名、内容变了」是正常的重新构建，必须覆盖。不清空产物目录之后这条尤其重要
       *（清空时 existsSync 恒为 false，这个检查其实是死代码）。
       *
       * 代价：旧 release 的 artifactId 指向同一磁盘路径，会读到新内容。这比整块 404 好——
       * 宿主指针切到新 release 之前，旧 release 至少仍然可用。
       */
      if (existsSync(abs)) {
        const existing = await fs.readFile(abs);
        if (!existing.equals(bytes)) {
          await fs.writeFile(abs, bytes);
          // 覆盖让 mtime 变新，宽限期清理因此不会误删。
        }
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, bytes);
      }
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
  // 代码分割会产出多份 CSS（入口样式 + 各 chunk 的样式）。只登记第一份会让宿主漏加载
  // 其余的样式表——表现是「部分样式在产物里、浏览器里却没生效」，很难定位。
  // 入口样式表优先，其余按路径排序，保证 artifactId 稳定。
  const styles = [...styleRelatives].sort(
    (a, b) => (a.startsWith("entry-") ? 0 : 1) - (b.startsWith("entry-") ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0)
  );

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

  /*
   * `import.meta.env` 必须被 `woohaa.build.define` 逐条替换干净。
   *
   * 扩展产物跑在宿主页面里，`import.meta.env` 是 **undefined**（不是 Vite 注入的那个对象）。
   * 漏掉一个键，产物里就留下 `import.meta.env.VITE_X`，模块求值直接抛
   * `Cannot read properties of undefined (reading 'VITE_X')` —— 而且是**整块静默消失**：
   * 薄入口能 import、`loadExtension` 也导出着，只有动态 import 的实现 chunk 求值失败，
   * 表现在页面上就是「扩展没生效」，控制台还不一定看得到（被加载器吞成诊断）。
   *
   * 踩过：主仓新增 VITE_PPSERVER_BASE_URL / VITE_SUPABASE_* 三项，这里没同步，四喜整个
   * 外壳不渲染。缺失项在构建期是静默的，所以只能靠这条断言兜住。
   *
   * **只查 esbuild 的产物**：`public/` 下的文件是原样拷贝的（kind `asset`），不经过 esbuild，
   * 里面出现 `import.meta.env` 是它自己的事（例如扩展自带一个 iframe 编辑器脚本），
   * 对它套用 define 校验会把这个扩展永久挡在构建之外。
   */
  const unresolvedEnv = [];
  for (const record of fileRecords) {
    if (record.kind === "asset" || !record.text) continue;
    for (const match of record.text.matchAll(/import\.meta\.env(?:\.[A-Za-z_$][\w$]*)?/g)) {
      unresolvedEnv.push({ file: record.relative, expression: match[0] });
    }
  }
  if (unresolvedEnv.length > 0) {
    // 属性访问与裸对象要分开说：前者补 define 即可，后者 define 逐条列举根本覆盖不了。
    const keyed = [...new Set(unresolvedEnv
      .map((item) => /^import\.meta\.env\.([A-Za-z_$][\w$]*)$/.exec(item.expression)?.[1])
      .filter(Boolean))].sort();
    const bare = [...new Set(unresolvedEnv.filter((item) => !/^import\.meta\.env\./.test(item.expression)).map((item) => item.file))].sort();
    const where = [...new Set(unresolvedEnv.map((item) => item.file))].sort();
    const packageJson = path.relative(REPO_ROOT, path.join(dir, "package.json"));
    const lines = [`browser artifact 残留 import.meta.env（浏览器里它是 undefined，求值期会抛错）：`];
    if (keyed.length > 0) {
      lines.push(`  缺失的 define：${keyed.join(", ")}`);
      // 用本次构建的 `dir`：`--all` 与 watch 重建都是逐个传 cwd，模块级的 extensionDir 这时指向进程 cwd。
      lines.push(`  修法：在 ${packageJson} 的 woohaa.build.define 里补上这些键（取值对齐主仓 src/config/env.ts 的 DEFAULT_*）。`);
    }
    if (bare.length > 0) {
      lines.push(`  裸 import.meta.env 出现在：${bare.join(", ")}`);
      lines.push(`  修法：define 只能逐键替换，裸对象 / 动态键（\`import.meta.env[key]\`）覆盖不了 —— 改成具名常量或显式注入。`);
    }
    lines.push(`  出现在：${where.join(", ")}`);
    throw new Error(lines.join("\n"));
  }

  /*
   * 值校验：`requiredNonEmpty` 声明的键必须有非空 define。
   *
   * 上面那条只管「有没有漏键」，管不了「值对不对」——`"VITE_SUPABASE_ANON_KEY": "\"\""` 一样
   * 不会留下残留。这类漂移不报错，只会让扩展连错后端，排查成本和漏键一样高。
   */
  const blankRequired = extensionBuild.requiredNonEmpty.filter((key) => {
    const expression = extensionBuild.define[`import.meta.env.${key}`];
    if (typeof expression !== "string") return true;
    // define 值是 JS 表达式字面量（`"\"\""` 就是空串），按 JSON 解一次拿到真实值。
    try {
      const value = JSON.parse(expression);
      return typeof value !== "string" || value.trim() === "";
    } catch {
      // 非字面量表达式（如某个变量引用）无法在构建期判定，交给类型与运行时。
      return false;
    }
  });
  if (blankRequired.length > 0) {
    throw new Error(
      `woohaa.build.requiredNonEmpty 声明了这些键，但 define 缺失或为空：\n` +
        `  ${blankRequired.join(", ")}\n` +
        `  在 ${path.relative(REPO_ROOT, path.join(dir, "package.json"))} 里补上形如 "\\"https://…\\"" 的值` +
        `（取值对齐主仓 src/config/env.ts 的 DEFAULT_*）。`
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
  // manifest 落盘之后才能清理陈旧产物（见上方「不要清空 browser-dist」）。
  await pruneStaleOutputs(targetOut, new Set(fileRecords.map((record) => record.relative)));

  return { artifactId, entry: entryRelative, styles, manifest, outDir: targetOut };
}

/**
 * 清理 `browser-dist` 里本次构建不再产出的文件。
 *
 * 只删**足够旧**的：宿主内存里的发布目录只增不删，仍可能被上一版 release 指向，而它要等
 * 宿主重启才重扫。所以留一个宽限期，让正在跑的宿主有时间把指针切到新 release；
 * 过期文件在下次构建时才会被清掉。
 *
 * 只处理两种内容寻址的产物（`entry-<hash>.*` 与 `chunks/`）与 `assets/`；`metadata.json`
 * 与 `artifact-manifest.json` 是固定名，每次覆盖写，不参与清理。
 */
async function pruneStaleOutputs(outDir, keep) {
  const graceMs = Number(process.env.WOOHAA_EXTENSION_PRUNE_GRACE_MS ?? 10 * 60_000);
  const cutoff = Date.now() - graceMs;
  const walk = async (relative) => {
    const absolute = path.join(outDir, relative);
    let entries;
    try { entries = await fs.readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRelative = relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(childRelative); continue; }
      if (!entry.isFile() || keep.has(childRelative)) continue;
      if (!/^(entry-|chunks\/|assets\/)/.test(childRelative)) continue;
      try {
        const stat = await fs.stat(path.join(outDir, childRelative));
        if (stat.mtimeMs < cutoff) await fs.rm(path.join(outDir, childRelative), { force: true });
      } catch {
        /* 删不掉就留给下次构建；陈旧文件不影响正确性 */
      }
    }
  };
  for (const root of ["chunks", "assets"]) await walk(root);
  let top;
  try { top = await fs.readdir(outDir, { withFileTypes: true }); } catch { return; }
  for (const entry of top) {
    if (!entry.isFile() || !entry.name.startsWith("entry-")) continue;
    if (keep.has(entry.name)) continue;
    try {
      const stat = await fs.stat(path.join(outDir, entry.name));
      if (stat.mtimeMs < cutoff) await fs.rm(path.join(outDir, entry.name), { force: true });
    } catch {
      /* 同上 */
    }
  }
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

/**
 * 作者侧增量构建（change: 2026-10-27-add-extension-dev-reload，D2 / 6.1）。
 *
 * 复用同一条构建函数：产物身份、原子写与校验都不另起一套；只把「跑一次」换成「源码变了再跑一次」。
 * 构建失败只记录，不退出——改坏代码时作者应当继续能迭代。
 * 返回的函数用于 Ctrl+C / 测试关闭。
 */
async function watchExtensionBrowser({ dir, outDir, stagingDir, debounceMs = 120, watch: watchFn = fsWatch, log = console }) {
  const sourceRoots = [path.join(dir, "src"), path.join(dir, "package.json"), path.join(dir, "extension.json")];
  let timer = null;
  let running = false;
  let queued = false;

  const build = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const result = await buildExtensionBrowser({ cwd: dir, outDir, stagingDir });
      log.log(
        `[extension-browser] rebuilt ${path.relative(REPO_ROOT, outDir)} artifactId=${result.artifactId.slice(0, 12)} entry=${result.entry}`
      );
    } catch (error) {
      log.error(`[extension-browser] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void build();
    }, debounceMs);
    timer.unref?.();
  };

  const watchers = [];
  const attach = (target) => {
    try {
      const watcher = watchFn(target, { recursive: true }, () => schedule());
      watcher.on?.("error", (error) => {
        log.error(`[extension-browser] watch error: ${error instanceof Error ? error.message : String(error)}`);
      });
      watchers.push(watcher);
    } catch (error) {
      log.error(`[extension-browser] watch unavailable for ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const target of sourceRoots) {
    if (existsSync(target)) attach(target);
  }

  await build();
  log.log("[extension-browser] watching for changes (Ctrl+C to stop)");
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* 已失效的监听器忽略 */
      }
    }
  };
}

async function main() {
  if (watch) {
    // 作者侧 watch：真实增量构建，供开发者模式（dev-source）使用（change: 2026-10-27-add-extension-dev-reload）。
    const stop = await watchExtensionBrowser({ dir: extensionDir, outDir, stagingDir });
    const shutdown = () => {
      stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  if (process.argv.includes("--all")) {
    // Installed prebuilt packages have no authoring entry. Verify and preserve their assets.
    const prebuilt = browserExtensions(scanExtensions({ repoRoot: REPO_ROOT })).filter(entry => !entry.hasBrowserEntry);
    if (prebuilt.length) {
      const { buildBrowserRelease } = await import('../../scripts/lib/extension-release-catalog.mjs');
      await buildBrowserRelease({ artifacts: prebuilt.map(entry => ({ extensionId: entry.extensionId, directory: entry.dir })), repoRoot: REPO_ROOT });
      console.log(`[extension-browser] verified ${prebuilt.length} prebuilt extension(s)`);
    }
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
    if (results.length === 0 && prebuilt.length === 0) throw new Error("未发现 browser extension 源码或预构建产物");
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
  return browserExtensions(scan).filter(extension => extension.hasBrowserEntry).map((extension) => ({
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
