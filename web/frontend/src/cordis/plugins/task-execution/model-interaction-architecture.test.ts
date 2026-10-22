/**
 * Model Interaction Plugin 架构审计
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 3.4 / 4.5 / design D2 / D7）。
 *
 * 静态保证：
 * - Catalog/Remote 不触发 dynamic import / module URL（不加载任意代码）；
 * - Model Panel 不直接 import Provider runtime / credentials 或 Task internal API；
 * - Model Plugin 不在 import evaluation 注册 definition（只能在 activation 中 register）；
 * - Core Task Execution 不含具体 modelKey/providerId/`edit_video` 选择分支。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORDIS_DIR = path.join(SRC_ROOT, "cordis");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bevy-wasm"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function productionFiles(dir: string): string[] {
  return walk(dir).filter((file) => !file.includes(".test.") && !file.includes("/test-support/"));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("Model Interaction Plugin 架构审计", () => {
  it("Catalog/Registry 边界不出现运行时动态 import（不加载任意模块）", () => {
    // 只检查真正会触发模块加载的运行时 `import(`；TS 的内联类型 `import("x").T` 不算。
    const boundaryFiles = [
      "services/task-remote.ts",
      "services/task-catalog.ts",
      "services/model-interaction-service.ts",
      "contract/model-interaction.ts",
      "canvas-manifest.ts"
    ];
    const offenders: string[] = [];
    for (const relative of boundaryFiles) {
      const source = stripComments(readFileSync(path.join(CORDIS_DIR, relative), "utf8"));
      if (/\b(?:await|void|return|=|=>)\s*import\s*\(/.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Model Interaction Panel/definition 不在 import evaluation 注册", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      const source = stripComments(readFileSync(file, "utf8"));
      // 顶层（非缩进）调用 register( 视为 import-time 副作用。
      if (/^\s{0,2}(?:[\w$.]+\.)?modelInteractions\.register\s*\(/m.test(source) && !/ctx\.modelInteractions\.register/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Model Panel 不 import Provider runtime / credentials / Task internal API", () => {
    const offenders: string[] = [];
    const suspects = productionFiles(CORDIS_DIR).filter(
      (file) => file.includes("model-interaction") || file.includes("generic-panel") || file.includes("seedance-panel")
    );
    for (const file of suspects) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/@sdppp\/pptask|apiKey|credentials|providerModelId\s*===\s*["']litellm|services\/task-service|internal\/v1/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Core Task Execution 不含具体模型的布局/选择分支", () => {
    const coreFiles = [
      "model-execution-host.tsx",
      "model-execution-host-helpers.ts",
      "model-execution-context.ts",
      "model-draft.ts",
      "submit-coordinator.ts"
    ];
    const offenders: string[] = [];
    for (const name of coreFiles) {
      const file = path.join(CORDIS_DIR, "plugins", "task-execution", name);
      const source = stripComments(readFileSync(file, "utf8"));
      if (/edit_video|videoEditIntents|seedance|providerId\s*===/.test(source)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
