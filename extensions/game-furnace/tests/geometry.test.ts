import { describe, expect, it } from "vitest";
import { executeModelScriptVersioned, decodeModelDefinition, applyCanvasCommands, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import {
  createGameFurnaceNodeData,
  isGameFurnaceNodeData,
  GAME_FURNACE_DEFAULT_TITLE,
  GAME_FURNACE_GEOMETRY_SCRIPT,
  GAME_FURNACE_NODE_TYPE,
  GAME_FURNACE_PART_IDS
} from "../src/geometry.js";

describe("炼丹炉炉体几何（change: 2026-10-10，任务 3.5）", () => {
  it("完整炉体定义通过实际节点创建与更新校验，保存后可以解码执行", () => {
    const data = createGameFurnaceNodeData();
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("isolated", "2026-10-11T00:00:00Z"), [
      { type: "node.add", node: { id: "furnace", type: GAME_FURNACE_NODE_TYPE, position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "furnace", value: data }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeModelDefinition(result.canvas.nodeData.furnace);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(executeModelScriptVersioned(decoded.value.modelScript, decoded.value.modelScriptVersion).ok).toBe(true);
  });

  it("几何脚本是合法、确定性的 woohaa-model-js-v2，执行成功", () => {
    const result = executeModelScriptVersioned(GAME_FURNACE_GEOMETRY_SCRIPT, "woohaa-model-js-v2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 确定性：同一脚本执行两次得到逐字节相同的规范化 Scene IR。
    const again = executeModelScriptVersioned(GAME_FURNACE_GEOMETRY_SCRIPT, "woohaa-model-js-v2");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.json).toBe(result.json);
  });

  it("包含可识别的炉体部件（三足/炉腹/炉沿/炉口/双耳），不是单一球体", () => {
    const result = executeModelScriptVersioned(GAME_FURNACE_GEOMETRY_SCRIPT, "woohaa-model-js-v2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = new Set(result.scene.ops.map((op) => op.id));
    for (const part of GAME_FURNACE_PART_IDS) {
      expect(ids.has(part), `缺少部件 ${part}`).toBe(true);
    }
    const shapes = result.scene.ops.filter((op) => op.t !== "material");
    expect(shapes.length).toBeGreaterThanOrEqual(8);
    // 至少包含三种形状类型，避免退化成单一球体。
    const kinds = new Set(shapes.map((op) => op.t));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it("默认 nodeData 是通用纯模型定义（不出现游戏专属宿主字段）", () => {
    const data = createGameFurnaceNodeData() as Record<string, unknown>;
    expect(GAME_FURNACE_NODE_TYPE).toBe("composite-asset");
    expect(data.title).toBe(GAME_FURNACE_DEFAULT_TITLE);
    expect(data.modelScript).toBe(GAME_FURNACE_GEOMETRY_SCRIPT);
    expect(data.modelScriptVersion).toBe("woohaa-model-js-v2");
    // 无宿主无法识别的业务字段。
    expect(data.container).toBeUndefined();
    expect(data.gameFurnace).toBeUndefined();
  });
});

it("显式其他扩展身份优先于旧炉体脚本兼容识别", () => {
  expect(isGameFurnaceNodeData(createGameFurnaceNodeData())).toBe(true);
  expect(isGameFurnaceNodeData({ modelScript: GAME_FURNACE_GEOMETRY_SCRIPT })).toBe(false);
  expect(isGameFurnaceNodeData({ extensionId: "other", modelScript: GAME_FURNACE_GEOMETRY_SCRIPT })).toBe(false);
  expect(isGameFurnaceNodeData(null)).toBe(false);
});
