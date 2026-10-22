/**
 * 有界 revision delta 日志测试
 * （change: add-agent-canvas-authoring-mcp，任务 3.4）。
 *
 * 覆盖连续增量合并、缺口/压缩返回 null（resetRequired）、空 delta。
 */
import { describe, expect, it } from "vitest";
import { AgentDeltaJournal } from "./delta-journal.js";
import type { ServerCanvas } from "@woohaa3/contracts";

function canvas(revision: number, nodes: Array<{ id: string; type: string }>): ServerCanvas {
  return {
    id: "c1",
    title: "画布",
    revision,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-09-28T00:00:00.000Z",
      nodes: nodes.map((node) => ({ id: node.id, type: node.type, position: { x: 0, y: 0 } })),
      edges: []
    },
    nodeData: Object.fromEntries(nodes.map((node) => [node.id, {}])),
    assets: [],
    jobs: [],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
}

describe("AgentDeltaJournal（任务 3.4）", () => {
  it("连续增量合并为 changed nodes 与 tombstones", () => {
    const journal = new AgentDeltaJournal();
    const v1 = canvas(1, [{ id: "a", type: "text" }]);
    const v2 = canvas(2, [{ id: "a", type: "text" }, { id: "b", type: "image" }]);
    const v3 = canvas(3, [{ id: "b", type: "image" }]);
    journal.record("c1", v1, v2);
    journal.record("c1", v2, v3);

    const delta = journal.deltaFor("c1", 1, 3);
    expect(delta).not.toBeNull();
    expect(delta?.nodes.map((node) => node.nodeId)).toContain("b");
    expect(delta?.deletedNodeIds).toEqual(["a"]);
  });

  it("sinceRevision === currentRevision 返回空增量", () => {
    const journal = new AgentDeltaJournal();
    journal.record("c1", canvas(1, []), canvas(2, [{ id: "a", type: "text" }]));
    const delta = journal.deltaFor("c1", 2, 2);
    expect(delta).toEqual({ nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [] });
  });

  it("缺口/未知起点返回 null（resetRequired）", () => {
    const journal = new AgentDeltaJournal();
    journal.record("c1", canvas(5, []), canvas(6, [{ id: "a", type: "text" }]));
    expect(journal.deltaFor("c1", 1, 6)).toBeNull();
    expect(journal.deltaFor("unknown", 0, 1)).toBeNull();
  });

  it("超过窗口的起点返回 null", () => {
    const journal = new AgentDeltaJournal(2);
    journal.record("c1", canvas(1, []), canvas(2, [{ id: "a", type: "text" }]));
    journal.record("c1", canvas(2, [{ id: "a", type: "text" }]), canvas(3, [{ id: "a", type: "text" }, { id: "b", type: "image" }]));
    journal.record("c1", canvas(3, [{ id: "a", type: "text" }, { id: "b", type: "image" }]), canvas(4, [{ id: "b", type: "image" }]));
    // 起点 1 已滚出 2 长度窗口。
    expect(journal.deltaFor("c1", 1, 4)).toBeNull();
    expect(journal.deltaFor("c1", 3, 4)).not.toBeNull();
  });
});
