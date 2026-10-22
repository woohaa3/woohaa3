/**
 * 单图替换资格测试（change: add-paste-import-workflows，任务 5.1）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasNodeData, type ServerCanvas } from "@woohaa3/contracts";
import { evaluateReplaceEligibility } from "./replace-eligibility.js";
import type { ClassifiedFile } from "./datatransfer.js";

function imageFile(name = "a.png"): ClassifiedFile {
  return {
    file: new File(["x"], name, { type: "image/png" }),
    kind: "image",
    name,
    type: "image/png",
    size: 1,
    lastModified: 0
  };
}

function canvasWith(nodes: Array<{ id: string; type: string; data?: CanvasNodeData }>): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({ id: node.id, type: node.type, position: { x: 0, y: 0 } }))
    },
    nodeData: Object.fromEntries(nodes.map((node) => [node.id, node.data ?? {}])) as ServerCanvas["nodeData"]
  };
}

function input(overrides: Partial<Parameters<typeof evaluateReplaceEligibility>[0]> = {}) {
  return {
    files: [imageFile()],
    selectedNodeIds: ["n1"],
    canvas: canvasWith([{ id: "n1", type: "image" }]),
    writable: true,
    ...overrides
  };
}

describe("evaluateReplaceEligibility", () => {
  it("单图 + 单选 canonical image 节点时可用", () => {
    expect(evaluateReplaceEligibility(input())).toEqual({ eligible: true, nodeId: "n1" });
  });

  it("多图或多选不可替换", () => {
    expect(evaluateReplaceEligibility(input({ files: [imageFile(), imageFile("b.png")] })).eligible).toBe(false);
    expect(evaluateReplaceEligibility(input({ selectedNodeIds: ["n1", "n2"] })).eligible).toBe(false);
  });

  it("非图片文件不可替换", () => {
    const text: ClassifiedFile = { file: new File(["x"], "a.txt"), kind: "text", name: "a.txt", type: "text/plain", size: 1, lastModified: 0 };
    expect(evaluateReplaceEligibility(input({ files: [text] })).eligible).toBe(false);
  });

  it("processing 节点不可替换", () => {
    const canvas = canvasWith([{ id: "n1", type: "image", data: { taskStatus: "processing" } }]);
    expect(evaluateReplaceEligibility(input({ canvas })).eligible).toBe(false);
  });

  it("有 activeRunId 的未确认运行态不可替换", () => {
    const canvas = canvasWith([{ id: "n1", type: "image", data: { activeRunId: "run-1" } }]);
    expect(evaluateReplaceEligibility(input({ canvas })).eligible).toBe(false);
  });

  it("只读或非 image 节点不可替换", () => {
    expect(evaluateReplaceEligibility(input({ writable: false })).eligible).toBe(false);
    const canvas = canvasWith([{ id: "n1", type: "text" }]);
    expect(evaluateReplaceEligibility(input({ canvas })).eligible).toBe(false);
  });
});
