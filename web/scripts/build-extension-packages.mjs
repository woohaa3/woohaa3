/**
 * 构建全部扩展包的 `dist/`（后端入口 / 共享入口）。
 *
 * 为什么不是一条 `pnpm -r --filter "./extensions/*"`：
 * `web/frontend` 与 `task-activity` 互为工作区依赖（前端测试引用扩展入口，扩展又依赖
 * `@woohaa3/frontend` 的类型/组件）。pnpm 的递归任务图会因此成环并直接失败
 * （ERR_PNPM_TASK_CYCLE），所以这个包不参与同一轮递归构建：它的浏览器产物由
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

/**
 * 递归构建失败时逐个重试，把失败归因到具体扩展。
 *
 * `pnpm -r` 一次失败只回一个非零退出码；在 CI 里输出被折叠成 `##[error]` 后，调用方拿到的
 * 异常里 `stdout/stderr` 都是 null，看不出是哪个扩展坏了（2026-11-11 分发流水线现场）。
 * 这里按单个包重跑，第一次失败即抛出带包名与目录的错误；成功过的不重复构建。
 */
function rebuildToLocateFailure(command, args, failure) {
  console.error("递归构建失败，逐个重试以定位失败的扩展…");
  for (const extension of local) {
    const pkg = readPackageJson(path.join(extension.dir, "package.json"));
    const single = packageManagerInvocation(["-r", "--filter", pkg.name, "run", "build"]);
    try {
      execFileSync(single.command, single.args, { stdio: "inherit", cwd: webRoot, windowsHide: true });
    } catch {
      throw new Error(
        `扩展构建失败：${pkg.name}（${path.relative(repoRoot, extension.dir)}）\n` +
        `上方是该包的完整输出；原始递归构建错误：${failure instanceof Error ? failure.message.split("\n")[0] : String(failure)}`
      );
    }
  }
  throw failure;
}

if (local.length) {
  try {
    execFileSync(invocation.command, invocation.args, { stdio: "inherit", cwd: webRoot, windowsHide: true });
  } catch (failure) {
    rebuildToLocateFailure(invocation.command, invocation.args, failure);
  }
}
for (const extension of external) {
  const build = packageManagerInvocation(["run", "build"]);
  try {
    execFileSync(build.command, build.args, { stdio: "inherit", cwd: extension.dir, windowsHide: true });
  } catch (failure) {
    const pkg = readPackageJson(path.join(extension.dir, "package.json"));
    throw new Error(
      `扩展构建失败：${pkg?.name ?? path.basename(extension.dir)}（${path.relative(repoRoot, extension.dir)}）\n` +
      `原始错误：${failure instanceof Error ? failure.message.split("\n")[0] : String(failure)}`
    );
  }
}
