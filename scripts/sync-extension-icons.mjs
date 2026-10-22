/**
 * 同步扩展品牌图形到宿主静态目录（`web/frontend/public/plugin-icons/`）。
 *
 * 用法：
 *   node scripts/sync-extension-icons.mjs            # 写入/更新生成物
 *   node scripts/sync-extension-icons.mjs --check    # 只校验漂移（CI 与 `pnpm extensions:check` 用）
 *
 * 事实来源是各扩展包 `extension.json` 的 `icon.asset`；见 `scripts/lib/extension-icon-assets.mjs`。
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadExtensionDescriptor } from "./lib/extension-descriptor.mjs";
import { syncExtensionIconAssets } from "./lib/extension-icon-assets.mjs";
import { scanExtensions } from "./lib/extension-scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const scan = scanExtensions({ repoRoot });
const extensions = [];
for (const extension of scan.extensions) {
  const descriptor = loadExtensionDescriptor(extension, { repoRoot });
  if (descriptor) extensions.push({ extensionId: extension.extensionId, dir: extension.dir, descriptor });
}

const result = syncExtensionIconAssets({
  repoRoot,
  check,
  extensions,
  logger: (event) => process.stdout.write(`[icons] ${event.extensionId} → ${event.file}\n`)
});

if (result.errors.length > 0) {
  for (const message of result.errors) process.stderr.write(`[icons] ${check ? "漂移" : "错误"}：${message}\n`);
  process.exit(1);
}
process.stdout.write(
  check
    ? `[icons] ${result.unchanged.length} 个生成的品牌图形与扩展包资产一致\n`
    : `[icons] 同步 ${result.written.length} 个品牌图形\n`
);
