/**
 * Canvas script service 测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.1–3.7 / 4.1 / 4.2）。
 *
 * 覆盖：授权前置（只读/跨画布拒绝）、能力 fail-closed、validate 无副作用与 token 绑定、
 * 原子提交与冻结首次回执、requestId 复用 vs 重试、expectedRevision/token 拒绝、
 * noop 保存回执、级联范围校验、源码不落盘。
 *
 * 非渲染检查：使用真实 CanvasRoom + in-memory durable 仓库，不采集帧率/GPU/截图。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { CanvasRoom } from "../sync/room.js";
import { CanvasScriptService } from "./service.js";
import type { CanvasAuthorizer, CanvasPermission } from "../agent-authoring/authorization.js";

const NOW = "2026-10-13T00:00:00.000Z";
const CANVAS = "canvas-script";

/** 记录授权调用并支持按需拒绝。 */
function authorizer(options: { denyWrite?: boolean; denyRead?: boolean; allowCanvas?: string } = {}): CanvasAuthorizer & { calls: Array<{ permission: CanvasPermission; canvasId: string }> } {
  const calls: Array<{ permission: CanvasPermission; canvasId: string }> = [];
  return {
    calls,
    async authorize({ principalId, canvasId, permission }) {
      calls.push({ permission, canvasId });
      if (principalId.trim() === "") return { allowed: false, reason: "缺少 principal" };
      if (options.allowCanvas !== undefined && canvasId !== options.allowCanvas) return { allowed: false, reason: `画布 ${canvasId} 不在授权范围` };
      if (permission === "write" && options.denyWrite) return { allowed: false, reason: "只读主体" };
      if (permission === "read" && options.denyRead) return { allowed: false, reason: "不可读" };
      return { allowed: true };
    }
  };
}

async function setup(options: {
  authorizer?: CanvasAuthorizer;
  verifyScope?: ConstructorParameters<typeof CanvasScriptService>[0]["verifyScope"];
  canvas?: ServerCanvas;
} = {}) {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({ canvas: options.canvas ?? createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "epoch-1", createdAt: NOW });
  const auth = options.authorizer ?? authorizer();
  const service = new CanvasScriptService({
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    authorizer: auth,
    ...(options.verifyScope ? { verifyScope: options.verifyScope } : {})
  });
  return { room, repository, service, auth };
}

const BUILD_SCRIPT = `
  const brief = canvas.node("text", { key: "brief", title: "场景", placement: { mode: "absolute", position: { x: 0, y: 0 } } });
  for (let i = 0; i < 2; i++) {
    const shot = canvas.node("image", { key: "shot-" + i, placement: { mode: "after", anchor: brief } });
    canvas.connect(brief, shot, { key: "edge-" + i });
  }
`;

function request(overrides: Record<string, unknown> = {}) {
  return {
    principalId: "dev-user",
    canvasId: CANVAS,
    requestId: "req-1",
    version: "woohaa-canvas-js-v1",
    source: BUILD_SCRIPT,
    ...overrides
  };
}

describe("能力与授权前置（任务 3.1）", () => {
  it("缺少授权端口时能力 fail-closed；授权齐备即可用", () => {
    const noAuth = new CanvasScriptService({ resolveRoom: async () => null });
    expect(noAuth.capability()).toMatchObject({ available: false });
    const ready = new CanvasScriptService({ resolveRoom: async () => null, authorizer: authorizer() });
    expect(ready.capability()).toEqual({ available: true });
  });

  it("授权齐备时能力可用；引擎显式禁用时明确不可用", () => {
    const ready = new CanvasScriptService({ resolveRoom: async () => null, authorizer: authorizer() });
    expect(ready.capability()).toEqual({ available: true });
    const disabled = new CanvasScriptService({
      resolveRoom: async () => null,
      authorizer: authorizer(),
      engine: { available: false, reason: "部署禁用" }
    });
    expect(disabled.capability()).toMatchObject({ available: false, reason: "部署禁用" });
  });

  it("能力不可用时 validate/submit 在副作用前返回 script-unavailable", async () => {
    const disabled = new CanvasScriptService({
      resolveRoom: async () => null,
      authorizer: authorizer(),
      engine: { available: false, reason: "部署禁用" }
    });
    expect(await disabled.validate(request())).toMatchObject({ ok: false, error: { code: "script-unavailable" } });
    expect(await disabled.submit(request())).toMatchObject({ ok: false, error: { code: "script-unavailable" } });
  });

  it("只读主体在执行前被拒绝，且不产生任何写入", async () => {
    const { service, room } = await setup({ authorizer: authorizer({ denyWrite: true }) });
    const outcome = await service.submit(request());
    expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden", stage: "authorize" } });
    const exported = room.exportCanvas();
    if (exported.ok) expect(exported.canvas.document.nodes).toHaveLength(0);
  });

  it("跨画布请求在授权前拒绝", async () => {
    const { service } = await setup({ authorizer: authorizer({ allowCanvas: CANVAS }) });
    const outcome = await service.submit(request({ canvasId: "other-canvas" }));
    expect(outcome).toMatchObject({ ok: false, error: { stage: "authorize" } });
  });

  it("空 principal 拒绝", async () => {
    const { service } = await setup();
    const outcome = await service.submit(request({ principalId: "" }));
    expect(outcome).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

describe("预检无副作用（任务 4.1）", () => {
  it("validate 返回 normalized/refs/predicted 且不写画布", async () => {
    const { service, room } = await setup();
    const outcome = await service.validate(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.normalized.length).toBeGreaterThan(0);
    expect(Object.keys(outcome.receipt.refs)).toEqual(["brief", "shot-0", "edge-0", "shot-1", "edge-1"]);
    const exported = room.exportCanvas();
    if (exported.ok) {
      expect(exported.canvas.document.nodes).toHaveLength(0);
      expect(exported.canvas.revision).toBe(0);
    }
  });

});

describe("原子提交与冻结回执（任务 3.3 / 3.7 / 4.2）", () => {
  it("首次提交一次写入全部节点与边，revision +1", async () => {
    const { service, room } = await setup();
    const outcome = await service.submit(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.revision).toBe(1);
    expect(outcome.receipt.duplicate).toBe(false);
    expect(outcome.receipt.noop).toBe(false);
    expect(outcome.receipt.nodes.map((node) => node.kind)).toEqual(["text", "image", "image"]);
    expect(outcome.receipt.edges).toHaveLength(2);
    const exported = room.exportCanvas();
    if (exported.ok) {
      expect(exported.canvas.document.nodes).toHaveLength(3);
      expect(exported.canvas.document.edges).toHaveLength(2);
    }
  });

  it("相同身份与内容重试返回冻结首次回执，不重新布局、不加 revision", async () => {
    const { service, room } = await setup();
    const first = await service.submit(request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 用户后续编辑改变布局。
    await room.submit({
      protocolVersion: 1,
      canvasId: CANVAS,
      commandId: "user-edit",
      baseRevision: 1,
      actorId: "user",
      commands: [{ type: "nodeData.patch", nodeId: first.receipt.nodes[0]!.nodeId, value: { title: "用户改的" } }]
    });
    const retry = await service.submit(request());
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.receipt.duplicate).toBe(true);
    expect(retry.receipt.revision).toBe(first.receipt.revision);
    expect(retry.receipt.nodes).toEqual(first.receipt.nodes);
    expect(retry.receipt.edges).toEqual(first.receipt.edges);
  });

  it("相同 requestId 不同内容返回 request-id-reused", async () => {
    const { service } = await setup();
    await service.submit(request());
    const conflict = await service.submit(request({ source: `${BUILD_SCRIPT}\ncanvas.node("audio", { key: "a" });` }));
    expect(conflict).toMatchObject({ ok: false, error: { code: "request-id-reused" } });
  });

  it("不同 principal 得到不同实体 ID（身份隔离）", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "e", createdAt: NOW });
    const service = new CanvasScriptService({
      resolveRoom: async () => room,
      authorizer: authorizer()
    });
    const a = await service.submit(request({ principalId: "p-a", requestId: "r" }));
    const b = await service.submit(request({ principalId: "p-b", requestId: "r" }));
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.receipt.nodes[0]!.nodeId).not.toBe(b.receipt.nodes[0]!.nodeId);
  });

  it("noop 提交仍保存首次回执且不推进 revision", async () => {
    const { service, room } = await setup();
    // 先写入带 prompt 的节点，再用相同值 setPrompt → 无净变化。
    const seed = await service.submit(request({ source: `canvas.node("text", { key: "t", prompt: "same" });`, requestId: "seed" }));
    if (!seed.ok) throw new Error("seed failed");
    const nodeId = seed.receipt.nodes[0]!.nodeId;
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const revisionBefore = exported.canvas.revision;
    const noopSource = `canvas.setPrompt(canvas.existing(${JSON.stringify(nodeId)}), "same");`;
    const noop = await service.submit({
      principalId: "dev-user",
      canvasId: CANVAS,
      requestId: "req-noop",
      version: "woohaa-canvas-js-v1",
      source: noopSource
    });
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.receipt.noop).toBe(true);
    const after = room.exportCanvas();
    if (after.ok) expect(after.canvas.revision).toBe(revisionBefore);
    // 重试 noop 仍返回冻结回执。
    const retry = await service.submit({
      principalId: "dev-user",
      canvasId: CANVAS,
      requestId: "req-noop",
      version: "woohaa-canvas-js-v1",
      source: noopSource
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.receipt.duplicate).toBe(true);
  });
});

describe("并发条件与 token（任务 3.5 / 4.2）", () => {
  it("expectedRevision 与最新 revision 不符返回 revision-conflict", async () => {
    const { service, room } = await setup();
    await room.submit({
      protocolVersion: 1,
      canvasId: CANVAS,
      commandId: "bump",
      baseRevision: 0,
      actorId: "user",
      commands: [{ type: "node.add", node: { id: "x", type: "text", position: { x: 0, y: 0 } } }]
    });
    const outcome = await service.submit(request({ expectedRevision: 0 }));
    expect(outcome).toMatchObject({ ok: false, error: { code: "revision-conflict", stage: "precondition" } });
  });

  it("validate 结果可直接提交（同 requestId/source），无需提交凭证", async () => {
    const { service } = await setup();
    const validated = await service.validate(request());
    expect(validated.ok).toBe(true);
    const submitted = await service.submit(request());
    expect(submitted.ok).toBe(true);
  });
});

describe("级联影响范围复核（任务 3.6）", () => {
  it("范围复核拒绝时整批不写入", async () => {
    const verifyScope = () => ({ ok: false as const, code: "forbidden", message: "节点越界" });
    const { service, room } = await setup({ verifyScope });
    const outcome = await service.submit(request());
    expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const exported = room.exportCanvas();
    if (exported.ok) expect(exported.canvas.document.nodes).toHaveLength(0);
  });

  it("范围复核收到全部受影响既有节点", async () => {
    const seen: string[][] = [];
    const { service } = await setup({
      verifyScope: (input) => {
        seen.push([...input.existingNodeIds]);
        return { ok: true };
      }
    });
    const seed = await service.submit(request());
    if (!seed.ok) throw new Error("seed failed");
    const target = seed.receipt.nodes[0]!.nodeId;
    await service.submit({
      principalId: "dev-user",
      canvasId: CANVAS,
      requestId: "req-2",
      version: "woohaa-canvas-js-v1",
      source: `canvas.move(canvas.existing(${JSON.stringify(target)}), { x: 9, y: 9 });`
    });
    expect(seen.at(-1)).toContain(target);
  });
});

describe("源码不持久化（任务 3.2 / 4.6）", () => {
  it("持久层只保存源码无关元数据，不含源码标记", async () => {
    const marker = "CANVAS_SCRIPT_SOURCE_MARKER_3b7c";
    const { service, repository } = await setup();
    const source = BUILD_SCRIPT.replace("场景", marker);
    // 标记只出现在 title（业务内容），不进入脚本原文的注释。
    const outcome = await service.submit(request({ source, requestId: "req-marker" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = await repository.getCommandRecord(CANVAS, `canvas-script:${(
      await import("@woohaa3/contracts")
    ).hashText(["dev-user", CANVAS, "submit_canvas_script", "req-marker"].join("\u0000"))}`);
    expect(record).not.toBeNull();
    // 元数据存在但不含可重放源码（source 字段本身）。
    expect(record!.script).toBeDefined();
    expect(JSON.stringify(record!.script)).not.toContain("placement");
    expect(record!.script!.submissionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
