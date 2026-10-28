/**
 * ChatGPT 生成面板 → 宿主会话的纯派生单测
 * （change: 2026-10-12-add-agent-conversation-panel，任务 4.1/4.2/4.3 / design D3）。
 *
 * 只覆盖纯函数：目标动作/写范围冻结、对象动作缺 clipId 阻止、camera 稳定 id、终态判定。
 */
import { describe, expect, it } from "vitest";
import { buildGenerationEntryIntent, isEntryIntentSendable, isTerminalTurnStatus } from "../src/frontend/agent-intent.js";

describe("buildGenerationEntryIntent", () => {
  it("模型/片场为 generate，镜头为 modify，冻结账户模型与目标身份", () => {
    const model = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "model3d", prompt: "做一只猫", model: "gpt-6" });
    expect(model).toMatchObject({ action: "generate", mode: "model3d", model: "gpt-6", nodeId: "n1", canvasId: "cv" });

    const camera = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "camera", prompt: "拉近", model: "gpt-6", cameraId: "cam-2" });
    expect(camera.action).toBe("modify");
    expect(camera.cameraId).toBe("cam-2");

    const clip = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "film-set", prompt: "跳起来", model: "gpt-6", clipId: "clip-1", itemId: "item-3" });
    expect(clip).toMatchObject({ action: "generate", clipId: "clip-1", itemId: "item-3" });
  });
});

describe("isEntryIntentSendable", () => {
  it("对象动作缺 clipId 时不可发送（不退化成整体片场修改）", () => {
    const intent = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "film-set", prompt: "移动", model: "gpt-6", itemId: "item-3" });
    expect(isEntryIntentSendable(intent)).toBe(false);
  });

  it("带 clipId 的对象动作可发送；空提示词不可发送", () => {
    const ok = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "film-set", prompt: "移动", model: "gpt-6", clipId: "clip-1", itemId: "item-3" });
    expect(isEntryIntentSendable(ok)).toBe(true);
    const empty = buildGenerationEntryIntent({ canvasId: "cv", nodeId: "n1", mode: "model3d", prompt: "   ", model: "gpt-6" });
    expect(isEntryIntentSendable(empty)).toBe(false);
  });
});

describe("isTerminalTurnStatus", () => {
  it("终态包含 succeeded/partial/failed/cancelled；运行中仍需查询", () => {
    expect(isTerminalTurnStatus("succeeded")).toBe(true);
    expect(isTerminalTurnStatus("partial")).toBe(true);
    expect(isTerminalTurnStatus("failed")).toBe(true);
    expect(isTerminalTurnStatus("cancelled")).toBe(true);
    expect(isTerminalTurnStatus("running")).toBe(false);
  });
});
