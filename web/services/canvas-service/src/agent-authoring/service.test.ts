/**
 * Canvas Agent authoring 服务测试
 * （change: add-agent-canvas-authoring-mcp，任务 4.7 / design D9）。
 *
 * 覆盖局部前置条件、canonical 回执、幂等重复回执与 requestId 重用拒绝。
 */
import { describe, expect, it } from "vitest";
import { computeCommandPayloadHash, serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { AgentCanvasAuthoringService, checkAgentPreconditions, summarizeAppliedEntities } from "./service.js";
import type { CanvasRoom } from "../sync/index.js";
import type { ServerCanvas } from "@woohaa3/contracts";

function canvas(revision = 1): ServerCanvas {
  return {
    id: "c1",
    title: "画布",
    revision,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-09-28T00:00:00.000Z",
      nodes: [
        { id: "text-1", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
        { id: "img-1", type: "image", position: { x: 300, y: 0 }, width: 248, height: 232 }
      ],
      edges: []
    },
    nodeData: {
      "text-1": { prompt: "hi", taskKind: "text-generation", taskStatus: "idle" },
      "img-1": { prompt: "old", taskKind: "image-generation", taskStatus: "processing" }
    },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
}

/** 轻量 room 替身：用真实 Y.Doc 保持命令语义，并模拟 durable receipt。 */
function fakeRoom(initial: ServerCanvas) {
  const doc = serverCanvasToYDoc(initial);
  const receipts = new Map<string, { payloadHash: string; revision: number; changed: boolean }>();
  let revision = initial.revision;
  let idCounter = 0;
  const room = {
    canvasId: initial.id,
    exportCanvas: () => {
      const exported = yDocToServerCanvas(doc, { now: "2026-09-28T00:00:00.000Z" });
      return exported.ok ? { ok: true as const, canvas: exported.canvas } : { ok: false as const, message: "export failed" };
    },
    lookupCommand: async (commandId: string) => receipts.get(commandId) ?? null,
    submit: async (batch: { canvasId: string; commandId: string; commands: unknown[] }) => {
      const payloadHash = await computeCommandPayloadHash({ canvasId: batch.canvasId, commands: batch.commands as never });
      const existing = receipts.get(batch.commandId);
      if (existing && existing.payloadHash !== payloadHash) {
        return { ok: false as const, status: "rejected" as const, commandId: batch.commandId, code: "command-id-reused", message: "reused" };
      }
      void idCounter;
      revision += 1;
      receipts.set(batch.commandId, { payloadHash, revision, changed: true });
      return { ok: true as const, status: "accepted" as const, commandId: batch.commandId, revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom;
  return room;
}

function service(room: CanvasRoom) {
  return new AgentCanvasAuthoringService({ resolveRoom: async () => room });
}

describe("局部前置条件（任务 4.7 / design D9）", () => {
  it("prompt-equals 不匹配时失败并给出当前摘要", () => {
    const failure = checkAgentPreconditions(canvas(), [{ type: "prompt-equals", nodeId: "img-1", equals: "expected" }]);
    expect(failure).toMatchObject({ index: 0 });
    expect(failure?.message).toContain("prompt");
  });

  it("not-processing 在 processing 节点上失败", () => {
    expect(checkAgentPreconditions(canvas(), [{ type: "not-processing", nodeId: "img-1" }])).not.toBeNull();
    expect(checkAgentPreconditions(canvas(), [{ type: "not-processing", nodeId: "text-1" }])).toBeNull();
  });

  it("全部通过返回 null，无关节点变化不阻止", () => {
    expect(checkAgentPreconditions(canvas(), [{ type: "node-exists", nodeId: "text-1" }])).toBeNull();
    expect(checkAgentPreconditions(canvas(), [{ type: "node-missing", nodeId: "ghost" }])).toBeNull();
  });
});

describe("apply 幂等与回执（任务 4.7 / D3）", () => {
  const input = {
    canvasId: "c1",
    requestId: "req-1",
    commandId: "agent-plan:abc",
    payloadHash: "hash-1",
    baseRevision: 1,
    commands: [{ type: "nodeData.patch" as const, nodeId: "img-1", value: { prompt: "draw" } }]
  };

  it("首次提交返回 revision 与 canonical 实体", async () => {
    const svc = service(fakeRoom(canvas()));
    const outcome = await svc.apply(input);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision).toBe(2);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.nodes.map((node) => node.nodeId)).toContain("img-1");
  });

  it("相同 requestId + 相同 payload 返回首次回执且不重复应用", async () => {
    const room = fakeRoom(canvas());
    const svc = service(room);
    const first = await svc.apply(input);
    const retry = await svc.apply(input);
    if (!first.ok || !retry.ok) throw new Error("expected ok");
    expect(retry.duplicate).toBe(true);
    expect(retry.revision).toBe(first.revision);
  });

  it("相同 requestId + 不同 payload 返回 request-id-reused", async () => {
    const svc = service(fakeRoom(canvas()));
    await svc.apply(input);
    // 不同计划 ⇒ 不同命令 ⇒ 相同 commandId 的 payload 不一致。
    const conflict = await svc.apply({
      ...input,
      payloadHash: "hash-2",
      commands: [{ type: "nodeData.patch", nodeId: "text-1", value: { prompt: "different" } }]
    });
    expect(conflict).toMatchObject({ ok: false, code: "request-id-reused" });
  });

  it("前置条件失败时不写入", async () => {
    const svc = service(fakeRoom(canvas()));
    const outcome = await svc.apply({ ...input, preconditions: [{ type: "node-missing", nodeId: "img-1" }] });
    expect(outcome).toMatchObject({ ok: false, code: "precondition-failed", preconditionIndex: 0 });
  });
});

describe("canonical 摘要", () => {
  it("从提交后的画布派生节点/边，过滤无关实体", () => {
    const summary = summarizeAppliedEntities(canvas(), [{ type: "nodeData.patch", nodeId: "img-1", value: { prompt: "x" } }]);
    expect(summary.nodes.map((node) => node.nodeId)).toEqual(["img-1"]);
    expect(summary.nodes[0]).toMatchObject({ kind: "image", canonicalType: "image", prompt: "old" });
  });
});
