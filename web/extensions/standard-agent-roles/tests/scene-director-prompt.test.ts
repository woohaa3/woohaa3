/**
 * 导演区分段创作提示词快照
 * （change: 2026-11-10-add-incremental-world-model-authoring，任务 3.1 / 3.2）。
 *
 * 提示词是角色实现的事实源：大场景必须走「骨架 → 按构件追加 → patch → 回读」，
 * 且失败恢复只重试失败段。这里固定顺序与两条关键文案，避免后续改动悄悄退回
 * 「一次写完整个脚本」。
 */
import { describe, expect, it } from "vitest";
import { ASSISTANT_WORLD_TOOL } from "@woohaa3/contracts";
import { SCENE_DIRECTOR_FLOW } from "../src/backend/prompts.js";
import { sceneDirectorRole } from "../src/backend/roles/scene-director.js";

const text = sceneDirectorRole.definition.instructions;

function stepIndex(needle: string): number {
  const index = text.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  return index;
}

describe("导演区分段创作提示词", () => {
  it("包含三个分段写入/读取工具名", () => {
    for (const tool of [ASSISTANT_WORLD_TOOL.readModelScript, ASSISTANT_WORLD_TOOL.appendModelScript, ASSISTANT_WORLD_TOOL.patchModelScript]) {
      expect(text, tool).toContain(tool);
    }
    expect(text).toContain("append_world_model_script");
    expect(text).toContain("patch_world_model_script");
    expect(text).toContain("get_world_model_script");
  });

  it("规定分段顺序：骨架 → 追加 → patch → 回读", () => {
    const skeleton = stepIndex("用 create_world_model 只给 transform、省略 modelScript 建立骨架");
    const append = stepIndex("逐次调用 append_world_model_script");
    const patch = stepIndex("用 patch_world_model_script 定点修正");
    const readback = stepIndex("最后用 get_world_context 或 get_world_model_script 回读核对");
    expect(skeleton).toBeLessThan(append);
    expect(append).toBeLessThan(patch);
    expect(patch).toBeLessThan(readback);
  });

  it("写明每段必须可在尾部拼接与版本规则", () => {
    expect(text).toContain("每次 append 的 chunk 必须是可在脚本尾部直接拼接的完整语句块");
    expect(text).toContain("拼接结果等于「原脚本 + 各段按序拼接」");
    expect(text).toContain("宿主不插入分隔符、不重排");
    expect(text).toContain("expectedVersion 必须来自上一次成功回执");
    expect(text).toContain("不允许复用旧版本");
  });

  it("固定失败恢复文案：重读真实版本后只重试失败段", () => {
    const recovery = SCENE_DIRECTOR_FLOW.find(line => line.startsWith("追加/修补失败后的恢复："));
    expect(recovery).toBe(
      "追加/修补失败后的恢复：version-conflict（或 version-unknown）时先用 get_world_model_script（includeSource=true 可取脚本）或 get_world_context 读取真实版本与真实脚本，再用新版本重试这一段；只重试失败的那一段，不要重复写入此前已经成功的段，也不要把整段脚本换成 replace_world_model_content 绕过。patch-not-found 时按回执给出的最近相似片段与行号带上更长上下文重试；patch-ambiguous 时按命中行号加长 oldString 使其唯一；patch-noop 表示没有变化，不要再提交。outside-scope 表示目标不可写，如实说明并请用户确认范围，不能换对象绕过。"
    );
    expect(recovery).toContain("不要重复写入此前已经成功的段");
  });

  it("保留小场景整段快路径与骨架中间态说明", () => {
    expect(text).toContain("只有单个小构件（一个石灯笼、一个箱子、一棵树）才用整段 create_world_model 快路径");
    expect(text).toContain("骨架模型在脚本追加之前不参与渲染");
  });

  it("角色声明把新工具留给可选面且仍以读上下文为必需项", () => {
    expect(sceneDirectorRole.definition.tools.required).toEqual([ASSISTANT_WORLD_TOOL.readContext]);
    for (const tool of [ASSISTANT_WORLD_TOOL.readModelScript, ASSISTANT_WORLD_TOOL.appendModelScript, ASSISTANT_WORLD_TOOL.patchModelScript]) {
      expect(sceneDirectorRole.definition.tools.optional, tool).toContain(tool);
    }
    const prepared = sceneDirectorRole.prepare({
      input: { prompt: "生成一座大型宫殿", action: "generate" },
      context: {},
      target: { canvasId: "canvas", nodeId: "area", mode: "world", worldScope: { kind: "scene-area", areaId: "area-1" } },
      requestId: "req-chunk",
      nativeCapabilities: []
    });
    expect(prepared.tools).toEqual(expect.arrayContaining([
      ASSISTANT_WORLD_TOOL.readModelScript,
      ASSISTANT_WORLD_TOOL.appendModelScript,
      ASSISTANT_WORLD_TOOL.patchModelScript
    ]));
  });
});
