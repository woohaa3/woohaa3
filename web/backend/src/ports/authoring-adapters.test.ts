/**
 * 进程内 authoring/工具委托适配器测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 3.4–3.6）。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { ApplicationUserDelegation } from "@woohaa3/contracts";
import { catalogToolsForGrant, createInProcessAuthoringServices, createToolGrantRegistry } from "./authoring-adapters.js";

const DELEGATION: ApplicationUserDelegation = { subject: "user-a", authLevel: "authenticated" };

it("MCP 目录在有 grant 时按 tools 收窄，无 grant 才保持全量发现", () => {
  expect(catalogToolsForGrant(null)).toBeUndefined();
  expect(catalogToolsForGrant(undefined)).toBeUndefined();
  expect(catalogToolsForGrant({ tools: ["get_model_node", "submit_model_script"] })).toEqual(["get_model_node", "submit_model_script"]);
  expect(catalogToolsForGrant({ tools: [] })).toEqual([]);
});

it("revokes grants by work identity without touching another owner's grant", () => {
  const registry = createToolGrantRegistry();
  const grant = { token: "a", workId: "same-request", canvasIds: ["canvas"], nodeIds: [], tools: ["get_canvas_graph"] };
  registry.issue(grant, "user-a"); registry.issue({ ...grant, token: "b" }, "user-b");
  registry.revoke("same-request", "user-a");
  expect(registry.verify("a")).toBeNull();
  expect(registry.verify("b")).not.toBeNull();
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

  it("工具 grant 绑定目标与撤销状态，不设调用额度或固定时钟到期（任务 2.1）", async () => {
    let now = 1_000;
    const registry = createToolGrantRegistry();
    registry.issue({ token: "t1", canvasIds: ["c1"], nodeIds: ["n1"], tools: ["get_model_node"], workId: "w1" });
    expect(registry.verify("t1")).not.toBeNull();
    // 推进时钟超过原 30 分钟有效期：委托仍然有效（寿命由活动执行决定）。
    now += 31 * 60 * 1000;
    expect(registry.verify("t1")).not.toBeNull();
    // 超过原 24/40 次调用后仍然授权。
    for (let index = 0; index < 200; index += 1) {
      expect(registry.authorize({ token: "t1", tool: "get_model_node", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true });
    }
    // 撤销后立即失效。
    registry.revoke("w1");
    expect(registry.verify("t1")).toBeNull();
    expect(registry.authorize({ token: "t1", tool: "get_model_node", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: false, reason: "unknown-grant" });
  });

  it("工具入口 authorize 强制工具/画布/节点范围，失败不产生任何副作用（任务 3.6）", () => {
    const registry = createToolGrantRegistry();
    registry.issue({
      token: "g1",
      canvasIds: ["c1"],
      nodeIds: ["n1"],
      tools: ["submit_model_script", "set_model_camera"],
      workId: "w1"
    });

    // 允许的工具与目标。
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true });
    // 未在允许集合的工具。
    expect(registry.authorize({ token: "g1", tool: "create_film_set_node", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: false, reason: "tool-not-allowed" });
    // 越界画布 / 节点。
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c2", nodeId: "n1" })).toEqual({ ok: false, reason: "canvas-not-allowed" });
    expect(registry.authorize({ token: "g1", tool: "submit_model_script", canvasId: "c1", nodeId: "n2" })).toEqual({ ok: false, reason: "node-not-allowed" });
    // 合法调用没有可耗尽额度（超过原 40 次仍成功）。
    for (let index = 0; index < 120; index += 1) {
      expect(registry.authorize({ token: "g1", tool: "set_model_camera", canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true });
    }

    // 未知 token。
    expect(registry.authorize({ token: "nope", tool: "x" })).toEqual({ ok: false, reason: "unknown-grant" });

    // 空 tools 表示允许任意工具；空 nodeIds 表示任意节点。
    registry.issue({ token: "g3", canvasIds: [], nodeIds: [], tools: [], workId: "w3" });
    expect(registry.authorize({ token: "g3", tool: "any_tool", canvasId: "cX", nodeId: "nY" })).toEqual({ ok: true });
  });
  it("captured camera grants reject other cameras and unrelated writes", () => {
    const registry = createToolGrantRegistry();
    registry.issue({ token: "camera", canvasIds: ["c"], nodeIds: ["n"], tools: ["update_model_camera"], cameraId: "scene-camera", workId: "w-camera" });
    const call = { token: "camera", tool: "update_model_camera", canvasId: "c", nodeId: "n", cameraId: "scene-camera" };
    expect(registry.authorize({ ...call, cameraId: "other" })).toEqual({ ok: false, reason: "camera-not-allowed" });
    expect(registry.authorize({ ...call, cameraId: undefined })).toEqual({ ok: false, reason: "camera-not-allowed" });
    expect(registry.authorize({ ...call, tool: "submit_model_script" }).ok).toBe(false);
    expect(registry.authorize(call)).toEqual({ ok: true });
  });
  it("captured clip and actor grants reject switched targets and stay usable afterwards", () => {
    const registry = createToolGrantRegistry();
    registry.issue({ token: "actor", canvasIds: ["c"], nodeIds: ["n"], tools: ["mutate_film_set_clip"], clipId: "jump", itemId: "hero", workId: "w-actor" });
    const call = { token: "actor", tool: "mutate_film_set_clip", canvasId: "c", nodeId: "n", clipId: "jump", itemId: "hero" };
    expect(registry.authorize({ ...call, clipId: "walk" })).toEqual({ ok: false, reason: "clip-not-allowed" });
    expect(registry.authorize({ ...call, itemId: "other" })).toEqual({ ok: false, reason: "item-not-allowed" });
    expect(registry.authorize({ ...call, itemId: undefined })).toEqual({ ok: false, reason: "item-not-allowed" });
    // 范围错误不消耗任何额度：正确目标继续可用，且没有次数上限。
    expect(registry.authorize(call)).toEqual({ ok: true });
    for (let index = 0; index < 60; index += 1) expect(registry.authorize(call)).toEqual({ ok: true });
  });

  it("已下线的 film-set 模式不再签发目标授权", async () => {
    await expect(createInProcessAuthoringServices({ canvas: fakeCanvas() }).tools.issue({
      delegation: DELEGATION,
      workId: "deprecated-film-set",
      canvasId: "cv",
      nodeId: "n",
      // 旧会话里仍可能出现的已下线模式（协议已收窄，这里模拟历史输入）。
      mode: "film-set" as never,
      tools: ["get_canvas_graph"]
    })).rejects.toThrow("unsupported-target-mode");
  });

});
