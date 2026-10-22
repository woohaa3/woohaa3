/**
 * 启动期扩展宿主加载（打包入口适配）
 * （change: 2026-10-15-add-scannable-extension-directories，任务 4.3；design D1、D3）。
 *
 * `web/backend/src/server.ts` 会被 esbuild 打成单文件（`server-dist/index.js`），不能静态
 * import 仓库根的 `scripts/lib/extension-host.mjs`。这里用**运行期动态 import** 按路径加载：
 * esbuild 不会内联不可静态分析的目标，因此宿主仍是仓库里的真实文件，
 * `import.meta.url` 解析（contracts、扩展目录）保持正确。
 *
 * 宿主缺失时不注册任何扩展（只记录一条日志），让测试/嵌入式用法不受影响；声明非法、跨根
 * 重复 identity 等由宿主抛出，进程入口据此 fail-fast。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LoadedExtensionHost } from "./manifest.js";

export type ExtensionHostEnv = Record<string, string | undefined>;

/**
 * 宿主模块位置：`WOOHAA3_EXTENSION_HOST`（绝对路径）优先；否则从 `repoRoot` 起**沿父目录向上**
 * 查找 `scripts/lib/extension-host.mjs`，返回命中目录作为**宿主的仓库根**。
 *
 * 向上查找是必需的：进程 cwd 不一定是仓库根（vitest 在 `web/backend` 下运行、`pnpm -C` 会改 cwd），
 * 而宿主扫描 `extensions.config.json` 的相对根必须与模块所在仓库一致，否则会静默扫错根。
 */
export function resolveExtensionHostModule({
  repoRoot,
  env
}: {
  repoRoot: string;
  env: ExtensionHostEnv;
}): { modulePath: string; hostRoot: string } | null {
  const explicitRepoRoot = typeof env.WOOHAA3_REPO_ROOT === "string" && env.WOOHAA3_REPO_ROOT.trim().length > 0 ? path.resolve(env.WOOHAA3_REPO_ROOT) : null;
  const explicitHost = env.WOOHAA3_EXTENSION_HOST;
  if (typeof explicitHost === "string" && explicitHost.trim().length > 0) {
    return { modulePath: path.resolve(explicitHost), hostRoot: explicitRepoRoot ?? path.resolve(repoRoot) };
  }
  let dir = explicitRepoRoot ?? path.resolve(repoRoot);
  for (;;) {
    const candidate = path.join(dir, "scripts", "lib", "extension-host.mjs");
    if (existsSync(candidate)) return { modulePath: candidate, hostRoot: explicitRepoRoot ?? dir };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 按环境加载启动期扩展宿主。返回 `undefined` 表示宿主不可用（未找到模块），本次启动不加载扩展。
 */
export async function loadExtensionHostFromEnv({
  logger,
  env = process.env
}: {
  logger?: (event: Record<string, unknown>) => void;
  env?: ExtensionHostEnv;
} = {}): Promise<LoadedExtensionHost | undefined> {
  const repoRoot = env.WOOHAA3_REPO_ROOT && env.WOOHAA3_REPO_ROOT.trim().length > 0 ? path.resolve(env.WOOHAA3_REPO_ROOT) : process.cwd();
  const resolved = resolveExtensionHostModule({ repoRoot, env });
  if (resolved === null) {
    logger?.({ event: "extension-host-absent", repoRoot, message: "未找到启动期扩展宿主；本次启动不加载扩展" });
    return undefined;
  }
  const hostModule = (await import(pathToFileURL(resolved.modulePath).href)) as {
    loadExtensionHost: (input: { repoRoot: string; env: ExtensionHostEnv; logger?: (event: Record<string, unknown>) => void }) => Promise<LoadedExtensionHost>;
  };
  return await hostModule.loadExtensionHost({ repoRoot: resolved.hostRoot, env, logger });
}
