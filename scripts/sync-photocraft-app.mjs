#!/usr/bin/env node
/**
 * 转发到仓库根的 PhotoCraft 覆盖层同步脚本。
 *
 * 权威实现在仓库根的 `scripts/sync-photocraft-app.mjs`：它要同时知道
 * `tools/photocraft-web/app`（源，仓库根）与 `client/web/frontend/public`（目标，client 内）
 * 两处位置，只有站在仓库根才能一次算对。
 *
 * client 子模块单独检出时源与目标都不存在，脚本会如实报错，不静默生成空目录。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// here = <repo>/client/scripts → <repo>/scripts/sync-photocraft-app.mjs
const script = join(here, "..", "..", "scripts", "sync-photocraft-app.mjs");

if (!existsSync(script)) {
  console.error(
    "[photocraft] 找不到仓库根的 scripts/sync-photocraft-app.mjs。\n" +
      "PhotoCraft 覆盖层的产物在仓库根 tools/ 下；只检出 client 时这一步需要跳过。"
  );
  process.exit(1);
}

try {
  execFileSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1);
}
