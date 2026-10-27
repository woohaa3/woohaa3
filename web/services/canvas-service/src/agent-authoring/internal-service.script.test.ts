/**
 * Agent Canvas script 内部能力面集成测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 4.3–4.5）。
 *
 * 统一后端进程内路径：`AgentCanvasInternalService.scriptCapability/validateScript/submitScript`
 * 直接调用真实 `CanvasScriptService`（真实 CanvasRoom + in-memory durable 仓库）。
 * 覆盖：能力投影、fail-closed 未装配、预检 token、原子提交回执与重试幂等。
 *
 * 非渲染检查：不采集帧率/GPU/截图。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { CanvasRoom } from "../sync/room.js";
import { CanvasScriptService } from "../canvas-script/service.js";
import { AgentCanvasAuthoringService } from "./service.js";
import { AgentCanvasInternalService } from "./internal-service.js";
import { AgentDeltaJournal } from "./delta-journal.js";
import type { CanvasAuthorizer } from "./authorization.js";

const PRINCIPAL = "dev-user";
const CANVAS = "c-script";
const NOW = "2026-10-13T00:00:00.000Z";

const SOURCE = `
  const brief = canvas.node("text", { key: "brief", title: "场景" });
  canvas.node("image", { key: "shot", placement: { mode: "after", anchor: brief } });
`;

function authorizer(): CanvasAuthorizer {
  return {
    async authorize({ principalId, canvasId }) {
      if (principalId !== PRINCIPAL) return { allowed: false, reason: "principal 不在白名单" };
      if (canvasId !== CANVAS) return { allowed: false, reason: `画布 ${canvasId} 不在白名单` };
      return { allowed: true };
    }
  };
}

async function setup(options: { wireScript?: boolean } = {}) {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "epoch-1", createdAt: NOW });
  const auth = authorizer();
  const journal = new AgentDeltaJournal();
  const script =
    options.wireScript === false
      ? undefined
      : new CanvasScriptService({
          resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
          authorizer: auth
        });
  const service = new AgentCanvasInternalService({
    resolveRoom: async () => room,
    directory: { async list() { return { canvases: [] }; } },
    authorizer: auth,
    journal,
    authoring: new AgentCanvasAuthoringService({ resolveRoom: async () => room }),
    ...(script ? { script } : {}),
    defaultCanvasId: CANVAS
  });
  return { service, room };
}

describe("Agent Canvas script 内部能力面（任务 4.3–4.5）", () => {
  it("能力可用时投影 descriptor 与可用节点种类", async () => {
    const { service } = await setup();
    const capability = await service.scriptCapability({ principalId: PRINCIPAL, canvasId: CANVAS });
    expect(capability).toMatchObject({ ok: true, available: true });
    if (!capability.ok || !capability.available) throw new Error("unexpected");
    expect(capability.descriptor).toBeDefined();
    expect(capability.nodeKinds?.length).toBeGreaterThan(0);
  });

  it("未装配 script 时能力 fail-closed，不静默替代", async () => {
    const { service } = await setup({ wireScript: false });
    expect(await service.scriptCapability({ principalId: PRINCIPAL, canvasId: CANVAS })).toMatchObject({
      ok: true,
      available: false,
      reason: expect.stringContaining("未装配")
    });
    expect(await service.submitScript({ principalId: PRINCIPAL, canvasId: CANVAS, requestId: "r0", version: "woohaa-canvas-js-v1", source: SOURCE }))
      .toMatchObject({ ok: false, error: { code: "script-unavailable" } });
  });

  it("越权主体在任何副作用前被拒绝", async () => {
    const { service, room } = await setup();
    const outcome = await service.submitScript({ principalId: "intruder", canvasId: CANVAS, requestId: "r1", version: "woohaa-canvas-js-v1", source: SOURCE });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(room.currentRevision).toBe(0);
  });

  it("validate 后 submit 原子提交并返回首次回执", async () => {
    const { service, room } = await setup();
    const validated = await service.validateScript({ principalId: PRINCIPAL, canvasId: CANVAS, requestId: "r2", version: "woohaa-canvas-js-v1", source: SOURCE });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const submitted = await service.submitScript({
      principalId: PRINCIPAL,
      canvasId: CANVAS,
      requestId: "r2",
      version: "woohaa-canvas-js-v1",
      source: SOURCE
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.receipt.nodes).toHaveLength(2);
    expect(submitted.receipt.revision).toBe(1);
    expect(submitted.receipt.duplicate).toBe(false);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(exported.canvas.document.nodes).toHaveLength(2);
  });

  it("组脚本可以创建自包含片场节点", async () => {
    const { service, room } = await setup();
    const source = `canvas.node("film-set", { key: "studio", title: "片场" });`;
    const submitted = await service.submitScript({
      principalId: PRINCIPAL,
      canvasId: CANVAS,
      requestId: "film-set-node",
      version: "woohaa-canvas-js-v1",
      source
    });
    expect(submitted.ok).toBe(true);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      const node = exported.canvas.document.nodes.find(entry => entry.type === "composite-asset");
      expect(node).toBeDefined();
      expect(node && exported.canvas.nodeData[node.id]).toMatchObject({ extensionId: "film-set", filmSetContent: { items: [] } });
    }
  });

  it("重试相同 requestId 返回冻结首次回执（duplicate），不推进 revision", async () => {
    const { service, room } = await setup();
    const first = await service.submitScript({ principalId: PRINCIPAL, canvasId: CANVAS, requestId: "r3", version: "woohaa-canvas-js-v1", source: SOURCE });
    expect(first.ok).toBe(true);
    const second = await service.submitScript({ principalId: PRINCIPAL, canvasId: CANVAS, requestId: "r3", version: "woohaa-canvas-js-v1", source: SOURCE });
    expect(second).toMatchObject({ ok: true, receipt: { duplicate: true, revision: 1 } });
    expect(room.currentRevision).toBe(1);
  });
});
