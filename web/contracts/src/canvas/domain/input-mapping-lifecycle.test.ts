/**
 * mapping 生命周期不变量（change: add-reference-inputs-and-mentions，任务 1.2 / 1.3）。
 */
import { describe, expect, it } from "vitest";
import {
  backfillInputMappingSlots,
  normalizeInputMappings,
  reorderInputMappings,
  validateInputMappingInvariants
} from "./input-mapping-lifecycle";
import type { CanvasNodeInputMapping } from "./types";

const role = (sourceNodeId: string) => (sourceNodeId.startsWith("t") ? "text_prompt" : "reference_image");

describe("validateInputMappingInvariants", () => {
  it("一致时无违规", () => {
    const mappings: CanvasNodeInputMapping[] = [
      { slotId: "s1", sourceNodeId: "a", role: "reference_image", sortKey: "0" },
      { slotId: "s2", sourceNodeId: "b", role: "reference_image", sortKey: "1" }
    ];
    expect(validateInputMappingInvariants({ nodeId: "n", incomingSources: ["a", "b"], mappings })).toEqual([]);
  });

  it("检测重复 slot / 重复 source / 缺 slot / 悬空 source", () => {
    const mappings: CanvasNodeInputMapping[] = [
      { slotId: "s1", sourceNodeId: "a", role: "reference_image", sortKey: "0" },
      { slotId: "s1", sourceNodeId: "b", role: "reference_image", sortKey: "1" },
      { sourceNodeId: "b", role: "reference_image", sortKey: "2" }
    ];
    const violations = validateInputMappingInvariants({ nodeId: "n", incomingSources: ["a", "b", "c"], mappings });
    const kinds = violations.map((violation) => violation.kind);
    expect(kinds).toContain("duplicate-slot");
    expect(kinds).toContain("missing-slot");
  });

  it("检测悬空 source", () => {
    const violations = validateInputMappingInvariants({
      nodeId: "n",
      incomingSources: [],
      mappings: [{ slotId: "s1", sourceNodeId: "ghost", role: "reference_image", sortKey: "0" }]
    });
    expect(violations.map((violation) => violation.kind)).toContain("unknown-source");
  });
});

describe("normalizeInputMappings", () => {
  it("保留已有 slotId，不重算", () => {
    const mappings: CanvasNodeInputMapping[] = [
      { slotId: "keep-me", sourceNodeId: "a", role: "reference_image", sortKey: "0", sourceAssetIds: ["asset-1"] }
    ];
    const result = normalizeInputMappings({ nodeId: "n", incomingSources: ["a"], mappings, roleForSource: role });
    expect(result[0]!.slotId).toBe("keep-me");
    expect(result[0]!.sourceAssetIds).toEqual(["asset-1"]);
  });

  it("为缺 mapping 的 incoming 补稳定 slot", () => {
    const result = normalizeInputMappings({ nodeId: "n", incomingSources: ["a", "b"], mappings: [], roleForSource: role });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((mapping) => mapping.slotId)).size).toBe(2);
    expect(validateInputMappingInvariants({ nodeId: "n", incomingSources: ["a", "b"], mappings: result })).toEqual([]);
  });

  it("删除悬空 source 并去重", () => {
    const mappings: CanvasNodeInputMapping[] = [
      { slotId: "s1", sourceNodeId: "a", role: "reference_image", sortKey: "0" },
      { slotId: "s2", sourceNodeId: "a", role: "reference_image", sortKey: "1" },
      { slotId: "s3", sourceNodeId: "ghost", role: "reference_image", sortKey: "2" }
    ];
    const result = normalizeInputMappings({ nodeId: "n", incomingSources: ["a"], mappings, roleForSource: role });
    expect(result).toHaveLength(1);
    expect(result[0]!.slotId).toBe("s1");
  });

  it("重复运行幂等", () => {
    const once = normalizeInputMappings({ nodeId: "n", incomingSources: ["a", "t1"], mappings: [], roleForSource: role });
    const twice = normalizeInputMappings({ nodeId: "n", incomingSources: ["a", "t1"], mappings: once, roleForSource: role });
    expect(twice.map((mapping) => mapping.slotId)).toEqual(once.map((mapping) => mapping.slotId));
  });
});

describe("reorderInputMappings", () => {
  it("只改 sortKey，保留 slotId/sourceAssetIds", () => {
    const mappings: CanvasNodeInputMapping[] = [
      { slotId: "s1", sourceNodeId: "a", role: "reference_image", sortKey: "0", sourceAssetIds: ["x"] },
      { slotId: "s2", sourceNodeId: "b", role: "reference_image", sortKey: "1" }
    ];
    const reordered = reorderInputMappings(mappings, ["b", "a"]);
    expect(reordered.map((mapping) => mapping.sourceNodeId)).toEqual(["b", "a"]);
    expect(reordered.map((mapping) => mapping.sortKey)).toEqual(["0", "1"]);
    const byId = new Map(reordered.map((mapping) => [mapping.sourceNodeId, mapping]));
    expect(byId.get("a")!.slotId).toBe("s1");
    expect(byId.get("a")!.sourceAssetIds).toEqual(["x"]);
    expect(byId.get("b")!.slotId).toBe("s2");
  });
});

describe("backfillInputMappingSlots", () => {
  const roleForSource = (_nodeId: string, sourceNodeId: string) =>
    sourceNodeId.startsWith("t") ? "text_prompt" : "reference_image";

  it("补齐缺失 slot 且重复运行不变", () => {
    const nodeData = {
      n1: { inputMapping: [{ sourceNodeId: "a", role: "reference_image", sortKey: "0" }] }
    };
    const first = backfillInputMappingSlots({
      nodeData,
      edges: [{ source: "a", target: "n1" }],
      nodeIds: ["n1", "a"],
      roleForSource
    });
    expect(first.changes).toHaveLength(1);
    expect(first.nodeData.n1!.inputMapping![0]!.slotId).toBeTruthy();

    const second = backfillInputMappingSlots({
      nodeData: first.nodeData,
      edges: [{ source: "a", target: "n1" }],
      nodeIds: ["n1", "a"],
      roleForSource
    });
    expect(second.changes).toEqual([]);
    expect(second.nodeData).toEqual(first.nodeData);
  });

  it("删除悬空 source 并稳定排序", () => {
    const result = backfillInputMappingSlots({
      nodeData: {
        n1: {
          inputMapping: [
            { slotId: "gone", sourceNodeId: "ghost", role: "reference_image", sortKey: "0" },
            { slotId: "s-b", sourceNodeId: "b", role: "reference_image", sortKey: "5" },
            { slotId: "s-a", sourceNodeId: "a", role: "reference_image", sortKey: "2" }
          ]
        }
      },
      edges: [
        { source: "a", target: "n1" },
        { source: "b", target: "n1" }
      ],
      nodeIds: ["n1", "a", "b"],
      roleForSource
    });
    const after = result.nodeData.n1!.inputMapping!;
    expect(after.map((mapping) => mapping.sourceNodeId)).toEqual(["a", "b"]);
    expect(after.map((mapping) => mapping.slotId)).toEqual(["s-a", "s-b"]);
  });
});
