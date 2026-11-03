/**
 * 扩展后端单文件构建 build:backend
 * （change: 2026-10-21-add-extension-marketplace-point，任务 3.1 / design D4）。
 *
 *   node web/scripts/build-extension-backend.mjs [--cwd <extensionDir>] [--outdir backend-dist]
 *
 * 把 extension.json 声明的后端模块（backend / hostPlugin / metadata / publicRoutes 的导出）打成**一个**
 * ESM 文件 backend-dist/entry.mjs，只转出声明里用到的具名导出。受管扩展（.wxt 安装）不在 pnpm 工作区里，
 * 运行时拿不到 workspace:* 依赖，所以：
 *
 * - node: builtin 保持外部（进程内运行，design D5）；
 * - @woohaa3/contracts / @woohaa3/provider-sdk 按源码内联（纯函数/常量，tree-shake）；
 *   注意内联的是副本：依赖 instanceof 判断宿主类（如 StorageObjectNotFoundError）的代码要改用 code/name 判断；
 * - 其他 @woohaa3/*（宿主服务、前端、其他扩展）一律拒绝；
 * - 其余 npm 依赖全部内联；产物里不得残留任何非 node: 的外部 import。
 *
 * 不声明 canvasContent / bootstrap：受管扩展禁止这两类声明（预检拒绝），本构建也拒绝。
 *
 * 声明了 hostPlugin 时额外产出 backend-dist/config-schema.json（change: 2026-10-21-isolate-extension-host-process，
 * 任务 6.1）：在**独立 node 子进程**里 import 刚产出的 entry.mjs、调用工厂一次，取插件的 name / label /
 * configPrefix / Config.fields / modelRefresh / 是否实现 health，以及 metadata 与 publicPathExport 常量。
 * 求值只发生在打包机上（不在宿主），结果是纯 JSON；宿主据此构造代理插件而不 import 受管扩展代码。
 *
 * 输出 { outFile, exports, modules }；不改写扩展目录里的 extension.json / package.json（改写由 pack:extension 在暂存目录完成）。
 */
import { existsSync, readFileSync, watch as fsWatch } from "node:fs";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { validateExtensionDescriptor } from "../../scripts/lib/extension-descriptor.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, "..");
export const BACKEND_DIST_DIR = "backend-dist";
export const BACKEND_ENTRY_FILE = "entry.mjs";
/** 打包后 extension.json 里模块子路径改写成这个值；package.json exports 把它映射到 entry.mjs。 */
export const BACKEND_ENTRY_SUBPATH = "./backend-dist/entry";

/** 允许按源码内联的工作区包 → 源码入口目录。 */
const INLINE_WORKSPACE_PACKAGES = {
  "@woohaa3/contracts": path.join(WEB_DIR, "contracts"),
  "@woohaa3/provider-sdk": path.join(WEB_DIR, "framework", "provider-sdk"),
  // pptask 是 Provider 的执行面（vendor 源码包）：受管 Provider 打包时按源码内联，扩展目录不必在工作区里。
  // 其自身依赖（ai、@ai-sdk/provider）从 pptask 目录的 node_modules 解析并一并内联。
  "@sdppp/pptask": path.join(WEB_DIR, "vendor", "pptask")
};
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, "node:" + name]));

function readArg(name) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

/** 声明里需要转出的具名导出：[{ field, subpath, exportName }]。 */
export function declaredBackendExports(descriptor) {
  const out = [];
  if (descriptor.bootstrap) throw new Error("build:backend 不支持 bootstrap 声明（受管扩展不得提供槽位实现）");
  if (descriptor.canvasContent) throw new Error("build:backend 不支持 canvasContent 声明（受管扩展不得提供画布内容端口）");
  if (descriptor.migrate) throw new Error("build:backend 不支持 migrate 声明（需要进程隔离支持）");
  if (descriptor.backend) out.push({ field: "backend", subpath: descriptor.backend.module ?? "./backend", exportName: descriptor.backend.factory });
  if (descriptor.hostPlugin) out.push({ field: "hostPlugin", subpath: descriptor.hostPlugin.module ?? "./backend", exportName: descriptor.hostPlugin.factory });
  if (descriptor.metadata) out.push({ field: "metadata", subpath: descriptor.metadata.module ?? "./shared", exportName: descriptor.metadata.export });
  for (const [index, route] of (descriptor.publicRoutes ?? []).entries()) {
    if (route.publicPathExport) out.push({ field: "publicRoutes[" + index + "]", subpath: route.module ?? "./shared", exportName: route.publicPathExport });
  }
  return out;
}

/** 源码入口：exports[subpath] 的 types（.ts 源码）优先，其次 import 目标，再次约定 src/<name>.ts。 */
function sourceFileOf(dir, pkg, subpath) {
  const entry = pkg.exports?.[subpath];
  const candidates = [];
  if (typeof entry === "string") candidates.push(entry);
  else if (entry && typeof entry === "object") {
    if (typeof entry.types === "string" && /\.tsx?$/.test(entry.types)) candidates.push(entry.types);
    for (const key of ["import", "default", "node"]) if (typeof entry[key] === "string") candidates.push(entry[key]);
  }
  const name = subpath.replace(/^\.\//, "");
  candidates.push("./src/" + name + ".ts", "./src/" + name + "/index.ts");
  for (const candidate of candidates) {
    const absolute = path.resolve(dir, candidate);
    if (!absolute.startsWith(dir + path.sep)) throw new Error("模块目标越出扩展目录：" + candidate);
    if (existsSync(absolute)) return absolute;
  }
  throw new Error("找不到 " + subpath + " 的源码（试过 " + candidates.join("、") + "）");
}

/** 运行一次后端单文件构建。 */
export async function buildExtensionBackend(options = {}) {
  const dir = path.resolve(options.cwd ?? process.cwd());
  const outDir = path.resolve(options.outDir ?? path.join(dir, BACKEND_DIST_DIR));
  const descriptorFile = path.join(dir, "extension.json");
  if (!existsSync(descriptorFile)) throw new Error("缺少 extension.json：" + dir);
  const validated = validateExtensionDescriptor(JSON.parse(readFileSync(descriptorFile, "utf8")));
  if (!validated.ok) throw new Error("extension.json 无效：\n  " + validated.errors.join("\n  "));
  const descriptor = validated.value;
  const declared = declaredBackendExports(descriptor);
  if (declared.length === 0) return { outFile: null, exports: [], modules: [] };

  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const byName = new Map();
  const modules = new Map();
  for (const item of declared) {
    const file = sourceFileOf(dir, pkg, item.subpath);
    modules.set(item.subpath, file);
    const previous = byName.get(item.exportName);
    if (previous && previous.file !== file) {
      throw new Error("导出名冲突：" + item.exportName + " 同时来自 " + previous.subpath + " 与 " + item.subpath + "（单文件产物只能有一个同名导出）");
    }
    byName.set(item.exportName, { file, subpath: item.subpath });
  }
  const bySource = new Map();
  for (const [name, { file }] of byName) bySource.set(file, [...(bySource.get(file) ?? []), name]);
  const entrySource = [...bySource]
    .map(([file, names]) => "export { " + names.sort().join(", ") + " } from " + JSON.stringify(file) + ";")
    .join("\n");

  const guardPlugin = {
    name: "woohaa-extension-backend-guard",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const specifier = args.path;
        if (BUILTINS.has(specifier)) return { path: specifier.startsWith("node:") ? specifier : "node:" + specifier, external: true };
        for (const [name, root] of Object.entries(INLINE_WORKSPACE_PACKAGES)) {
          if (specifier === name) return { path: path.join(root, "src", "index.ts") };
          if (specifier.startsWith(name + "/")) {
            const rest = specifier.slice(name.length + 1);
            const candidates = [path.join(root, "src", rest + ".ts"), path.join(root, "src", rest, "index.ts"), path.join(root, rest)];
            const hit = candidates.find((candidate) => existsSync(candidate));
            if (hit) return { path: hit };
            return { errors: [{ text: "无法按源码内联 " + specifier }] };
          }
        }
        if (specifier.startsWith("@woohaa3/")) {
          return { errors: [{ text: "受管扩展后端不得依赖宿主/其他扩展的运行时代码：" + specifier + "（只允许内联 @woohaa3/contracts 与 @woohaa3/provider-sdk）" }] };
        }
        return undefined; // 其他 npm 依赖：交给 esbuild 正常解析并内联。
      });
    }
  };

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, BACKEND_ENTRY_FILE);
  const result = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: dir, sourcefile: "backend-entry.ts", loader: "ts" },
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    absWorkingDir: dir,
    // CJS 依赖在 ESM 产物里需要 require：用 createRequire 垫片，避免 "Dynamic require is not supported"。
    banner: { js: 'import { createRequire as __woohaaCreateRequire } from "node:module"; const require = __woohaaCreateRequire(import.meta.url);' },
    minify: false,
    sourcemap: false,
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
    plugins: [guardPlugin],
    ...(options.esbuild ?? {})
  });
  const externals = [];
  for (const output of Object.values(result.metafile.outputs)) {
    for (const edge of output.imports ?? []) {
      if (edge.external && !edge.path.startsWith("node:")) externals.push(edge.path);
    }
  }
  if (externals.length > 0) throw new Error("backend 产物残留外部依赖（必须内联）：" + [...new Set(externals)].join("、"));

  return {
    outFile,
    exports: [...byName.keys()].sort(),
    modules: [...modules.keys()],

  };
}

/**
 * 作者侧后端增量构建（change: 2026-10-27-add-extension-dev-reload，6.2）。
 *
 * 与前端 watch 同一形态：复用同一条构建函数，源码变了再跑一次；失败只记录、不退出。
 */
async function watchExtensionBackend({ dir, outDir, debounceMs = 120, watch: watchFn = fsWatch, log = console }) {
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
      const result = await buildExtensionBackend({ cwd: dir, outDir });
      log.log(
        result.outFile
          ? `[extension-backend] rebuilt ${path.relative(process.cwd(), result.outFile)} exports=${result.exports.join(",")}`
          : `[extension-backend] ${path.basename(dir)}：没有后端声明，跳过`
      );
    } catch (error) {
      log.error(`[extension-backend] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
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

  const targets = [path.join(dir, "src"), path.join(dir, "extension.json")].filter((target) => existsSync(target));
  const watchers = [];
  for (const target of targets) {
    try {
      const watcher = watchFn(target, { recursive: true }, () => schedule());
      watcher.on?.("error", () => undefined);
      watchers.push(watcher);
    } catch (error) {
      log.error(`[extension-backend] watch unavailable for ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await build();
  log.log("[extension-backend] watching for changes (Ctrl+C to stop)");
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
  const dir = path.resolve(readArg("cwd") ?? process.cwd());
  const outDirName = readArg("outdir") ?? BACKEND_DIST_DIR;
  if (process.argv.includes("--watch")) {
    const stop = await watchExtensionBackend({ dir, outDir: path.join(dir, outDirName) });
    const shutdown = () => {
      stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  const result = await buildExtensionBackend({ cwd: dir, outDir: path.join(dir, outDirName) });
  if (!result.outFile) {
    console.log("[extension-backend] " + path.basename(dir) + "：没有后端声明，跳过");
    return;
  }
  console.log("[extension-backend] " + path.relative(process.cwd(), result.outFile) + " exports=" + result.exports.join(","));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[extension-backend] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
