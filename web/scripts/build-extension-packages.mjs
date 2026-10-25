/**
 * 构建全部扩展包的 `dist/`（后端入口 / 共享入口）。
 *
 * 为什么不是一条 `pnpm -r --filter "./extensions/*"`：
 * `web/frontend` 与 `prompt-snippets` / `task-activity` 互为工作区依赖（前端测试与 showcase 引用扩展
 * 入口，扩展又依赖 `@woohaa3/frontend` 的类型/组件）。pnpm 的递归任务图会因此成环并直接失败
 * （ERR_PNPM_TASK_CYCLE），所以这两个包不参与同一轮递归构建：它们的浏览器产物由
 * `build:browser` 生成，`dist/` 与聚合构建无关。
 *
 * 环由 package.json 的依赖关系**推导**，不是写死的包名单：新增/删除扩展不需要改这个脚本。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageManagerInvocation } from "./package-manager.mjs";

import { scanExtensions } from "../../scripts/lib/extension-scan.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

function readPackageJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function workspaceDeps(pkg) {
  const merged = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  return new Set(Object.keys(merged).filter((name) => name.startsWith("@woohaa3/")));
}

/** 与 `@woohaa3/frontend` 互为依赖的扩展：pnpm 递归任务图里成环，单列出来。 */
function cyclicExtensionNames(extensions) {
  const frontendPkg = readPackageJson(path.join(webRoot, "frontend", "package.json"));
  const frontendDeps = workspaceDeps(frontendPkg);
  const cyclic = new Set();
  for (const extension of extensions) {
    const pkg = readPackageJson(path.join(extension.dir, "package.json"));
    if (frontendDeps.has(pkg.name) && workspaceDeps(pkg).has("@woohaa3/frontend")) cyclic.add(pkg.name);
  }
  return cyclic;
}

const scan = scanExtensions({ repoRoot });
const extensions = scan.extensions.filter((extension) => fs.existsSync(path.join(extension.dir, "package.json")));
const cyclic = cyclicExtensionNames(extensions);
const buildable = extensions.filter((extension) => {
  const pkg = readPackageJson(path.join(extension.dir, "package.json"));
  return !cyclic.has(pkg.name) && typeof pkg.scripts?.build === 'string';
});
if (buildable.length === 0) {
  console.log("没有需要从源码构建的扩展包；复用已安装产物");
}
if (cyclic.size > 0) {
  console.log(`跳过与 @woohaa3/frontend 互为依赖的扩展（pnpm 工作区环）：${[...cyclic].sort().join("、")}`);
}
const local = buildable.filter(extension => !path.relative(repoRoot, extension.dir).startsWith(".."));
const external = buildable.filter(extension => path.relative(repoRoot, extension.dir).startsWith(".."));
const filters = local.flatMap((extension) => {
  const pkg = readPackageJson(path.join(extension.dir, "package.json"));
  return ["--filter", pkg.name];
});
const invocation = packageManagerInvocation(["-r", ...filters, "run", "build"]);
if (local.length) execFileSync(invocation.command, invocation.args, { stdio: "inherit", cwd: webRoot, windowsHide: true });
for (const extension of external) {
  const build = packageManagerInvocation(["run", "build"]);
  execFileSync(build.command, build.args, { stdio: "inherit", cwd: extension.dir, windowsHide: true });
}
