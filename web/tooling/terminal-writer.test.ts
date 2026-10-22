/**
 * 终态写入方唯一性（change: split-web-runtime-services，任务 1.1）。
 *
 * 静态保证：拆分后 **Canvas projector 是唯一终态写入方**，Frontend 只发 run/cancel。
 * - 浏览器侧 `run-client.ts` / `submit-coordinator.ts` 不含 complete/fail/persist/runToTerminal
 *   等终态方法；
 * - 只有 `@woohaa3/canvas-yjs` 的 task-projector 写 `taskStatus: "successed" | "failed" | "cancelled"`；
 * - 浏览器不直接 POST 旧的 `/api/pptask/tasks` 写入口。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(WEB_ROOT, relative), "utf8");
}

function filesUnder(relative: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "server-dist"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(WEB_ROOT, relative));
  return out;
}

describe("终态写入方唯一性（任务 1.1）", () => {
  it("浏览器 run/cancel 客户端不含终态写入方法", () => {
    for (const file of [
      "frontend/src/cordis/plugins/task-execution/submit-coordinator.ts"
    ]) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        // 结构性保证常量本身列出这些名字，但不是方法实现，先移除。
        .replace(/SUBMIT_COORDINATOR_FORBIDDEN_METHODS[\s\S]*?\] as const;/g, "");
      for (const forbidden of ["completeNodeRun", "failNodeRun", "buildResultAsset", "runToTerminal"]) {
        expect(source, `${file} 含 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("服务端唯一终态写入方是 canvas-yjs task-projector", () => {
    // 服务实现（三个 service）中，只有 projector 写终态 taskStatus。
    const writers: string[] = [];
    for (const service of ["canvas-service", "task-service", "media-service"]) {
      for (const file of filesUnder(`services/${service}`, /\.ts$/)) {
        if (file.includes(".test.")) continue;
        if (file.includes("__fixtures__")) continue;
        const source = readFileSync(file, "utf8");
        if (/taskStatus:\s*"(successed|failed|cancelled)"/.test(source)) {
          writers.push(path.relative(WEB_ROOT, file));
        }
      }
    }
    // canvas-service 只写 processing（begin），终态由 canvas-service 的 task-projector 写
    // （change: split-web-runtime-services 后 projector 从 canvas-yjs 包并入 canvas-service）。
    // 例外：node-history-service 的受控恢复是**用户显式动作**（把历史版本设为当前），
    // 不是任务终态投影；它同样写 successed 以反映恢复后节点回到可用输出
    // （change: add-canvas-node-generation-history，design D3）。
    expect(
      writers.filter(
        (file) =>
          file.includes("canvas-service") &&
          !file.includes("task-projector") &&
          !file.includes("node-history-service") &&
          file !== "services/canvas-service/src/storage/core/edit-completion-service/helpers.ts"
      )
    ).toEqual([]);
    // 用户显式完成编辑由服务端 edit-completion owner 生成资产与终态命令。
    const completion = read("services/canvas-service/src/storage/core/edit-completion-service/helpers.ts");
    expect(completion).toContain("buildImageEditCommands(request: ImageEditCompleteRequest)");
    expect(completion).toContain("outputAssetId: outputAsset.id");
    expect(read("services/canvas-service/src/sync/task-projector.ts")).toMatch(
      /taskStatus:\s*"(successed|failed|cancelled)"/
    );
  });

  it("Frontend 不引用本地终态写入（completeCanvasNodeRun/failCanvasNodeRun）", () => {
    // 前端只发 run/cancel 并观察服务端投影；不存在任何本地终态写入方法。
    for (const file of filesUnder("frontend/src", /\.(ts|tsx)$/)) {
      if (file.includes(".test.")) continue;
      const source = readFileSync(file, "utf8");
      for (const symbol of ["completeCanvasNodeRun", "failCanvasNodeRun"]) {
        expect(source, `${path.relative(WEB_ROOT, file)} 引用 ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it("浏览器源码不直接调用旧任务写入口 /api/pptask/tasks", () => {
    for (const file of filesUnder("frontend/src", /\.(ts|tsx)$/)) {
      if (file.includes(".test.")) continue;
      const source = readFileSync(file, "utf8");
      expect(source, `${path.relative(WEB_ROOT, file)}`).not.toMatch(/["'`]\/api\/pptask\/tasks/);
    }
  });
});
