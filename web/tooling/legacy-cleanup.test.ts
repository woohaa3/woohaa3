/**
 * 重构遗留清理守卫（change: remove-refactor-legacy-paths，任务 7.1）。
 *
 * 静态保证：`split-web-runtime-services` 之后被删除的过渡机制**不得重新出现**。
 * 断言以「禁止出现的稳定命名」表达，而不是快照当前文件清单 —— 后者会在合理新增
 * 代码时误报。
 *
 * 说明：注释里提到被删机制的名字（用于解释迁移）不算「重新引入」，所以扫描前先去掉
 * 注释；`canvas-db.ts` 的 `DROPPED_STORES` 是「升级时删除」的清单，单独放行。
 * 被保留的 Godot 本地生成/改模活链路（`canvasAgent` → `scene_received`）不做否定断言。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 仓库根（`web/` 的上一级）：`scripts/`、`game/` 也参与守卫。 */
const REPO_ROOT = path.resolve(WEB_ROOT, "..");

const SKIP_DIRS = new Set(["node_modules", "dist", "server-dist", ".git", ".godot", "test-results", "playwright-report"]);

function sourceFilesUnder(relative: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(REPO_ROOT, relative));
  return out;
}

/** 去掉块注释与行注释，避免「解释性提及」被当成重新引入。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");
}

function expectAbsent(relative: string, match: RegExp, forbidden: readonly string[]): void {
  const files = sourceFilesUnder(relative, match);
  expect(files.length, `${relative} 下应至少有一个文件`).toBeGreaterThan(0);
  for (const file of files) {
    if (file.includes(".test.")) continue;
    let source = stripComments(readFileSync(file, "utf8"));
    // 升级期「删除旧 store」的清单是允许的：
    source = source.replace(/const DROPPED_STORES[\s\S]*?as const;/, "");
    for (const needle of forbidden) {
      expect(source, `${path.relative(REPO_ROOT, file)} 含已删除机制 ${needle}`).not.toContain(needle);
    }
  }
}

describe("重构遗留清理守卫（任务 7.1）", () => {
  it("不存在 remote-cas 浏览器持久化栈", () => {
    expectAbsent("web/frontend/src", /\.(ts|tsx)$/, [
      "CanvasRemoteSync",
      "CanvasSyncCoordinator",
      "createRemoteCanvasClient",
      "CanvasSyncRepository",
      "buildCompleteNodeRunCommands",
      "buildFailNodeRunCommands",
      "CanvasWriterMode",
      "readCanvasWriterMode",
      "woohaa3-single-writer",
      "migrateLegacyAssetBlobsToStorage"
    ]);
  });

  it("不存在 Canvas Service 的 CAS 写入口与模式协商", () => {
    expectAbsent("web/services/canvas-service/src", /\.ts$/, [
      "isLegacyBlobPath",
      "mode-moved",
      "assertCasWriteAllowed",
      "migrateCanvasToYjs",
      "rollbackCanvasToRemoteCas",
      "loadSyncMode",
      "saveSyncMode"
    ]);
    expectAbsent("web/contracts/src", /\.ts$/, [
      "CANVAS_SYNC_MODES",
      "DEFAULT_CANVAS_SYNC_MODE",
      "isCanvasSyncMode",
      "CanvasSyncMetadata",
      "CANVAS_SYNC_MODE_SUFFIX"
    ]);
  });

  it("不存在旧任务网关状态与数据兼容迁移", () => {
    expectAbsent("web/contracts/src", /\.ts$/, [
      "CanvasTaskState",
      "migrateLegacyAsset"
    ]);
  });

  it("contracts 的协议版本校验不再把缺省视为当前版本", () => {
    const errors = stripComments(readFileSync(path.join(WEB_ROOT, "contracts/src/errors.ts"), "utf8"));
    expect(errors).not.toContain("缺省值容错");
    expect(errors).toContain("协议版本缺失");
  });

  it("ingress 不再为旧任务写入口保留 410 迁移提示", () => {
    const ingress = stripComments(readFileSync(path.join(REPO_ROOT, "scripts/lib/ingress.mjs"), "utf8"));
    expect(ingress).not.toContain("pptask/tasks");
    expect(ingress).not.toContain("ingress-legacy-task-write");
  });

  it("Bevy 运行时不再引用 Godot bridge 或独立模型 canvas", () => {
    // 重构后 Bevy 源码拆为多个模块，禁止项必须扫描全部 `bevy/src/**/*.rs`，
    // 否则移文件即可绕过守卫（change: refactor-bevy-runtime-modules，任务 6.2）。
    const files = sourceFilesUnder("bevy/src", /\.rs$/);
    expect(files.length, "bevy/src 下应至少有一个 .rs 文件").toBeGreaterThan(0);
    for (const file of files) {
      const runtime = stripComments(readFileSync(file, "utf8"));
      expect(runtime, `${path.relative(REPO_ROOT, file)} 含 canvasBridgeCommand`).not.toContain("canvasBridgeCommand");
      expect(runtime, `${path.relative(REPO_ROOT, file)} 含 canvasPushFrame`).not.toContain("canvasPushFrame");
      // Bevy 只持有可丢弃渲染状态：不提交规范命令，不做业务校验。
      expect(runtime, `${path.relative(REPO_ROOT, file)} 含 submitCommand`).not.toContain("submitCommand");
    }
    const facade = stripComments(readFileSync(path.join(REPO_ROOT, "bevy/src/lib.rs"), "utf8"));
    expect(facade).toContain("set_scene");
  });

  it("渲染映射不回退 prompt 作为结果正文", () => {
    const mapper = stripComments(readFileSync(path.join(WEB_ROOT, "contracts/src/canvas/render-scene/node-projection.ts"), "utf8"));
    // 正文只取 ready 文本资产；缺失时返回空，不回退 prompt。
    expect(mapper).toContain("asset.mediaKind === \"text\"");
    expect(mapper).not.toMatch(/return truncate\(data\.prompt/);
  });

  it("nodeData 不再保留历史 assetId 字段（规范引用只有 outputAssetId）", () => {
    const types = readFileSync(path.join(WEB_ROOT, "contracts/src/canvas/domain/types.ts"), "utf8");
    expect(types).toContain("outputAssetId?: string;");
    expect(types).not.toContain("  assetId?: string;");
    const projector = readFileSync(path.join(WEB_ROOT, "services/canvas-service/src/sync/task-projector.ts"), "utf8");
    expect(projector).not.toMatch(/^\s*assetId: record\.output/m);
  });

  it("仓库根不再有 web/generated 孤儿快照", () => {
    let exists = true;
    try {
      readdirSync(path.join(REPO_ROOT, "web/generated"));
    } catch {
      exists = false;
    }
    expect(exists, "web/generated 应已删除").toBe(false);
  });

  it("IndexedDB 只删除、不再创建本地权威画布与 remote-cas 时代的 store", () => {
    const db = readFileSync(path.join(WEB_ROOT, "frontend/src/cordis/services/canvas-state/indexeddb/canvas-db.ts"), "utf8");
    expect(db).toContain('const DROPPED_STORES = ["canvases", "settings", "outbox", "syncCaches", "assetBlobs"]');
    expect(db).not.toContain('createObjectStore("canvases"');
    expect(db).not.toContain('createObjectStore("settings"');
    expect(db).not.toContain("createObjectStore(CANVAS_STORE_OUTBOX");
  });

  it("新画布 bootstrap 已接线（room 惰性物化首个 Y.Doc）", () => {
    const room = readFileSync(path.join(WEB_ROOT, "services/canvas-service/src/sync/room.ts"), "utf8");
    expect(room).toContain("bootstrap");
    expect(room).toContain('recovered.code === "not-found"');
    const composition = readFileSync(path.join(WEB_ROOT, "services/canvas-service/src/composition.ts"), "utf8");
    expect(composition).toContain("bootstrap:");
  });

  it("不存在旧 Site Server 组合根（模型 MCP 归 mcp-service + Canvas Service）", () => {
    let exists = true;
    try {
      readdirSync(path.join(WEB_ROOT, "apps/site/server"));
    } catch {
      exists = false;
    }
    expect(exists, "web/apps/site/server 应已删除").toBe(false);
  });

  it(".gitignore 的 core dump 规则是根锚定的，不得吞掉 src 下的 core/ 源码目录", () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    const lines = gitignore.split("\n").map((line) => line.trim());
    expect(lines).toContain("/core");
    expect(lines).not.toContain("core");
    // 目标源码目录确实存在于磁盘（防止被忽略后消失）。
    for (const dir of [
      "web/contracts/src/canvas/domain/core",
      "web/services/canvas-service/src/storage/core"
    ]) {
      const entries = readdirSync(path.join(REPO_ROOT, dir));
      expect(entries.length, `${dir} 应有源文件`).toBeGreaterThan(0);
    }
  });
});
