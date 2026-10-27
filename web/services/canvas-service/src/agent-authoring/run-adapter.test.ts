/**
 * Canvas Agent run adapter 测试
 * （change: add-agent-canvas-authoring-mcp，任务 6.2–6.5）。
 *
 * 覆盖：确定性 run 身份、状态 active/stale/terminal、取消语义、文本/媒体输出边界与安全。
 */
import { describe, expect, it } from "vitest";
import { AgentRunAdapter, deriveRunIdentity, projectOutputView, projectRunView } from "./run-adapter.js";
import type { CanvasRoom } from "../sync/index.js";
import type { ServerCanvas } from "@woohaa3/contracts";

function canvas(overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  const base: ServerCanvas = {
    id: "c1",
    title: "画布",
    revision: 5,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-09-28T00:00:00.000Z",
      nodes: [{ id: "img-1", type: "image", position: { x: 0, y: 0 } }],
      edges: []
    },
    nodeData: { "img-1": {} },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
  return { ...base, ...overrides };
}

function roomFor(c: ServerCanvas): CanvasRoom {
  return { canvasId: c.id, exportCanvas: () => ({ ok: true as const, canvas: c }), submit: async () => ({ ok: true, status: "accepted", revision: c.revision, noop: false, update: null }) } as unknown as CanvasRoom;
}

describe("run 身份（任务 6.2）", () => {
  it("同 canvas/requestId 派生同一 runId/jobId", () => {
    const a = deriveRunIdentity("c1", "img-1", "req-1");
    const b = deriveRunIdentity("c1", "img-1", "req-1");
    expect(a).toEqual(b);
    expect(deriveRunIdentity("c1", "img-1", "req-2").runId).not.toBe(a.runId);
  });
});

describe("run 视图（任务 6.3）", () => {
  it("active processing → running（非伪终态）", () => {
    const view = projectRunView("c1", "img-1", "r1", canvas({
      revision: 6,
      nodeData: { "img-1": { activeRunId: "r1", taskStatus: "processing", progress: 40 } }
    }));
    expect(view).toMatchObject({ phase: "running", stale: false, progress: 40 });
    expect(view.state).toBeUndefined();
  });

  it("active successed → terminal succeeded", () => {
    const view = projectRunView("c1", "img-1", "r1", canvas({
      revision: 7,
      nodeData: { "img-1": { activeRunId: "r1", taskStatus: "successed" } }
    }));
    expect(view).toMatchObject({ phase: "terminal", state: "succeeded", stale: false });
  });

  it("被较新 run 取代但有历史终态 → terminal stale", () => {
    const view = projectRunView("c1", "img-1", "r1", canvas({
      revision: 8,
      nodeData: { "img-1": { activeRunId: "r2", taskStatus: "processing" } },
      jobs: [{ id: "j1", nodeId: "img-1", taskId: "t", runId: "r1", status: "success", updatedAt: "x" }]
    }));
    expect(view).toMatchObject({ phase: "terminal", state: "succeeded", stale: true });
  });
});

describe("run 执行与取消（任务 6.2 / 6.4）", () => {
  it("run 在 Task 不可用时返回可重试错误", async () => {
    const adapter = new AgentRunAdapter({
      resolveRoom: async () => roomFor(canvas({ nodeData: { "img-1": { modelKey: "litellm:m1" } } })),
      runService: {
        run: async () => ({ ok: false, code: "catalog-unavailable", message: "目录不可用" }),
        cancel: async () => ({ ok: false, code: "x", message: "x" })
      }
    });
    const outcome = await adapter.run({ canvasId: "c1", requestId: "req-1", nodeId: "img-1", modelKey: "m1" });
    expect(outcome).toMatchObject({ ok: false, code: "catalog-unavailable", retryable: true });
  });

  it("run 省略 modelKey 时回退节点默认模型；都没有时稳定失败", async () => {
    const calls: unknown[] = [];
    const adapter = new AgentRunAdapter({
      resolveRoom: async () => roomFor(canvas({ nodeData: { "img-1": { modelKey: "litellm:m-default" } } })),
      runService: {
        run: async (request) => { calls.push(request); return { ok: true, runId: request.runId, jobId: request.jobId, workerTaskKey: "k", state: "accepted" }; },
        cancel: async () => ({ ok: false, code: "x", message: "x" })
      }
    });
    const outcome = await adapter.run({ canvasId: "c1", requestId: "req-1", nodeId: "img-1" });
    expect(outcome.ok).toBe(true);
    expect((calls[0] as { modelKey: string }).modelKey).toBe("litellm:m-default");

    const noModel = new AgentRunAdapter({
      resolveRoom: async () => roomFor(canvas()),
      runService: { run: async () => ({ ok: true, runId: "r", jobId: "j", workerTaskKey: "k", state: "accepted" }), cancel: async () => ({ ok: false, code: "x", message: "x" }) }
    });
    expect(await noModel.run({ canvasId: "c1", requestId: "req-1", nodeId: "img-1" })).toMatchObject({ ok: false, code: "model-required" });
  });

  it("cancel 对已终态 run 返回 already-terminal 且不调用 cancel", async () => {
    let cancelCalled = false;
    const adapter = new AgentRunAdapter({
      resolveRoom: async () => roomFor(canvas({ revision: 7, nodeData: { "img-1": { activeRunId: "r1", taskStatus: "successed" } } })),
      runService: { run: async () => ({ ok: false, code: "x", message: "x" }), cancel: async () => { cancelCalled = true; return { ok: false, code: "x", message: "x" }; } }
    });
    const outcome = await adapter.cancel({ canvasId: "c1", nodeId: "img-1", runId: "r1" });
    expect(outcome).toMatchObject({ ok: true, state: "already-terminal" });
    expect(cancelCalled).toBe(false);
  });

  it("cancel 只取消匹配的 active run", async () => {
    const adapter = new AgentRunAdapter({
      resolveRoom: async () => roomFor(canvas({ revision: 6, nodeData: { "img-1": { activeRunId: "r1", taskStatus: "processing" } } })),
      runService: {
        run: async () => ({ ok: false, code: "x", message: "x" }),
        cancel: async ({ runId }) => runId === "r1" ? { ok: true, state: "cancel-requested" } : { ok: false, code: "stale-run", message: "stale" }
      }
    });
    expect(await adapter.cancel({ canvasId: "c1", nodeId: "img-1", runId: "r1" })).toMatchObject({ ok: true, state: "cancel-requested" });
    // 非 active run（r2）在投影层即判定 stale，不会误取消当前 run。
    expect(await adapter.cancel({ canvasId: "c1", nodeId: "img-1", runId: "r2" })).toMatchObject({ ok: true, state: "stale-run" });
  });
});

describe("输出投影（任务 6.5）", () => {
  it("文本输出有界返回并带 provenance", () => {
    const view = projectOutputView(canvas({
      revision: 7,
      nodeData: { "img-1": { activeRunId: "r1", taskStatus: "successed", result: { kind: "text", text: "hello" } } }
    }), "c1", "img-1", "r1");
    expect(view.available).toBe(true);
    if (!view.available) return;
    expect(view.output).toMatchObject({ kind: "text", text: "hello", truncated: false });
    expect(view.output.provenance).toMatchObject({ canvasId: "c1", nodeId: "img-1", runId: "r1" });
  });

  it("超长文本被截断", () => {
    const view = projectOutputView(canvas({
      revision: 7,
      nodeData: { "img-1": { activeRunId: "r1", taskStatus: "successed", result: { kind: "text", text: "x".repeat(200_001) } } }
    }), "c1", "img-1", "r1");
    if (!view.available || view.output.kind !== "text") throw new Error("expected text");
    expect(view.output.truncated).toBe(true);
    expect(view.output.text.length).toBe(200_000);
  });

  it("媒体输出只返回同源引用与安全 metadata（无 storageKey/凭据）", () => {
    const view = projectOutputView(canvas({
      revision: 8,
      nodeData: { "img-1": { activeRunId: "r1", taskStatus: "successed", outputAssetId: "a1" } },
      assets: [{
        id: "a1", title: "结果", mediaKind: "image", source: "generated", status: "ready", createdAt: "x",
        metadata: { storageKey: "sha256-" + "a".repeat(64), contentType: "image/png", size: 123, checksum: "c" }
      }]
    }), "c1", "img-1", "r1");
    expect(view.available).toBe(true);
    if (!view.available || view.output.kind !== "image") throw new Error("expected image");
    expect(view.output.url).toContain("/api/media/");
    expect(view.output.contentType).toBe("image/png");
    expect(view.output.size).toBe(123);
    // 只返回同源相对引用；不含独立 storageKey 字段、COS 凭据或临时/data/blob URL。
    const serialized = view.output as Record<string, unknown>;
    expect(serialized.storageKey).toBeUndefined();
    expect(serialized.checksum).toBeUndefined();
    expect(JSON.stringify(view.output)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(view.output)).not.toMatch(/data:|blob:/);
  });

  it("运行中/失败时返回稳定原因", () => {
    const running = projectOutputView(canvas({ revision: 6, nodeData: { "img-1": { activeRunId: "r1", taskStatus: "processing" } } }), "c1", "img-1", "r1");
    expect(running).toMatchObject({ available: false, reason: "running" });
    const failed = projectOutputView(canvas({ revision: 7, nodeData: { "img-1": { activeRunId: "r1", taskStatus: "failed", error: "生成失败" } } }), "c1", "img-1", "r1");
    expect(failed).toMatchObject({ available: false, reason: "failed" });
  });
});

it("dispatches text through the injected assistant gateway with a real execution ref and exact stop identity", async () => {
  const c = canvas(); c.document.nodes[0]!.type = "text";
  let providerCalls = 0; const calls: unknown[] = [];
  const execution = { canvasId: "c1", targetNodeId: "img-1", conversationId: "conversation", turnRequestId: "request", runId: "text-run:actual", jobId: "text-job:actual" };
  const assistant = { connection: { connectionId: "connection", adapterId: "adapter", configRevision: 1, credentialEpoch: 1 }, model: "model" };
  const adapter = new AgentRunAdapter({ resolveRoom: async () => roomFor(c), runService: { run: async () => { providerCalls++; return { ok: false, code: "unused", message: "unused" }; }, cancel: async () => { providerCalls++; return { ok: true, state: "cancel-requested" }; } }, assistantText: {
    run: async input => { calls.push(input); return { ok: true, ...execution, nodeId: "img-1", state: "accepted", execution }; },
    status: async input => { calls.push(input); return { ok: true, view: { protocolVersion: 1, canvasId: "c1", nodeId: "img-1", runId: input.runId, jobId: execution.jobId, execution, phase: "running", stale: false } }; },
    cancel: async input => { calls.push(input); return { ok: true, ...input, state: "cancel-requested" }; },
  } });
  expect(await adapter.run({ owner: "owner", canvasId: "c1", nodeId: "img-1", requestId: "request", modelKey: "old-provider" })).toMatchObject({ ok: false, code: "assistant-required" });
  expect(await adapter.run({ owner: "owner", canvasId: "c1", nodeId: "img-1", requestId: "request", assistant, prompt: "write" })).toMatchObject({ ok: true, execution });
  await adapter.status({ owner: "owner", canvasId: "c1", nodeId: "img-1", runId: execution.runId });
  await adapter.cancel({ owner: "owner", canvasId: "c1", nodeId: "img-1", runId: execution.runId });
  expect(calls).toMatchObject([{ owner: "owner", assistant }, { runId: execution.runId }, { runId: execution.runId }]);
  expect(providerCalls).toBe(0);
});

it("returns an archived text run's own output and never substitutes canonical text for an unsaved run", () => {
  const c = canvas(); c.document.nodes[0]!.type = "text";
  c.nodeData["img-1"] = { activeRunId: "text-run:new", taskStatus: "successed", result: { kind: "text", text: "new" } };
  c.assets.push({ id: "old", nodeId: "img-1", mediaKind: "text", source: "generated", status: "ready", text: "old", title: "old", createdAt: "2026-10-27", provenance: { runId: "text-run:old" } });
  expect(projectOutputView(c, "c1", "img-1", "text-run:old")).toMatchObject({ available: true, output: { text: "old", runId: "text-run:old" } });
  expect(projectOutputView(c, "c1", "img-1", "text-run:missing")).toMatchObject({ available: false });
});
