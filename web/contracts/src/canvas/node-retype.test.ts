/**
 * 空节点改类型（image ↔ video）：生成面板「图片 / 视频」切换的权威命令
 *
 * 只允许没有任何结果、没有在途任务的节点；同一次命令里同步 taskKind，并清掉另一类型的模型与参数。
 */
import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { isCanvasCommandSatisfied } from "./command-satisfaction.js";
import { isCanvasCommand } from "./commands.js";

const NOW = "2026-11-03T00:00:00.000Z";

function canvasWith(type: string, data: Record<string, unknown>): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes = [{ id: "n", type, position: { x: 0, y: 0 }, width: 248, height: 232 }] as never;
  canvas.nodeData = { n: data } as never;
  return canvas;
}

const retype = (nodeType: "image" | "video") => [{ type: "node.update" as const, nodeId: "n", nodeType }];

describe("node.update { nodeType }", () => {
  it("空图片节点切成视频：类型与 taskKind 同步，模型与参数清掉，提示词保留", () => {
    const canvas = canvasWith("image", {
      taskKind: "image-generation", taskStatus: "idle", modelKey: "ppserver:img", parameters: { size: "2K" }, prompt: "一只猫", panelPrompt: "一只猫"
    });
    const result = applyCanvasCommands(canvas, retype("video"), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.nodes[0]!.type).toBe("video");
    const data = result.canvas.nodeData.n as Record<string, unknown>;
    expect(data.taskKind).toBe("video-generation");
    expect(data).not.toHaveProperty("modelKey");
    expect(data).not.toHaveProperty("parameters");
    expect(data.prompt).toBe("一只猫");
    expect(data.taskStatus).toBe("idle");
  });

  it("切回图片同样成立；类型没变是无操作", () => {
    const video = canvasWith("video", { taskKind: "video-generation", taskStatus: "idle" });
    const back = applyCanvasCommands(video, retype("image"), { now: NOW });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.canvas.document.nodes[0]!.type).toBe("image");
    expect((back.canvas.nodeData.n as Record<string, unknown>).taskKind).toBe("image-generation");

    const same = applyCanvasCommands(video, retype("video"), { now: NOW });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect((same.canvas.nodeData.n as Record<string, unknown>).modelKey).toBeUndefined();
  });

  it("已经有结果的节点拒绝，并且整批原子回滚", () => {
    const canvas = canvasWith("image", { taskKind: "image-generation", outputAssetId: "asset-1", modelKey: "ppserver:img" });
    const result = applyCanvasCommands(canvas, retype("video"), { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-node-retype");
    expect(canvas.document.nodes[0]!.type).toBe("image");
  });

  it("任务在途时拒绝；非图片/视频节点拒绝", () => {
    const running = applyCanvasCommands(canvasWith("image", { taskStatus: "processing", activeRunId: "r1" }), retype("video"), { now: NOW });
    expect(running.ok).toBe(false);
    if (!running.ok) expect(running.rejection.code).toBe("operation-in-progress");

    const text = applyCanvasCommands(canvasWith("text", { taskKind: "text-generation" }), retype("video"), { now: NOW });
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.rejection.code).toBe("invalid-node-retype");
  });

  it("命令解码只认 image / video；满足性按节点当前类型判定", () => {
    expect(isCanvasCommand({ type: "node.update", nodeId: "n", nodeType: "video" })).toBe(true);
    expect(isCanvasCommand({ type: "node.update", nodeId: "n", nodeType: "audio" })).toBe(false);

    const canvas = canvasWith("video", { taskKind: "video-generation" });
    expect(isCanvasCommandSatisfied(canvas, { type: "node.update", nodeId: "n", nodeType: "video" })).toBe(true);
    expect(isCanvasCommandSatisfied(canvas, { type: "node.update", nodeId: "n", nodeType: "image" })).toBe(false);
  });
});
