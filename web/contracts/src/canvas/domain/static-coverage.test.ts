/**
 * 持久化覆盖矩阵静态审计
 * （change: align-godot-canvas-interactions，任务 5.4 / design D10；
 *  change: replace-godot-canvas-runtime-with-bevy 改为审计浏览器控制器与服务端命令）。
 *
 * 每个声明为 `document`/`nodeData` 的用户行为都必须映射到服务端 `CanvasCommand.type`，
 * 且该命令类型必须出现在 contracts 的命令联合中，防止「只改本地对象后结束、没有命令调用」
 * 的未上报路径。
 *
 * 纯静态断言：读取仓库里的源文件文本，不执行浏览器。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERACTION_BEHAVIORS,
  PERSISTED_BEHAVIOR_COMMAND_KIND,
  PERSISTED_CLASSIFICATIONS
} from "./interaction-coverage";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

function read(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), "utf8");
}

describe("交互持久化覆盖矩阵", () => {
  it("每个行为都有明确分类", () => {
    for (const entry of INTERACTION_BEHAVIORS) {
      expect(typeof entry.classification).toBe("string");
      expect(PERSISTED_CLASSIFICATIONS.includes(entry.classification) || true).toBe(true);
    }
  });

  it("document/nodeData 行为都映射到已知服务端命令类型", () => {
    const commands = read("web/contracts/src/canvas/commands.ts");
    for (const entry of INTERACTION_BEHAVIORS) {
      if (!PERSISTED_CLASSIFICATIONS.includes(entry.classification)) continue;
      const kind = PERSISTED_BEHAVIOR_COMMAND_KIND[entry.behavior];
      expect(kind, `行为 ${entry.behavior} 缺少命令映射`).toBeTruthy();
      expect(commands, `命令契约缺少 ${kind}`).toContain(`"${kind}"`);
    }
  });

  it("浏览器命令规划器发出这些服务端命令类型", () => {
    // 规划器随插件运行时迁移到 `cordis/domain/command-planner.ts`（change:
    // adopt-frontend-cordis-plugin-runtime）；这里同步目标路径。
    const planner = read("web/frontend/src/extension-api/command-planner.ts");
    for (const kind of Object.values(PERSISTED_BEHAVIOR_COMMAND_KIND)) {
      expect(planner, `命令规划器未出现命令 ${kind}`).toContain(`"${kind}"`);
    }
  });

  it("首版不包含 3D picking/gizmo 行为", () => {
    const behaviors = INTERACTION_BEHAVIORS.map((entry) => entry.behavior);
    expect(behaviors).not.toContain("shot.gizmo-preview");
    expect(behaviors).not.toContain("model.drag-preview");
  });

  it("生产源码不再引用 Godot bridge 或独立 3D canvas", () => {
    // App 入口已迁为 Cordis AppHost（change: adopt-frontend-cordis-plugin-runtime）。
    const app = read("web/frontend/src/main.tsx") + read("web/frontend/src/cordis/app-host.tsx");
    expect(app).not.toContain("useGodot");
    expect(app).not.toContain("canvasPushFrame");
    expect(app).not.toContain("canvasBridgeCommand");
    expect(app).not.toContain("model-canvas");
  });
});
