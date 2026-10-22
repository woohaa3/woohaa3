/**
 * Agent authoring 端到端集成测试
 * （change: add-agent-canvas-authoring-mcp，任务 3.5 / 4.7 / 5.3 / 6.6 的 authoring 部分）。
 *
 * 用真实 `CanvasRoom` + in-memory Yjs repository（无浏览器会话）验证：
 * list -> capabilities -> graph -> validate -> apply plan -> 读回 canonical 图与增量。
 */
import { describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { CanvasRoom } from "../sync/room.js";
import { AgentCanvasAuthoringService } from "./service.js";
import { AgentCanvasInternalService } from "./internal-service.js";
import { AgentDeltaJournal } from "./delta-journal.js";
import { createDevelopmentAuthorizer } from "./authorization.js";
import type { ServerCanvas } from "@woohaa3/contracts";

const PRINCIPAL = "dev-user";

function emptyCanvas(): ServerCanvas {
  return {
    id: "c1",
    title: "集成画布",
    revision: 1,
    document: { schemaVersion: "asset-canvas-v1", updatedAt: "2026-09-28T00:00:00.000Z", nodes: [], edges: [] },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
}

async function makeService() {
  const repository = new InMemoryYjsDocumentRepository();
  const journal = new AgentDeltaJournal();
  const room = new CanvasRoom({
    canvasId: "c1",
    repository,
    now: () => "2026-09-28T00:00:00.000Z",
    bootstrap: async () => emptyCanvas(),
    onDelta: (input) => journal.record("c1", input.before, input.after)
  });
  await room.load();
  const authorizer = createDevelopmentAuthorizer({ developmentPrincipalId: PRINCIPAL, canvasIds: ["c1"] });
  const authoring = new AgentCanvasAuthoringService({ resolveRoom: async () => room });
  const service = new AgentCanvasInternalService({
    resolveRoom: async () => room,
    directory: {
      async list() {
        const exported = room.exportCanvas();
        const nodes = exported.ok ? exported.canvas.document.nodes.length : 0;
        return { canvases: [{ canvasId: "c1", title: "集成画布", revision: room.currentRevision, updatedAt: "x", nodeCount: nodes }] };
      }
    },
    authorizer,
    journal,
    authoring,
    defaultCanvasId: "c1"
  });
  return { service, room, journal };
}

describe("Agent authoring 无浏览器端到端（任务 6.6 authoring 部分）", () => {
  it("list -> graph -> apply -> graph -> changes 全链路", async () => {
    const { service, room } = await makeService();

    const list = await service.listCanvases({ principalId: PRINCIPAL });
    expect(list.canvases).toHaveLength(1);
    expect(list.canvases[0]).toMatchObject({ canvasId: "c1", revision: 1, nodeCount: 0 });

    const before = await service.readGraph({ principalId: PRINCIPAL, canvasId: "c1" });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.graph.nodes).toHaveLength(0);

    // create text -> image -> set_prompt -> connect，作为单个计划提交。
    const textId = "text-node";
    const imageId = "image-node";
    const outcome = await service.apply({
      principalId: PRINCIPAL,
      canvasId: "c1",
      requestId: "req-e2e",
      commandId: "cmd-e2e",
      payloadHash: "hash-e2e",
      baseRevision: 1,
      commands: [
        { type: "node.add", node: { id: textId, type: "text", position: { x: 0, y: 0 } }, nodeData: { taskKind: "text-generation", taskStatus: "idle", prompt: "hello" } },
        { type: "node.add", node: { id: imageId, type: "image", position: { x: 400, y: 0 } }, nodeData: { taskKind: "image-generation", taskStatus: "idle" } },
        { type: "edge.add", edge: { id: "edge-1", source: textId, target: imageId } },
        { type: "nodeData.patch", nodeId: imageId, value: { prompt: "draw a cat" } }
      ]
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision).toBe(2);
    expect(outcome.nodes.map((node) => node.nodeId).sort()).toEqual([imageId, textId].sort());

    // 读回 canonical 图。
    const after = await service.readGraph({ principalId: PRINCIPAL, canvasId: "c1", includePrompt: true });
    if (!after.ok) throw new Error("expected ok");
    expect(after.graph.revision).toBe(2);
    const image = after.graph.nodes.find((node) => node.nodeId === imageId);
    expect(image).toMatchObject({ kind: "image", canonicalType: "image", prompt: "draw a cat" });
    expect(image?.inputs).toEqual([{ sourceNodeId: textId, role: "text_prompt" }]);
    expect(after.graph.edges).toEqual([{ edgeId: "edge-1", source: textId, target: imageId }]);

    // 增量从 revision 1 到 2 可证明完整。
    const changes = await service.readChanges({ principalId: PRINCIPAL, canvasId: "c1", sinceRevision: 1 });
    expect(changes.ok).toBe(true);
    if (!changes.ok || !changes.delta) return;
    expect(changes.delta.currentRevision).toBe(2);
    expect(changes.delta.nodes.map((node) => node.nodeId).sort()).toEqual([imageId, textId].sort());

    // 相同 requestId 重试返回首次回执且不推进 revision。
    const retry = await service.apply({
      principalId: PRINCIPAL,
      canvasId: "c1",
      requestId: "req-e2e",
      commandId: "cmd-e2e",
      payloadHash: "hash-e2e",
      baseRevision: 1,
      commands: [
        { type: "node.add", node: { id: textId, type: "text", position: { x: 0, y: 0 } }, nodeData: { taskKind: "text-generation", taskStatus: "idle", prompt: "hello" } },
        { type: "node.add", node: { id: imageId, type: "image", position: { x: 400, y: 0 } }, nodeData: { taskKind: "image-generation", taskStatus: "idle" } },
        { type: "edge.add", edge: { id: "edge-1", source: textId, target: imageId } },
        { type: "nodeData.patch", nodeId: imageId, value: { prompt: "draw a cat" } }
      ]
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.duplicate).toBe(true);
    expect(retry.revision).toBe(2);
    expect(room.currentRevision).toBe(2);
  });

  it("未知画布授权被拒", async () => {
    const { service } = await makeService();
    const outcome = await service.readGraph({ principalId: PRINCIPAL, canvasId: "other" });
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("本地单用户默认画布：省略 canvasId 绑定默认副本", async () => {
    const { service } = await makeService();
    const outcome = await service.readGraph({ principalId: PRINCIPAL });
    expect(outcome.ok).toBe(true);
  });
});
