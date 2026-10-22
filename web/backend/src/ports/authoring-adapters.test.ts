/**
 * 进程内 authoring/工具委托适配器测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 3.4–3.6）。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { ApplicationUserDelegation } from "@woohaa3/contracts";
import { createInProcessAuthoringServices, createToolGrantRegistry } from "./authoring-adapters.js";

const DELEGATION: ApplicationUserDelegation = { subject: "user-a", authLevel: "authenticated" };

it("does not revoke another owner's group grant with a colliding request identity", () => {
  const registry = createToolGrantRegistry();
  const grant = { token: "a", workId: "same-request", canvasIds: ["canvas"], nodeIds: [], tools: ["get_canvas_graph"], maxCalls: 24, expiresAt: Date.now() + 60_000, groupScope: { canvasId: "canvas", rootGroupId: "root", scopeEpoch: 0 } };
  registry.issue(grant, "user-a"); registry.issue({ ...grant, token: "b" }, "user-b");
  registry.revoke("same-request");
  expect(registry.verify("a")).not.toBeNull();
  registry.revoke("same-request", "user-a");
  expect(registry.verify("a")).toBeNull(); expect(registry.verify("b")).not.toBeNull();
});

function fakeCanvas(options: { modelMcp?: unknown } = {}): CanvasService {
  const submitted: unknown[] = [];
  const modelMcp = {
    getModelNode: vi.fn(async () => ({
      ok: true as const,
      nodeType: "model3d",
      title: "m",
      prompt: "",
      source: "scene.box({});",
      references: [],
      modelContentVersion: { revision: 3, sourceHash: "s", contentHash: "c" },
      cameras: []
    })),
    submitScript: vi.fn(async (input: { requestId: string }) => {
      submitted.push(input);
      return { ok: true as const, canvasId: "cv", nodeId: "n", commandId: `cmd-${input.requestId}`, idempotent: false };
    }),
    mutateCamerasBatch: vi.fn(async () => ({ ok: true as const, canvasId: "cv", nodeId: "n", commandId: "cmd-cam", duplicate: false, noop: false }))
  };
  const canvas = {
    mcpServices: () => ({
      modelMcp: options.modelMcp === null ? null : modelMcp,
      agent: null,
      createFilmSetNode: null,
      importModelSnapshot: null,
      commitAnimation: async (input: { requestId: string }) => ({ ok: true as const, canvasId: "cv", nodeId: "n", commandId: `cmd-anim-${input.requestId}`, duplicate: false, noop: false }),
      confirmAdaptation: null,
      readAnimation: null
    }),
    _submitted: submitted
  } as unknown as CanvasService;
  return canvas;
}

describe("进程内 authoring 适配器", () => {
  it("读取权威节点上下文，保留既有脚本", async () => {
    const services = createInProcessAuthoringServices({ canvas: fakeCanvas() });
    const read = await services.authoring.readNode({ delegation: DELEGATION, canvasId: "cv", nodeId: "n" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.source).toContain("scene.box");
      expect(read.modelContentVersion?.revision).toBe(3);
    }
  });

  it("提交使用 operationId 作为幂等键", async () => {
    const canvas = fakeCanvas();
    const services = createInProcessAuthoringServices({ canvas });
    const out = await services.authoring.submitModel({
      delegation: DELEGATION,
      operationId: "op-1",
      canvasId: "cv",
      nodeId: "n",
      source: "scene.box({});"
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.commandId).toBe("cmd-op-1");
  });

  it("缺少可信委托时拒绝（不越权）", async () => {
    const services = createInProcessAuthoringServices({ canvas: fakeCanvas() });
    await expect(
      services.authoring.submitModel({ delegation: undefined as never, operationId: "op", canvasId: "cv", nodeId: "n", source: "x" })
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("媒体参考解析经受限签名，不交出存储凭据", async () => {
    const services = createInProcessAuthoringServices({
      canvas: fakeCanvas(),
      mediaSign: async (key) => ({ ok: true, url: `/media/${key}` })
    });
    const resolved = await services.references.resolve({ delegation: DELEGATION, storageKey: "k1" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.url).toBe("/media/k1");
  });

  it("工具 grant 绑定目标、过期与预算", async () => {
    let now = 1_000;
    const registry = createToolGrantRegistry(() => now);
    registry.issue({ token: "t1", canvasIds: ["c1"], nodeIds: ["n1"], tools: ["get_model_node"], maxCalls: 2, expiresAt: 2_000, ...( { workId: "w1" } as object) } as never);
    expect(registry.verify("t1")).not.toBeNull();
    expect(registry.consume("t1")).toBe(true);
    expect(registry.consume("t1")).toBe(true);
    expect(registry.consume("t1")).toBe(false); // 预算耗尽
    now = 3_000;
    expect(registry.verify("t1")).toBeNull(); // 过期
    registry.revoke("w1");
  });

  it("工具入口 authorize 强制工具/画布/节点范围与预算（任务 3.6）", () => {
    let now = 1_000;
    const registry = createToolGrantRegistry(() => now);
    registry.issue({
      token: "g1",
      canvasIds: ["c1"],
      nodeIds: ["n1"],
      tools: ["submit_model_script", "set_model_camera"],
      maxCalls: 2,
      expiresAt: 2_000,
      workId: "w1"
    } as never);

    // 允许的工具与目标。
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true });
    // 未在允许集合的工具。
    expect(registry.authorize({ token: "g1", tool: "create_film_set_node", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: false, reason: "tool-not-allowed" });
    // 越界画布 / 节点。
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c2", nodeId: "n1" })).toEqual({ ok: false, reason: "canvas-not-allowed" });
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c1", nodeId: "n2" })).toEqual({ ok: false, reason: "node-not-allowed" });
    // 预算只被成功调用消耗：前两次成功用尽。
    expect(registry.authorize({ token: "g1", tool: "set_model_camera", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true });
    expect(registry.authorize({ token: "g1", tool: "set_model_camera", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: false, reason: "budget-exhausted" });

    // 未知 token / 过期。
    expect(registry.authorize({ token: "nope", tool: "x" })).toEqual({ ok: false, reason: "unknown-grant" });
    registry.issue({ token: "g2", canvasIds: ["c1"], nodeIds: [], tools: [], maxCalls: 5, expiresAt: 1_500, workId: "w2" } as never);
    now = 2_000;
    expect(registry.authorize({ token: "g2", tool: "whatever", canvasId: "c1" })).toEqual({ ok: false, reason: "expired" });

    // 空 tools 表示允许任意工具；空 nodeIds 表示任意节点。
    registry.issue({ token: "g3", canvasIds: [], nodeIds: [], tools: [], maxCalls: 1, expiresAt: 9_000, workId: "w3" } as never);
    expect(registry.authorize({ token: "g3", tool: "any_tool", canvasId: "cX", nodeId: "nY" })).toEqual({ ok: true });
  });
  it("captured camera grants reject other cameras and unrelated writes", () => {
    const registry = createToolGrantRegistry(() => 1000);
    registry.issue({ token: "camera", canvasIds: ["c"], nodeIds: ["n"], tools: ["update_model_camera"], cameraId: "scene-camera", maxCalls: 1, expiresAt: 2000 });
    const call = { token: "camera", tool: "update_model_camera", canvasId: "c", nodeId: "n", cameraId: "scene-camera" };
    expect(registry.authorize({ ...call, cameraId: "other" })).toEqual({ ok: false, reason: "camera-not-allowed" });
    expect(registry.authorize({ ...call, cameraId: undefined })).toEqual({ ok: false, reason: "camera-not-allowed" });
    expect(registry.authorize({ ...call, tool: "submit_model_script" }).ok).toBe(false);
    expect(registry.authorize(call)).toEqual({ ok: true });
  });
  it("captured clip and actor grants reject switched targets without consuming valid-call budget", () => {
    const registry = createToolGrantRegistry(() => 1000);
    registry.issue({ token: "actor", canvasIds: ["c"], nodeIds: ["n"], tools: ["mutate_film_set_clip"], clipId: "jump", itemId: "hero", maxCalls: 1, expiresAt: 2000 });
    const call = { token: "actor", tool: "mutate_film_set_clip", canvasId: "c", nodeId: "n", clipId: "jump", itemId: "hero" };
    expect(registry.authorize({ ...call, clipId: "walk" })).toEqual({ ok: false, reason: "clip-not-allowed" });
    expect(registry.authorize({ ...call, itemId: "other" })).toEqual({ ok: false, reason: "item-not-allowed" });
    expect(registry.authorize({ ...call, itemId: undefined })).toEqual({ ok: false, reason: "item-not-allowed" });
    expect(registry.authorize(call)).toEqual({ ok: true });
    expect(registry.authorize(call)).toEqual({ ok: false, reason: "budget-exhausted" });
  });

});
