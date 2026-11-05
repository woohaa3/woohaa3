/**
 * 复合资产节点身份 no-compat 审计（change: 2026-10-11-extract-film-set-extension，任务 7.7）。
 *
 * 扫描生产源码，拒绝 `animation3d` / `extension3d` / `ANIMATION3D` 等旧节点身份。
 * 2026-10-31 片场下线后，离线迁移 CLI 与旧 reader 一并删除，allowlist 只剩严格旧格式 reader。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  // Strict old checkpoint/update reader, reachable only by the offline CLI.
  "web/services/canvas-service/src/storage/migrations/offline-yjs-source.mjs"
]);

/** 旧节点身份与旧公开命名。 */
const OLD_IDENTITY = /animation3d|extension3d|ANIMATION3D|Animation3D/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 例外清单用 `/` 分隔；Windows 的 `path.relative` 给 `\`，不归一会让整条 allowlist 失效。 */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(toPosix(path.relative(REPO_ROOT, full)), out);
    } else if (/\.(ts|tsx|mjs|js|rs|json)$/.test(entry.name)) {
      out.push(toPosix(path.relative(REPO_ROOT, full)));
    }
  }
}

describe("复合资产节点身份 no-compat 审计（任务 7.7）", () => {
  it("生产源码不再出现旧节点身份 animation3d / extension3d", () => {
    const files: string[] = [];
    for (const root of PRODUCTION_ROOTS) collect(root, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes(".test.") || file.includes("/__fixtures__/") || file.includes("/tests/")) continue;
      if (ALLOWLIST.has(file)) continue;
      const source = stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      const match = source.match(OLD_IDENTITY);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders, `以下生产文件仍含旧节点身份：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("登记的例外文件确实存在（防止 allowlist 变成幽灵条目）", () => {
    for (const file of ALLOWLIST) {
      expect(() => readFileSync(path.join(REPO_ROOT, file), "utf8"), file).not.toThrow();
    }
  });

  it("规范身份常量保持共享 type + extensionId（D1/D11）", () => {
    const identity = readFileSync(
      path.join(REPO_ROOT, "web/contracts/src/canvas/domain/core/composite-asset-identity.ts"),
      "utf8"
    );
    expect(identity).toContain('COMPOSITE_ASSET_NODE_TYPE = "composite-asset"');
    expect(identity).toContain('CREATURE_VIDEO_ASSETS_EXTENSION_ID = "creature-video-assets"');
  });

  it("离线 reader 不由生产模块导入，旧 Room 迁移入口已移除", () => {
    const files: string[] = [];
    for (const root of PRODUCTION_ROOTS) collect(root, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes(".test.")) continue;
      if (file.startsWith("web/services/canvas-service/src/storage/migrations/")) continue;
      const source = stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      if (source.includes("offline-yjs-source")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
