/**
 * 提交式协调器与 run/cancel 客户端测试（change: split-web-runtime-services，任务 6.2）。
 *
 * 关键断言：协调器**只提交**，没有等待终态或写结果的能力；结果只能来自服务端 Y.Doc。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSubmitCoordinator, SUBMIT_COORDINATOR_FORBIDDEN_METHODS } from "./submit-coordinator.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasTaskCatalog, WorldCaptureGenerationBinding } from "@woohaa3/contracts";

function catalog(): CanvasTaskCatalog {
  return {
    available: true,
    models: [
      {
        providerId: "litellm",
        modelKey: "gemini-2.5-flash",
        providerModelId: "gemini-2.5-flash",
        modelType: "image",
        title: "Text",
        interaction: { id: "generic-model", version: 1 },
        inputSchema: {},
        defaultInput: {},
        bindings: [],
        taskTimeoutMs: 1000
      }
    ],
    defaultModels: {}
  };
}

function canvasWithNode() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-a");
  canvas.document.nodes.push({ id: "text-1", type: "image", position: { x: 0, y: 0 } });
  return canvas;
}

function canvasWithUnrelatedCameras(cameras: Array<{ nodeId: string; cameraId: string; bound?: string }>) {
  const canvas = canvasWithNode();
  for (const camera of cameras) {
    canvas.document.nodes.push({ id: camera.nodeId, type: "world-camera", position: { x: 0, y: 0 } });
    canvas.nodeData[camera.nodeId] = {
      worldCamera: {
        kind: "world-camera",
        version: "shared-world-v1",
        cameraId: camera.cameraId,
        settingsVersion: `${camera.cameraId}-v1`,
        position: { u: 0, v: 0, h: 1 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        ...(camera.bound ? { boundInstanceId: camera.bound } : {})
      }
    } as never;
  }
  return canvas;
}

describe("前端 Yjs 模式只发 run/cancel（任务 6.2）", () => {
  it("submit-coordinator 源码不含写结果调用（除禁止方法常量外）", () => {
    const source = readFileSync(fileURLToPath(new URL("./submit-coordinator.ts", import.meta.url)), "utf8");
    // 去掉注释，避免文档说明里的"禁止方法"文本误报。
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      // 只保留 SUBMIT_COORDINATOR_FORBIDDEN_METHODS 常量之外的内容。
      .replace(/SUBMIT_COORDINATOR_FORBIDDEN_METHODS[\s\S]*?\] as const;/g, "");
    for (const method of ["completeNodeRun", "failNodeRun", "buildResultAsset", "runToTerminal"]) {
      expect(stripped, method).not.toContain(method);
    }
    expect(stripped).not.toMatch(/\.persist\s*\(/);
  });
});

describe("提交式协调器（任务 6.2；change: formalize-frontend-event-bus，任务 6.1）", () => {
  it("launch intent follows preflight and immediate request acceptance; feedback cannot block submission", async () => {
    const phases: string[] = [];
    let resolve!: (value: { ok: true; runId: string; jobId: string }) => void;
    let requests = 0;
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) }, createRunId: () => "run-origin",
      client: { run: async () => { requests++; return new Promise(done => { resolve = done; }); }, cancel: async () => ({ ok: true }) },
      activity: { started: () => {}, localRejected: () => {}, launch: event => { phases.push(event.phase); if (event.phase === "accepted") throw new Error("overlay released"); } }
    });
    const input = { nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {}, catalog: catalog(), expectedModelType: "image" as const, origin: { x: 10, y: 20, token: "manual" } };
    await coordinator.submit({ ...input, prompt: "" }); expect(phases).toEqual([]);
    const submitting = coordinator.submit(input);
    expect(requests).toBe(1); expect(phases).toEqual(["started"]);
    resolve({ ok: true, runId: "run-origin", jobId: "job" });
    expect((await submitting).ok).toBe(true); expect(phases).toEqual(["started", "accepted"]);
  });

  it("transport exceptions settle the page rejection and stop launch without automatic retry", async () => {
    const phases: string[] = [], rejections: unknown[] = [];
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: { run: async () => { throw new Error("offline"); }, cancel: async () => ({ ok: true }) },
      activity: { started: () => {}, localRejected: event => { rejections.push(event); }, launch: event => { phases.push(event.phase); } }
    });
    const outcome = await coordinator.submit({ nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {}, catalog: catalog(), expectedModelType: "image", origin: { x: 0, y: 0, token: "manual" } });
    expect(outcome.ok).toBe(false); expect(rejections).toHaveLength(1); expect(phases).toEqual(["started", "rejected"]);
  });
  it("提交时抛 started 事件，网关拒绝时抛 local-rejection finished", async () => {
    const started: Array<{ runId: string; nodeId: string; modelKey?: string }> = [];
    const rejections: Array<{ runId: string; nodeId: string; message: string }> = [];
    const activity = {
      started: (payload: { runId: string; nodeId: string; modelKey?: string }) => {
        started.push(payload);
      },
      localRejected: (payload: { activity: { runId: string; nodeId: string; error: { message: string } } }) => {
        rejections.push({
          runId: payload.activity.runId,
          nodeId: payload.activity.nodeId,
          message: payload.activity.error.message
        });
      }
    };
    const accepted = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: { run: async (request) => ({ ok: true, runId: request.runId, jobId: request.jobId }), cancel: async () => ({ ok: true }) },
      activity: activity as never,
      createRunId: () => "run-fixed"
    });
    await accepted.submit({ nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {}, catalog: catalog(), expectedModelType: "image" });
    expect(started).toEqual([
      { runId: "run-fixed", jobId: "job-run-fixed", nodeId: "text-1", state: "queued", modelType: "image", modelKey: "gemini-2.5-flash", createdAt: expect.any(String) }
    ] as never);
    expect(rejections).toEqual([]);

    const rejected = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: { run: async () => ({ ok: false, error: "网关拒绝" }), cancel: async () => ({ ok: true }) },
      activity: activity as never,
      createRunId: () => "run-denied"
    });
    await rejected.submit({ nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {}, catalog: catalog(), expectedModelType: "image" });
    expect(rejections).toEqual([{ runId: "run-denied", nodeId: "text-1", message: "网关拒绝" }]);
  });

  it("结构化地没有等待终态或写结果的入口", () => {
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: { run: async () => ({ ok: true, runId: "r", jobId: "j" }), cancel: async () => ({ ok: true }) }
    });
    for (const method of SUBMIT_COORDINATOR_FORBIDDEN_METHODS) {
      expect((coordinator as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it("只提交一次且不写画布", async () => {
    const canvas = canvasWithNode();
    const revisionBefore = canvas.revision;
    const calls: unknown[] = [];
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas }) },
      client: {
        run: async (request) => {
          calls.push(request);
          return { ok: true, runId: request.runId, jobId: request.jobId };
        },
        cancel: async () => ({ ok: true })
      },
      createRunId: () => "run-fixed"
    });
    const outcome = await coordinator.submit({
      nodeId: "text-1",
      modelKey: "gemini-2.5-flash",
      prompt: "你好",
      parameters: {},
      catalog: catalog(),
      expectedModelType: "image"
    });
    expect(outcome).toEqual({ ok: true, runId: "run-fixed", jobId: "job-run-fixed" });
    expect(calls).toHaveLength(1);
    // 只提交：画布 revision 未变（begin 由服务端做）。
    expect(canvas.revision).toBe(revisionBefore);
    expect(canvas.nodeData["text-1"]).toBeUndefined();
  });

  it("预检拒绝时不调用服务端", async () => {
    let called = false;
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: {
        run: async () => {
          called = true;
          return { ok: true, runId: "r", jobId: "j" };
        },
        cancel: async () => ({ ok: true })
      }
    });
    const missing = await coordinator.submit({
      nodeId: "ghost",
      modelKey: "gemini-2.5-flash",
      prompt: "p",
      parameters: {},
      catalog: catalog(),
      expectedModelType: "image"
    });
    expect(missing.ok).toBe(false);
    expect(called).toBe(false);

    const emptyPrompt = await coordinator.submit({
      nodeId: "text-1",
      modelKey: "gemini-2.5-flash",
      prompt: "   ",
      parameters: {},
      catalog: catalog(),
      expectedModelType: "image"
    });
    expect(emptyPrompt.ok).toBe(false);
    expect(called).toBe(false);

    const wrongType = await coordinator.submit({
      nodeId: "text-1",
      modelKey: "gemini-2.5-flash",
      prompt: "p",
      parameters: {},
      catalog: catalog(),
      expectedModelType: "language"
    });
    expect(wrongType.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("run/cancel 客户端（任务 6.2）", () => {
  it("run/cancel 协议已迁入 canvasRemote（见 runtime/remote/remote.test.ts）", () => {
    // 该 client 的直接协议测试随 change: adopt-frontend-cordis-plugin-runtime 迁移。
    expect(true).toBe(true);
  });
});

it("rejects new text Provider submissions before calling the Task run client", async () => {
  const canvas = canvasWithNode(); canvas.document.nodes[0]!.type = "text";
  let calls = 0;
  const coordinator = createSubmitCoordinator({ store: { getState: () => ({ canvas }) }, client: { run: async () => { calls++; return { ok: true, runId: "run", jobId: "job" }; }, cancel: async () => ({ ok: true }) } });
  expect(await coordinator.submit({ nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "generate", parameters: {}, catalog: catalog(), expectedModelType: "language" })).toMatchObject({ ok: false, error: expect.stringContaining("助手") });
  expect(calls).toBe(0);
});


function captureBinding(): WorldCaptureGenerationBinding {
  const key = {
    canvasId: "canvas-a",
    cameraId: "camera-1",
    worldContentVersion: "world-1",
    cameraSettingsVersion: "camera-v1",
    bindingVersion: "binding-1",
    outputVersion: "output-1"
  };
  return {
    version: "world-capture-generation-binding-v1",
    requestId: "capture-request-1",
    key,
    contentFingerprint: "0123456789abcdef",
    input: { key, mediaId: "sha256-capture", checksum: "a".repeat(64) }
  };
}

describe("T10 generation input freeze at click time", () => {
  it("freezes before acceptance and forwards the exact binding to run", async () => {
    const phases: string[] = [];
    const requests: Array<{ worldCapture?: WorldCaptureGenerationBinding }> = [];
    const freezeCalls: string[] = [];
    const binding = captureBinding();
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithUnrelatedCameras([
        { nodeId: "camera-a", cameraId: "camera-1" },
        { nodeId: "camera-b", cameraId: "camera-2", bound: "instance-2" }
      ]) }) },
      client: {
        freezeWorldCapture: async (input) => {
          freezeCalls.push(input.cameraId);
          return { ok: true, binding };
        },
        run: async (request) => { requests.push(request); return { ok: true, runId: request.runId, jobId: request.jobId }; },
        cancel: async () => ({ ok: true })
      },
      activity: { started: () => {}, localRejected: () => {}, launch: event => { phases.push(event.phase); } }
    });
    const outcome = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {},
      catalog: catalog(), expectedModelType: "image", worldCapture: { cameraId: "camera-1" },
      origin: { x: 0, y: 0, token: "manual" }
    });
    expect(outcome.ok).toBe(true);
    expect(freezeCalls).toEqual(["camera-1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.worldCapture).toEqual(binding);
    expect(phases).toEqual(["started", "accepted"]);
  });

  it("does not create or announce a run when freezing fails or is stale", async () => {
    const phases: string[] = [];
    let runs = 0;
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      client: {
        freezeWorldCapture: async () => ({ ok: false, code: "superseded", error: "该版本取景已被新版本替换" }),
        run: async () => { runs += 1; return { ok: true as const, runId: "r", jobId: "j" }; },
        cancel: async () => ({ ok: true })
      },
      activity: { started: () => {}, localRejected: () => {}, launch: event => { phases.push(event.phase); } }
    });
    const outcome = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {},
      catalog: catalog(), expectedModelType: "image", worldCapture: { cameraId: "camera-1" }
    });
    expect(outcome).toEqual({ ok: false, code: "superseded", error: "该版本取景已被新版本替换" });
    expect(runs).toBe(0);
    expect(phases).toEqual([]);
  });

  it("suppresses stale page feedback after freeze/run settles", async () => {
    let live = true;
    const phases: string[] = [];
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas: canvasWithNode() }) },
      isCurrent: () => live,
      client: {
        freezeWorldCapture: async () => { live = false; return { ok: true, binding: captureBinding() }; },
        run: async () => ({ ok: true as const, runId: "r", jobId: "j" }),
        cancel: async () => ({ ok: true })
      },
      activity: { started: () => {}, localRejected: () => {}, launch: event => { phases.push(event.phase); } }
    });
    const outcome = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "hi", parameters: {},
      catalog: catalog(), expectedModelType: "image", worldCapture: { cameraId: "camera-1" }
    });
    expect(outcome).toMatchObject({ ok: false, code: "stale-scope" });
    expect(phases).toEqual([]);
  });

  it("submits ordinary media unchanged and never freezes an unrelated canvas camera", async () => {
    const canvas = canvasWithUnrelatedCameras([
      { nodeId: "camera-bound", cameraId: "camera-bound", bound: "instance-1" },
      { nodeId: "camera-world", cameraId: "camera-world" }
    ]);
    const parameters = { seed: 11, referenceImages: ["existing-reference"] };
    const requests: Array<{ parameters: Record<string, unknown>; worldCapture?: WorldCaptureGenerationBinding }> = [];
    const freeze = vi.fn(async () => ({ ok: true as const, binding: captureBinding() }));
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas }) },
      client: {
        freezeWorldCapture: freeze,
        run: async (request) => { requests.push(request); return { ok: true as const, runId: request.runId, jobId: request.jobId }; },
        cancel: async () => ({ ok: true })
      }
    });
    const outcome = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "draw", parameters,
      catalog: catalog(), expectedModelType: "image"
    });
    expect(outcome.ok).toBe(true);
    expect(freeze).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.parameters).toBe(parameters);
    expect(requests[0]!.worldCapture).toBeUndefined();

    // Missing freeze service / producer is equally irrelevant when nothing was selected.
    const withoutProducer = createSubmitCoordinator({
      store: { getState: () => ({ canvas }) },
      client: {
        run: async (request) => ({ ok: true as const, runId: request.runId, jobId: request.jobId }),
        cancel: async () => ({ ok: true })
      }
    });
    expect(await withoutProducer.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "draw", parameters,
      catalog: catalog(), expectedModelType: "image"
    })).toMatchObject({ ok: true });
  });

  it("does not fall back to another camera or a previous binding when explicit freeze fails", async () => {
    const canvas = canvasWithUnrelatedCameras([
      { nodeId: "camera-a", cameraId: "camera-A" },
      { nodeId: "camera-b", cameraId: "camera-B" }
    ]);
    const freezeCalls: string[] = [];
    const requests: Array<{ worldCapture?: WorldCaptureGenerationBinding }> = [];
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas }) },
      client: {
        freezeWorldCapture: async (input) => {
          freezeCalls.push(input.cameraId);
          return { ok: false, code: "producer-missing", error: "取景 producer 不可用" };
        },
        run: async (request) => { requests.push(request); return { ok: true as const, runId: request.runId, jobId: request.jobId }; },
        cancel: async () => ({ ok: true })
      }
    });
    const failed = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "draw", parameters: {},
      catalog: catalog(), expectedModelType: "image", worldCapture: { cameraId: "camera-A" }
    });
    expect(failed).toEqual({ ok: false, code: "producer-missing", error: "取景 producer 不可用" });
    expect(freezeCalls).toEqual(["camera-A"]);
    expect(requests).toHaveLength(0);

    // A later ordinary submission must not reuse camera-B, camera-A or a cached image.
    const plain = await coordinator.submit({
      nodeId: "text-1", modelKey: "gemini-2.5-flash", prompt: "draw again", parameters: { seed: 2 },
      catalog: catalog(), expectedModelType: "image"
    });
    expect(plain.ok).toBe(true);
    expect(freezeCalls).toEqual(["camera-A"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.worldCapture).toBeUndefined();
  });
});
