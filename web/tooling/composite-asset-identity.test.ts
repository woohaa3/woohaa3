/**
 * 复合资产节点身份 no-compat 审计
 * （change: 2026-10-11-extract-film-set-extension，任务 7.7）。
 *
 * 静态保证：旧节点身份 `animation3d` / `extension3d`（以及 `ANIMATION3D*` / `Animation3D*`
 * 公开命名）**不得**出现在生产源码里，只能在下列已登记位置保留：
 *
 * 只读 compat 盘点：`web/services/canvas-service/src/storage/core/compat-inventory.ts`
 *    （纯函数只读，描述旧事实、不产生在线兼容）。
 *
 * 负向/迁移测试（`*.test.*` / `*.spec.*`）与历史归档文本允许保留旧值，本守卫跳过测试文件。
 *
 * 说明：只覆盖**身份更名**这一已落地部分。`FILM_SET_TOP_SCOPE` / `topOps` / `includeTop` /
 * `topRoot` / `hasTop*` 等旧顶层 authored scope 的移除依赖 items-only（D7/D8/D10），落地后再
 * 追加到本守卫。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 生产源码扫描根（相对仓库根）。 */
const PRODUCTION_ROOTS = [
  "web/contracts/src",
  "web/frontend/src",
  "web/backend/src",
  "web/services",
  "web/extensions",
  "bevy/src",
  "scripts",
  "web/scripts"
];

const SKIP_DIRS = new Set(["node_modules", "dist", "server-dist", "bevy-wasm", "test-results", "playwright-report"]);

/** 允许保留旧身份的生产文件（见文件头说明）。 */
const ALLOWLIST = new Set([
  "web/services/canvas-service/src/storage/core/compat-inventory.ts",
  // Strict old checkpoint/update reader, reachable only by the offline CLI.
  "scripts/lib/model-native-migration-source.mjs",
  "web/services/canvas-service/src/storage/migrations/offline-yjs-source.mjs",
  "scripts/lib/model-native-migration.ts",
  "scripts/migrate-model-native-nodes.mjs"
]);

/** 旧节点身份与旧公开命名。 */
const OLD_IDENTITY = /animation3d|extension3d|ANIMATION3D|Animation3D/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function collect(relative: string, out: string[]): void {
  const dir = path.join(REPO_ROOT, relative);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(path.relative(REPO_ROOT, full), out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) && !/\.spec\./.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
}

describe("复合资产节点身份 no-compat 审计（任务 7.7）", () => {
  it("生产源码不出现旧节点身份，只有登记的离线/只读位置例外", () => {
    const files: string[] = [];
    for (const root of PRODUCTION_ROOTS) collect(root, files);
    expect(files.length, "生产源码扫描集不应为空").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const source = stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      if (OLD_IDENTITY.test(source)) offenders.push(file);
    }
    expect(offenders, `以下生产文件仍含旧节点身份：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("登记的例外文件确实存在（防止 allowlist 变成幽灵条目）", () => {
    for (const file of ALLOWLIST) {
      expect(() => readFileSync(path.join(REPO_ROOT, file), "utf8"), file).not.toThrow();
    }
  });

  it("规范身份只保留共享 canonical type，不含具体扩展 id", () => {
    const identity = readFileSync(
      path.join(REPO_ROOT, "web/contracts/src/canvas/domain/core/composite-asset-identity.ts"),
      "utf8"
    );
    expect(identity).toContain('COMPOSITE_ASSET_NODE_TYPE = "composite-asset"');
    expect(identity).not.toContain('FILM_SET_EXTENSION_ID');
    expect(identity).not.toContain('CREATURE_VIDEO_ASSETS_EXTENSION_ID');
  });

  it("MCP 片场节点创建工具已更名，不再暴露 create_animation_node", () => {
    const tools = readFileSync(
      path.join(REPO_ROOT, "web/services/mcp-service/src/model-mcp/animation-tools.ts"),
      "utf8"
    );
    expect(tools).toContain("create_film_set_node");
    expect(stripComments(tools)).not.toContain("create_animation_node");
  });

  it("离线 reader 不由生产模块导入，旧 Room 迁移入口已移除", () => {
    const files: string[] = [];
    for (const root of PRODUCTION_ROOTS) collect(root, files);
    const reader = "web/services/canvas-service/src/animation/legacy-film-set-reader.ts";
    const offlineTool = "scripts/migrate-model-native-nodes.mjs";
    // 拍摄镜头迁移是 design D9 规划的**第二个独立离线入口**，同样复用 model-native 迁移的
    // 备份/verify/restore 模式；只由离线 CLI 打包调用，不被服务或浏览器导入。
    const shootingShotOfflineTools = new Set([
      "scripts/lib/film-set-shooting-shot-migration.ts",
      "scripts/migrate-film-set-shooting-shots.mjs"
    ]);
    const offenders = files.filter(file => {
      if (shootingShotOfflineTools.has(file)) return false;
      if (file === reader || file === "web/services/canvas-service/src/animation/legacy-film-set-identities.ts"
          || file === "web/services/canvas-service/src/animation/legacy-film-set-history.ts"
          || file === "scripts/lib/model-native-migration-source.mjs" || file === "scripts/lib/model-native-migration.ts" || file === "web/services/canvas-service/src/animation/legacy-film-set-content.ts" || file === "web/services/canvas-service/src/animation/legacy-film-set-animations.ts" || file === offlineTool) return false;
      const source = stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      return /legacy-film-set-reader|legacy-film-set-identities|legacy-film-set-history|legacy-film-set-content|legacy-film-set-animations|model-native-migration-source|migrateFilmSetClips|planFilmSetClipMigration/.test(source);
    });
    expect(offenders, "旧格式读取只能从统一离线迁移工具进入").toEqual([]);
    expect(() => readFileSync(path.join(REPO_ROOT, "scripts/migrate-film-set-clips.mjs"))).toThrow();
  });

});
