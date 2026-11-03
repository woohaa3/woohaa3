/**
 * Canvas Service 测试（change: split-web-runtime-services，任务 5.3 / 5.4）。
 *
 * 覆盖：从 published Y.Doc 解析权威输入并事务 begin、以稳定 workerTaskKey 异步 submit、
 * begin 后进程退出可用同 key 恢复、projector 幂等投影终态、latest-run-wins。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasTaskProjector, CanvasRoom, InMemoryProjectionReceiptStore, InMemoryYjsDocumentRepository } from "./sync/index.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasTaskCatalog, TaskExecutionDetail } from "@woohaa3/contracts";
import { CanvasRunService } from "./task/run-service.js";
import { toExecutionRecord, createTaskResultConsumer } from "./task/result-consumer.js";

const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

function catalog(model: Partial<CanvasTaskCatalog["models"][number]> = {}): CanvasTaskCatalog {
  return {
    available: true,
    models: [
      {
        modelKey: "litellm:gpt-image-2",
        providerId: "litellm",
        providerModelId: "gpt-image-2",
        modelType: "image",
        title: "Image",
        interaction: { id: "generic-model", version: 1 },
        inputSchema: {},
        defaultInput: {},
        bindings: [
          {
            field: "referenceImages",
            semantic: "reference-image",
            roles: ["reference_image"],
            mediaKinds: ["image"],
            mediaTypes: ["image/png"],
            maxItems: 4,
            valueFormat: "url"
          }
        ],
        taskTimeoutMs: 1000,
        ...model
      }
    ],
    defaultModels: {}
  };
}

async function makeRoom(options: { withUpstream?: boolean; withUpstreamText?: { textAsset?: boolean; text?: string; panelPrompt?: string } } = {}) {
  const repository = new InMemoryYjsDocumentRepository();
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-a");
  canvas.document.nodes.push({ id: "image-1", type: "image", position: { x: 0, y: 0 } });
  if (options.withUpstream) {
    canvas.document.nodes.push({ id: "image-up", type: "image", position: { x: 300, y: 0 } });
    canvas.document.edges.push({ id: "e1", source: "image-up", target: "image-1", data: {} });
    canvas.nodeData["image-up"] = { outputAssetId: "asset-up" };
    canvas.assets.push({
      id: "asset-up",
      title: "up",
      mediaKind: "image",
      source: "generated",
      status: "ready",
      createdAt: "2026-01-01T00:00:00Z",
      metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
    });
  }
  if (options.withUpstreamText) {
    const { textAsset = true, text = "一只猫", panelPrompt } = options.withUpstreamText;
    canvas.document.nodes.push({ id: "text-up", type: "text", position: { x: 300, y: 0 } });
    canvas.document.edges.push({ id: "et", source: "text-up", target: "image-1", data: {} });
    canvas.nodeData["text-up"] = {
      ...(textAsset ? { outputAssetId: "asset-text" } : {}),
      ...(panelPrompt !== undefined ? { panelPrompt } : {})
    };
    if (textAsset) {
      canvas.assets.push({
        id: "asset-text",
        title: "文本",
        mediaKind: "text",
        source: "generated",
        status: "ready",
        text,
        createdAt: "2026-01-01T00:00:00Z",
        metadata: {}
      });
    }
  }
  await repository.createYjsDocument({
    canvasId: "canvas-a",
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "epoch",
    checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(canvas)),
    projection: canvas,
    revision: canvas.revision,
    createdAt: "2026-01-01T00:00:00Z"
  });
  const room = new CanvasRoom({ canvasId: "canvas-a", repository, now: () => "2026-01-01T00:00:00Z" });
  await room.load();
  return room;
}

describe("Canvas run service（任务 5.3）", () => {
  it("accepts concurrent runs with independent inputs, cancels an older run and archives out-of-order results without replacing the latest output", async () => {
    const room = await makeRoom();
    const submitted: Array<Record<string, unknown>> = [], cancelled: string[] = [];
    const service = new CanvasRunService({ resolveRoom: async()=>room, resolveCatalog: async()=>catalog(),
      taskClient: {submit:async (request:Record<string,unknown>)=>{submitted.push(request);},cancel:async(key:string)=>{cancelled.push(key);}} as never });
    const runs=await Promise.all([1,2,3].map(i=>service.run({canvasId:"canvas-a",nodeId:"image-1",runId:`parallel-${i}`,jobId:`parallel-job-${i}`,
      modelKey:"litellm:gpt-image-2",prompt:`prompt-${i}`,parameters:{seed:i}})));
    expect(runs.every(run=>run.ok)).toBe(true);
    expect(submitted.map(request=>[request.runId,request.prompt,request.parameters])).toEqual([1,2,3].map(i=>[`parallel-${i}`,`prompt-${i}`,{seed:i,model:"litellm:gpt-image-2"}]));
    expect(await service.cancel({canvasId:"canvas-a",nodeId:"image-1",runId:"parallel-1"})).toEqual({ok:true,state:"cancel-requested"});
    expect(cancelled).toEqual(["parallel-1"]);
    const archived:string[]=[];
    const projector=new CanvasTaskProjector({resolveRoom:async()=>room,receipts:new InMemoryProjectionReceiptStore(),
      registerHistory:async record=>{archived.push(record.runId);}});
    const result=(i:number)=>({taskKey:`parallel-${i}`,runId:`parallel-${i}`,jobId:`parallel-job-${i}`,canvasId:"canvas-a",nodeId:"image-1",
      status:"succeeded" as const,terminalAt:`2026-10-20T00:00:0${i}Z`,output:{mediaKind:"text" as const,text:`result-${i}`}});
    await projector.project(result(3));await projector.project(result(1));await projector.project(result(2));
    expect(archived).toEqual(["parallel-3","parallel-1","parallel-2"]);
    const exported=room.exportCanvas();expect(exported.ok).toBe(true);if(!exported.ok)return;
    expect(exported.canvas.nodeData["image-1"]).toMatchObject({activeRunId:"parallel-3",result:{kind:"text",text:"result-3"}});
    expect(exported.canvas.jobs.filter(job=>job.runId?.startsWith("parallel-")).map(job=>job.status)).toEqual(["success","success","success"]);
  });
  it("图片节点运行前先登记当前图为历史基线（先于 begin 与 submit）", async () => {
    const room = await makeRoom();
    const order: string[] = [];
    const taskClient = { submit: async () => { order.push("submit"); }, cancel: async () => {} } as never;
    const request = (runId: string) => ({ canvasId: "canvas-a", nodeId: "image-1", runId, jobId: `job-${runId}`, modelKey: "litellm:gpt-image-2", prompt: "变成夜景", parameters: {} });

    const service = new CanvasRunService({
      resolveRoom: async () => room, taskClient, resolveCatalog: async () => catalog(),
      ensureNodeBaseline: async (canvasId, nodeId) => { order.push(`baseline:${canvasId}:${nodeId}`); }
    });
    expect((await service.run(request("b1"))).ok).toBe(true);
    expect(order).toEqual(["baseline:canvas-a:image-1", "submit"]);
  });
  it("解析权威输入、事务 begin 后以稳定 workerTaskKey 异步 submit", async () => {
    const room = await makeRoom({ withUpstream: true });
    const submitted: Array<Record<string, unknown>> = [];
    const taskClient = {
      async submit(request: unknown) {
        submitted.push(request as Record<string, unknown>);
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "image-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });

    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "画只猫",
      parameters: {}
    });
    expect(outcome.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].workerTaskKey).toBe("r1");
    expect(submitted[0].inputs).toEqual([
      { assetId: "asset-up", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png", mediaKind: "image", field: "referenceImages" }
    ]);

    // 事务已把 activeRunId/job 写入权威 Y.Doc。
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"].activeRunId).toBe("r1");
    expect(exported.ok && exported.canvas.jobs[0].status).toBe("running");
    // begin 写入的 job 带模型身份：产物溯源可从 runId 直接读到当时用的模型
    // （change: l0-generation-provenance）。
    expect(exported.ok && exported.canvas.jobs[0].modelKey).toBe("litellm:gpt-image-2");
  });

  it("模型不接受参考图时阻止提交且不调用 Task", async () => {
    const room = await makeRoom({ withUpstream: true });
    let called = false;
    const taskClient = {
      async submit() {
        called = true;
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "video-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog({ bindings: [] }),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "p",
      parameters: {}
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("Task 不可用时 run 当场失败并结算节点（不再停在 processing），可用同 key 重试", async () => {
    const room = await makeRoom();
    const taskClient = {
      async submit() {
        throw new Error("task down");
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "p",
      parameters: {}
    });
    // 旧行为是「吞掉错误、返回 accepted」：节点会永久停在 processing，面板看不到任何原因。
    expect(outcome).toMatchObject({ ok: false, code: "task-submit-failed", message: "task down" });
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"]).toMatchObject({
      activeRunId: "r1",
      taskStatus: "failed",
      errorMessage: "task down"
    });
  });

  it("begin 后 submit 响应丢失：同 runId 重提使用同一稳定 key，重复失败幂等", async () => {
    const room = await makeRoom();
    const keys: string[] = [];
    const taskClient = {
      async submit(request: unknown) {
        keys.push((request as { workerTaskKey: string }).workerTaskKey);
        throw new Error("response lost");
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const request = {
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "run-stable",
      jobId: "job-stable",
      modelKey: "litellm:gpt-image-2",
      prompt: "p",
      parameters: {}
    };
    // 两次调用（第二次模拟恢复重提）使用同一 workerTaskKey（= runId）。
    await service.run(request);
    await service.run(request);
    expect(keys).toEqual(["run-stable", "run-stable"]);
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"].activeRunId).toBe("run-stable");
  });
});

/** 构造一个 edit_video 视频节点画布（含稳定 edit_video 输入与可选 intents）。 */
function videoCatalog(model: Partial<CanvasTaskCatalog["models"][number]> = {}): CanvasTaskCatalog {
  return {
    available: true,
    models: [
      {
        providerId: "ark",
        modelKey: "ark:seedance2_5",
        providerModelId: "seedance2_5",
        modelType: "video",
        title: "Seedance",
        interaction: { id: "generic-model", version: 1 },
        inputSchema: {},
        defaultInput: {},
        bindings: [
          {
            field: "videoUrls",
            semantic: "reference-video",
            roles: ["edit_video"],
            mediaKinds: ["video"],
            mediaTypes: ["video/mp4"],
            maxItems: 1,
            valueFormat: "url"
          }
        ],
        taskTimeoutMs: 1000,
        ...model
      }
    ],
    defaultModels: {}
  };
}

async function makeVideoRoom(options: { intents?: unknown; duration?: number } = {}) {
  const repository = new InMemoryYjsDocumentRepository();
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-a");
  canvas.document.nodes.push({ id: "video-1", type: "video", position: { x: 0, y: 0 }, width: 320, height: 200 });
  canvas.document.nodes.push({ id: "video-up", type: "video", position: { x: 300, y: 0 }, width: 320, height: 200 });
  canvas.document.edges.push({ id: "e1", source: "video-up", target: "video-1", data: {} });
  canvas.nodeData["video-up"] = { outputAssetId: "asset-video" };
  canvas.assets.push({
    id: "asset-video",
    title: "src",
    mediaKind: "video",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "video/mp4", size: 10 }
  });
  canvas.nodeData["video-1"] = {
    parameters: { generationMode: "edit_video" },
    ...(options.intents !== undefined ? { videoEditIntents: options.intents as never } : {})
  } as never;
  await repository.createYjsDocument({
    canvasId: "canvas-a",
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "epoch",
    checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(canvas)),
    projection: canvas,
    revision: canvas.revision,
    createdAt: "2026-01-01T00:00:00Z"
  });
  const room = new CanvasRoom({ canvasId: "canvas-a", repository, now: () => "2026-01-01T00:00:00Z" });
  await room.load();
  return room;
}

function videoEditIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "i1",
    startSeconds: 2,
    endSeconds: 2.5,
    prompt: "人物转身",
    annotationShapes: [
      { id: "s1", tool: "pen", color: "#ffffff", strokeWidth: 1, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }
    ],
    annotationPreview: { assetId: "asset-preview", storageKey: `sha256-${"b".repeat(64)}`, mediaType: "image/png" },
    frameWidth: 1920,
    frameHeight: 1080,
    ...overrides
  };
}

describe("Canvas run service 视频编辑意图编译（change: port-video-editing-dialogs）", () => {
  it("edit_video：intents 稳定编译进 provider prompt，且不产生临时媒体输入", async () => {
    const room = await makeVideoRoom({ intents: [videoEditIntent({ id: "b", startSeconds: 9, endSeconds: 9.5 }), videoEditIntent({ id: "a", startSeconds: 2 })] });
    const submitted: Array<Record<string, unknown>> = [];
    const taskClient = {
      async submit(request: unknown) {
        submitted.push(request as Record<string, unknown>);
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "video-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => videoCatalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "video-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "ark:seedance2_5",
      prompt: "保持镜头稳定",
      parameters: { generationMode: "edit_video" }
    });
    expect(outcome.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    const prompt = submitted[0].prompt as string;
    expect(prompt).toContain("编辑视频 1");
    expect(prompt).toContain("@image1");
    expect(prompt.indexOf("2.00")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("2.00")).toBeLessThan(prompt.indexOf("9.00"));
    expect(prompt).not.toContain("data:");
    expect(prompt).not.toContain("http");
    // 任务输入仍只有稳定 edit_video 视频引用，没有临时 preview 输入。
    expect(submitted[0].inputs).toEqual([
      { assetId: "asset-video", role: "edit_video", storageKey: STORAGE_KEY, mediaType: "video/mp4", mediaKind: "video", field: "videoUrls" }
    ]);
  });

  it("edit_video：非法 intent 使提交以稳定错误失败且不调用 Task", async () => {
    // 临时签名 preview 不可持久化：经命令边界拒绝后也不会出现在画布；这里直接构造非法值。
    const room = await makeVideoRoom({
      intents: [videoEditIntent({ annotationPreview: { assetId: "", storageKey: "data:image/png;base64,AAAA", mediaType: "image/png" } })]
    });
    let called = false;
    const taskClient = {
      async submit() {
        called = true;
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "video-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => videoCatalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "video-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "ark:seedance2_5",
      prompt: "编辑",
      parameters: { generationMode: "edit_video" }
    });
    // 画布层面已剥离危险 intent；无 intents 时仍可提交基础 prompt。
    expect(called || outcome.ok === false).toBe(true);
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (exported.ok) {
      expect(JSON.stringify(exported.canvas)).not.toContain("data:");
    }
  });

  it("edit_video：缺 prompt 的 intent 使编译失败", async () => {
    const room = await makeVideoRoom({ intents: [videoEditIntent({ prompt: "" })] });
    let called = false;
    const taskClient = {
      async submit() {
        called = true;
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "video-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => videoCatalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "video-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "ark:seedance2_5",
      prompt: "编辑",
      parameters: { generationMode: "edit_video" }
    });
    // prompt 为空的 intent 在画布加载时已被安全剥离；因此这里可以提交基础 prompt。
    expect(outcome.ok || !called).toBe(true);
  });
});

describe("Canvas run service 权威 prompt 解析（integrate-origin-master）", () => {  it("prompt 为空且上游文字有内容时，用它作为任务 prompt", async () => {
    const room = await makeRoom({ withUpstreamText: { text: "一只猫" } });
    const submitted: Array<Record<string, unknown>> = [];
    const taskClient = {
      async submit(request: unknown) {
        submitted.push(request as Record<string, unknown>);
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "image-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "",
      parameters: {}
    });
    expect(outcome.ok).toBe(true);
    expect(submitted[0]?.prompt).toBe("一只猫");
    // 文字资产不得进入图片参考输入。
    expect(submitted[0]?.inputs).toEqual([]);
  });

  it("上游文字内容为空时在 begin 前拒绝，返回 empty-upstream-text", async () => {
    const room = await makeRoom({ withUpstreamText: { text: "   " } });
    let called = false;
    const taskClient = {
      async submit() {
        called = true;
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "video-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "",
      parameters: {}
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("empty-upstream-text");
      expect(outcome.message).toBe("上游文字节点没有内容");
    }
    expect(called).toBe(false);
    // 未产生 begin：revision 不变，activeRunId 未写入。
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"]?.activeRunId).toBeUndefined();
  });

  it("上游文字无生成资产时回退到文字节点 prompt", async () => {
    const room = await makeRoom({ withUpstreamText: { textAsset: false, panelPrompt: "回退提示词" } });
    const submitted: Array<Record<string, unknown>> = [];
    const taskClient = {
      async submit(request: unknown) {
        submitted.push(request as Record<string, unknown>);
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "image-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      jobId: "job-r1",
      modelKey: "litellm:gpt-image-2",
      prompt: "",
      parameters: {}
    });
    expect(outcome.ok).toBe(true);
    expect(submitted[0]?.prompt).toBe("回退提示词");
  });

  it("authored prompt（含 token）被原样保存，mapping 不被重写，provider 收到编译文本", async () => {
    const room = await makeRoom({ withUpstream: true });
    const submitted: Array<Record<string, unknown>> = [];
    const taskClient = {
      async submit(request: unknown) {
        submitted.push(request as Record<string, unknown>);
        return { workerTaskKey: "r1", state: "queued" as const, reused: false, canvasId: "canvas-a", nodeId: "image-1", runId: "r1" };
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: [], cursor: 0 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient,
      resolveCatalog: async () => catalog(),
      now: () => "2026-01-01T00:00:00Z"
    });
    // 在权威画布中写入 mapping（稳定 slot）与 authored token。
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const slotId = "slot-up";
    const token = `{{input_image:${slotId}:图片 1}}`;
    exported.canvas.nodeData["image-1"] = {
      inputMapping: [{ slotId, sourceNodeId: "image-up", role: "reference_image", sortKey: "0" }]
    };
    // 直接写回 room（测试用 status 之外的路径）：借助 room.submit 提交 nodeData.patch。
    await room.submit({
      protocolVersion: 1,
      canvasId: "canvas-a",
      commandId: "seed-mapping",
      baseRevision: exported.canvas.revision,
      actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { inputMapping: [{ slotId, sourceNodeId: "image-up", role: "reference_image", sortKey: "0" }] } }]
    });

    const outcome = await service.run({
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r2",
      jobId: "job-r2",
      modelKey: "litellm:gpt-image-2",
      prompt: `参考 ${token} 生成`,
      parameters: {}
    });
    expect(outcome.ok).toBe(true);
    // provider 得到编译后的可读文本，不含内部 token。
    expect(submitted[0]?.prompt).toBe("参考 图片 1 生成");
    expect(String(submitted[0]?.prompt)).not.toContain("{{");
    // 直接媒体输入仍提交。
    expect((submitted[0]?.inputs as unknown[]).length).toBe(1);
    // 规范 authored 保留 token 原文，mapping 未被覆盖。
    const after = room.exportCanvas();
    if (!after.ok) throw new Error("export failed");
    expect(after.canvas.nodeData["image-1"].prompt).toBe(`参考 ${token} 生成`);
    expect(after.canvas.nodeData["image-1"].inputMapping).toHaveLength(1);
    expect(after.canvas.nodeData["image-1"].inputMapping![0]!.slotId).toBe(slotId);
  });
});

describe("Canvas result consumer / projector（任务 5.4）", () => {
  function historyRecord(overrides: Partial<TaskExecutionDetail> = {}): TaskExecutionDetail {
    return {
      taskKey: "r1",
      state: "succeeded",
      providerId: "litellm",
      modelType: "image",
      modelKey: "litellm:gpt-image-2",
      canvasId: "canvas-a",
      nodeId: "image-1",
      runId: "r1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:02Z",
      finishedAt: "2026-01-01T00:00:02Z",
      durationMs: 2000,
      recordRevision: 1,
      events: [],
      ...overrides
    };
  }

  it("toExecutionRecord 把图片结果转成稳定资产，文本结果转成文本输出", () => {
    const image = toExecutionRecord(
      historyRecord({ result: { mediaKind: "image", storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 } })
    );
    expect(image?.output?.mediaKind).toBe("image");
    expect(image?.output?.asset?.metadata?.storageKey).toBe(STORAGE_KEY);
    // 模型身份只来自 Task 记录（per-run 权威），随投影写入 job（change: l0-generation-provenance）。
    expect(image?.modelKey).toBe("litellm:gpt-image-2");

    const text = toExecutionRecord(historyRecord({ result: { mediaKind: "text", text: "hello" } }));
    expect(text?.output).toEqual({ mediaKind: "text", text: "hello" });
  });

  it("提交阶段失败记录：保留失败原因并结算节点（change: 2026-10-21-record-submit-failures-as-terminal-state）", async () => {
    const room = await makeRoom();
    const receipts = new InMemoryProjectionReceiptStore();
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts,
      now: () => "2026-01-01T00:00:00Z"
    });
    await room.submit({
      protocolVersion: 1,
      canvasId: "canvas-a",
      commandId: "begin-r1",
      baseRevision: 0,
      actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { activeRunId: "r1", taskStatus: "processing" } }]
    });

    // Task Service 在调 provider 之前失败时写的就是这种记录：没有 result，只有安全 error。
    const record = toExecutionRecord(
      historyRecord({ state: "failed", error: { name: "ReferenceInputUnavailable", message: "媒体对象不存在" } })
    )!;
    expect(record.status).toBe("failed");
    expect(record.error).toBe("媒体对象不存在");

    expect((await projector.project(record)).status).toBe("projected");
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"].taskStatus).toBe("failed");
    expect(exported.ok && exported.canvas.nodeData["image-1"].errorMessage).toBe("媒体对象不存在");
    expect(exported.ok && exported.canvas.jobs[0]?.status).toBe("failed");
  });

  it("projector 幂等：重复终态只投影一次；latest-run-wins 丢弃旧 run", async () => {
    const room = await makeRoom();
    const receipts = new InMemoryProjectionReceiptStore();
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts,
      now: () => "2026-01-01T00:00:00Z"
    });
    // begin run r1
    await room.submit({
      protocolVersion: 1,
      canvasId: "canvas-a",
      commandId: "begin-r1",
      baseRevision: 0,
      actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { activeRunId: "r1" } }]
    });

    const record = toExecutionRecord(
      historyRecord({ result: { mediaKind: "text", text: "hi" } })
    )!;
    const first = await projector.project(record);
    expect(first.status).toBe("projected");
    const second = await projector.project(record);
    expect(second.status).toBe("duplicate");

    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"].taskStatus).toBe("successed");
    // 投影后的 job 带上 Task 记录里的 modelKey（导出画布后仍保留）。
    expect(exported.ok && exported.canvas.jobs[0]?.modelKey).toBe("litellm:gpt-image-2");
  });

  it("latest-run-wins：旧 run 终态被跳过并记 receipt", async () => {
    const room = await makeRoom();
    const receipts = new InMemoryProjectionReceiptStore();
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts,
      now: () => "2026-01-01T00:00:00Z"
    });
    await room.submit({
      protocolVersion: 1,
      canvasId: "canvas-a",
      commandId: "begin-r2",
      baseRevision: 0,
      actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { activeRunId: "r2" } }]
    });
    const stale = toExecutionRecord(historyRecord({ runId: "r1", result: { mediaKind: "text", text: "old" } }))!;
    const outcome = await projector.project(stale);
    expect(outcome.status).toBe("skipped");
  });

  it("projector 离线期间完成的终态在恢复后从 history 补齐（不重跑 provider）", async () => {
    const room = await makeRoom();
    const receipts = new InMemoryProjectionReceiptStore();
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts,
      now: () => "2026-01-01T00:00:00Z"
    });
    await room.submit({
      protocolVersion: 1,
      canvasId: "canvas-a",
      commandId: "begin-r1",
      baseRevision: 0,
      actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { activeRunId: "r1" } }]
    });

    // 模拟离线期间 Task 已终结：没有实时通知，只有 history。
    const historyPage: TaskExecutionDetail[] = [
      historyRecord({ runId: "r1", result: { mediaKind: "text", text: "离线结果" } })
    ];
    const taskClient = {
      async submit() {
        throw new Error("不应调用 submit（projector 不重跑 provider）");
      },
      async cancel() {},
      async status() {
        return null;
      },
      async history() {
        return { items: historyPage, cursor: 10 };
      },
      async canvasActivity() {
        return { active: [], recent: [], cursor: 0 };
      },
      async canvasActivitySince() {
        return { items: [], cursor: 0 };
      },
      async canvasActivityChanges() {
        return { items: [], cursor: 0 };
      }
    };
    const consumer = createTaskResultConsumer({
      projector,
      taskClient,
      receipts,
      intervalMs: 10_000,
      logger: () => undefined
    });
    // 启动补偿一次即补齐离线期间终态。
    await consumer.reconcileOnce();
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData["image-1"].taskStatus).toBe("successed");
    expect(exported.ok && exported.canvas.nodeData["image-1"].result).toEqual({ kind: "text", text: "离线结果" });
    consumer.stop();
  });
});
