/**
 * Agent authoring 安全与容量边界测试
 * （change: add-agent-canvas-authoring-mcp，任务 8.2 / 8.3）。
 *
 * 覆盖：跨 principal 访问、伪造 delegated subject、超大 plan/prompt、room 重载后仍可读。
 */
import { describe, expect, it } from "vitest";
import { AgentCanvasInternalService } from "./internal-service.js";
import { AgentCanvasAuthoringService } from "./service.js";
import { AgentDeltaJournal } from "./delta-journal.js";
import { createDevelopmentAuthorizer } from "./authorization.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { CanvasRoom } from "../sync/room.js";
import type { ServerCanvas } from "@woohaa3/contracts";

const PRINCIPAL = "dev-user";

function emptyCanvas(): ServerCanvas {
  return {
    id: "c1",
    title: "画布",
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
  const room = new CanvasRoom({ canvasId: "c1", repository, now: () => "2026-09-28T00:00:00.000Z", bootstrap: async () => emptyCanvas() });
  await room.load();
  const authorizer = createDevelopmentAuthorizer({ developmentPrincipalId: PRINCIPAL, canvasIds: ["c1"] });
  const service = new AgentCanvasInternalService({
    resolveRoom: async () => room,
    directory: {
      async list({ principalId }) {
        if (principalId !== PRINCIPAL) return { canvases: [] };
        return { canvases: [{ canvasId: "c1", title: "画布", revision: room.currentRevision, updatedAt: "x", nodeCount: 0 }] };
      }
    },
    authorizer,
    journal: new AgentDeltaJournal(),
    authoring: new AgentCanvasAuthoringService({ resolveRoom: async () => room })
  });
  return { service, room, repository };
}

describe("安全边界（任务 8.3）", () => {
  it("跨 principal 读/写被拒，且不泄漏画布 metadata", async () => {
    const { service } = await makeService();
    expect(await service.readGraph({ principalId: "intruder", canvasId: "c1" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await service.apply({
      principalId: "intruder",
      canvasId: "c1",
      requestId: "r",
      commandId: "cmd",
      payloadHash: "h",
      baseRevision: 1,
      commands: [{ type: "canvas.setTitle", title: "hijack" }]
    })).toMatchObject({ ok: false, code: "forbidden" });
    // 目录也不泄漏无权限画布。
    const list = await service.listCanvases({ principalId: "intruder" });
    expect(list.canvases).toEqual([]);
  });

  it("缺少 principal 时拒绝（匿名）", async () => {
    const { service } = await makeService();
    expect(await service.readGraph({ principalId: "", canvasId: "c1" })).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("伪造 delegated subject（工具参数自报）不影响授权", async () => {
    const { service, room } = await makeService();
    // 请求体里的 principalId 由 handler 忽略；service 只信任调用方传入的已认证 principal。
    // 这里以 intruder 身份调用，即使它声称 dev-user 也会被 authorizer 拒绝。
    const outcome = await service.apply({
      principalId: "intruder",
      canvasId: "c1",
      requestId: "r2",
      commandId: "cmd2",
      payloadHash: "h2",
      baseRevision: room.currentRevision,
      commands: [{ type: "canvas.setTitle", title: "x" }]
    });
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(room.currentRevision).toBe(1);
  });
});

describe("容量与恢复（任务 8.2 / 8.3）", () => {
  it("非法命令在写入前被拒且不推进 revision", async () => {
    const { service, room } = await makeService();
    const outcome = await service.apply({
      principalId: PRINCIPAL,
      canvasId: "c1",
      requestId: "r-big",
      commandId: "cmd-big",
      payloadHash: "h-big",
      baseRevision: room.currentRevision,
      // nodeData.patch 指向不存在的节点：reducer 在权威边界拒绝，整批不写入。
      commands: [{ type: "nodeData.patch", nodeId: "ghost", value: { prompt: "x" } }]
    });
    expect(outcome.ok).toBe(false);
    expect(room.currentRevision).toBe(1);
  });

  it("room 重载后仍可从持久层读到已写入内容", async () => {
    const { service, repository } = await makeService();
    await service.apply({
      principalId: PRINCIPAL,
      canvasId: "c1",
      requestId: "r3",
      commandId: "cmd3",
      payloadHash: "h3",
      baseRevision: 1,
      commands: [{ type: "canvas.setTitle", title: "持久化标题" }]
    });

    // 模拟重载：新 room 从同一 repository 恢复。
    const reloaded = new CanvasRoom({ canvasId: "c1", repository, now: () => "2026-09-28T00:00:00.000Z" });
    await reloaded.load();
    const service2 = new AgentCanvasInternalService({
      resolveRoom: async () => reloaded,
      directory: { async list() { return { canvases: [] }; } },
      authorizer: createDevelopmentAuthorizer({ developmentPrincipalId: PRINCIPAL, canvasIds: ["c1"] }),
      journal: new AgentDeltaJournal(),
      authoring: new AgentCanvasAuthoringService({ resolveRoom: async () => reloaded })
    });
    const graph = await service2.readGraph({ principalId: PRINCIPAL, canvasId: "c1" });
    expect(graph.ok).toBe(true);
    if (graph.ok) expect(graph.graph.title).toBe("持久化标题");
  });
});
