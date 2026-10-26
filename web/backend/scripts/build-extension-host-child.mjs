#!/usr/bin/env node
/**
 * Extension Host 子进程入口单文件构建（change: 2026-10-21-isolate-extension-host-process，D2）。
 *
 *   node scripts/build-extension-host-child.mjs   # 在 web/backend 下
 *
 * 产物 `dist/extension-host-child.js`：子进程只依赖 contracts、RPC 运行时、出网守卫与 cordis；它们全部内联，
 * 只有 node: 内建模块保持外部。宿主 fork 这个文件，不依赖子进程能解析工作区包。
 * 入口 MUST NOT 引入宿主业务代码：除 @woohaa3/contracts、@woohaa3/provider-sdk、@deepseek-ai/cordis 外的
 * @woohaa3/* 一律拒绝。
 */
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_WORKSPACE = new Set(["@woohaa3/contracts", "@woohaa3/provider-sdk"]);

const guard = {
  name: "extension-host-child-guard",
  setup(build) {
    build.onResolve({ filter: /^@woohaa3\// }, (args) => {
      const root = args.path.split("/").slice(0, 2).join("/");
      if (ALLOWED_WORKSPACE.has(root)) return undefined;
      return { errors: [{ text: `子进程入口不得引入宿主模块：${args.path}（来自 ${path.relative(BACKEND_DIR, args.importer)}）` }] };
    });
  }
};

const result = await esbuild.build({
  entryPoints: [path.join(BACKEND_DIR, "src", "extension-host", "child", "main.ts")],
  outfile: path.join(BACKEND_DIR, "dist", "extension-host-child.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  // 内联的 CJS 依赖可能用到 require：给 ESM 产物补一个。
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  plugins: [guard],
  metafile: true,
  logLevel: "info"
});

const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter((file) => /web\/(backend\/src\/(?!extension-host\/)|services\/)/.test(file));
if (leaked.length > 0) {
  console.error("[build-extension-host-child] 子进程产物引入了宿主业务代码：");
  for (const file of leaked) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`[build-extension-host-child] dist/extension-host-child.js（${inputs.length} 个输入）`);
