/**
 * 运行期加载包工具（与 `host-boot.ts` 同一做法）：后端打包入口不能静态 import 仓库根脚本，
 * 这里按扩展宿主模块所在目录动态 import `scripts/lib/*.mjs` 与 `scripts/extensions-preflight.mjs`，
 * 保证安装预检与 `pnpm extensions:check` 是同一份代码。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveExtensionHostModule, type ExtensionHostEnv } from "../../../extensions/host-boot.js";
import type { ExtensionPackageToolkit } from "./types.js";

export async function loadPackageToolkit(env: ExtensionHostEnv): Promise<ExtensionPackageToolkit | null> {
  const repoRoot = env.WOOHAA3_REPO_ROOT && env.WOOHAA3_REPO_ROOT.trim().length > 0 ? path.resolve(env.WOOHAA3_REPO_ROOT) : process.cwd();
  const resolved = resolveExtensionHostModule({ repoRoot, env });
  if (!resolved) return null;
  const lib = path.dirname(resolved.modulePath);
  const load = async (file: string) => (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const [pkg, installations, descriptor, preflight, host] = await Promise.all([
    load(path.join(lib, "extension-package.mjs")),
    load(path.join(lib, "extension-installations.mjs")),
    load(path.join(lib, "extension-descriptor.mjs")),
    load(path.join(lib, "..", "extensions-preflight.mjs")),
    load(resolved.modulePath)
  ]);
  const pick = <T>(module: Record<string, unknown>, name: string): T => {
    const value = module[name];
    if (typeof value !== "function") throw new Error(`扩展包工具缺少导出 ${name}`);
    return value as T;
  };
  return {
    computePackageDigest: pick(pkg, "computePackageDigest"),
    unpackExtensionPackage: pick(pkg, "unpackExtensionPackage"),
    verifyExtensionPackage: pick(pkg, "verifyExtensionPackage"),
    filesDigest: pick(pkg, "filesDigest"),
    keyIdOf: pick(pkg, "keyIdOf"),
    openInstallations: pick(installations, "openInstallations"),
    appendHistory: pick(installations, "appendHistory"),
    listOrphanVersionDirs: pick(installations, "listOrphanVersionDirs"),
    checkEnginesCompatible: pick(descriptor, "checkEnginesCompatible"),
    satisfiesRange: pick(descriptor, "satisfiesRange"),
    preflightDirectory: pick(preflight, "preflightDirectory"),
    ...(typeof host.describeIsolatedExtension === "function" ? { describeIsolatedExtension: host.describeIsolatedExtension as ExtensionPackageToolkit["describeIsolatedExtension"] } : {})
  };
}