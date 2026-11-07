/**
 * Skill 媒体续接端到端回归
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 6.1 / 6.2）。
 *
 * 本测试在本机宿主进程内串起真实 Canvas / Task 投影与 Application Service 的步骤 ledger：
 * - 6.1：组内图片生成 → 用户中断 → 改词重生成 → 外部 Agent 取得最新图片 → 引用该图片生成视频；
 * - 6.2：视频中断、Provider 取消失败、服务重启与事件游标断线恢复。
 *
 * 验证画布节点 activeRunId / job、任务历史、媒体 provenance、Skill 事件与最新输出始终指向
 * 最新有效尝试，且停止/等待不重复提交 Provider 请求。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type CanvasTaskCatalog,
  type CanvasTaskInputBinding,
  type CanvasTaskModelType,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import {
  AgentRunAdapter,
  CanvasRoom,
  CanvasRunService,
  CanvasTaskProjector,
  InMemoryProjectionReceiptStore,
  InMemoryYjsDocumentRepository,
  deriveRunIdentity,
  type PptaskExecutionRecord
} from "@woohaa3/canvas-service";
import {
  SqliteSkillMediaStore,
  createSkillMediaService,
  type SkillMediaCanvasPort,
  type SkillMediaService
} from "@woohaa3/application-service";

const NOW = "2026-10-28T00:00:00.000Z";
const CANVAS = "canvas-skill-e2e";
const GROUP = "group-1";
const IMAGE = "image-1";
const VIDEO = "video-1";
const OWNER = "owner-1";
const IMAGE_STEP = { owner: OWNER, canvasId: CANVAS, rootGroupId: GROUP, scopeEpoch: 1, skillRunId: "skill-image", stepId: "step-image" };
const VIDEO_STEP = { owner: OWNER, canvasId: CANVAS, rootGroupId: GROUP, scopeEpoch: 1, skillRunId: "skill-video", stepId: "step-video" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalog(): CanvasTaskCatalog {
  const model = (modelType: CanvasTaskModelType, key: string, bindings: CanvasTaskInputBinding[]) => ({
    providerId: "provider",
    providerModelId: key,
    modelKey: key,
    modelType,
    title: key,
    interaction: { id: "generic-model", version: 1 },
    // 视频模型必须声明参数 schema（guard-video-generation-inputs）；本测试只关心媒体续接，
    // 所以只声明 prompt、不加必填参数，避免把参数校验混进续接用例。
    inputSchema: modelType === "video" ? { type: "object", properties: { prompt: { type: "string", title: "提示词" } } } : {},
    defaultInput: {},
    taskTimeoutMs: 1_000,
    bindings
  });
  return {
    available: true,
    defaultModels: {},
    models: [
      model("image", "image-model", []),
      model("video", "video-model", [
        { field: "images", semantic: "reference-image", roles: ["reference_image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 1, valueFormat: "reference" }
      ])
    ]
  };
}

function asset(runId: string, mediaKind: "image" | "video", id: string): StoredAsset {
  const checksum = (id.includes("poster") ? "c" : "a").repeat(64);
  return {
    id,
    nodeId: mediaKind === "video" ? VIDEO : IMAGE,
    title: `${mediaKind} ${runId}`,
    mediaKind,
    source: "generated",
    status: "ready",
    url: `/api/media/${runId}`,
    createdAt: NOW,
    provenance: { runId, taskNodeId: mediaKind === "video" ? VIDEO : IMAGE },
    metadata: {
      storageKey: `sha256-${checksum}`,
      checksum,
      size: 4,
      contentType: mediaKind === "image" ? "image/png" : "video/mp4"
    }
  };
}

function record(input: {
  nodeId: string;
  runId: string;
  jobId: string;
  status: "succeeded" | "failed" | "cancelled";
  mediaKind?: "image" | "video";
  terminalAt: string;
}): PptaskExecutionRecord {
  const assetId = `asset-${input.runId}`;
  return {
    taskKey: input.runId,
    status: input.status,
    canvasId: CANVAS,
    nodeId: input.nodeId,
    runId: input.runId,
    jobId: input.jobId,
    modelKey: input.mediaKind === "video" ? "video-model" : "image-model",
    ...(input.status === "succeeded" && input.mediaKind
      ? {
        output: {
          mediaKind: input.mediaKind,
          asset: { ...asset(input.runId, input.mediaKind, assetId), nodeId: input.nodeId },
          ...(input.mediaKind === "video"
            ? { posterAsset: { ...asset(`${input.runId}-poster`, "image", `poster-${input.runId}`), nodeId: input.nodeId }, durationSeconds: 3 }
            : {})
        }
      }
      : {}),
    terminalAt: input.terminalAt
  };
}

type Harness = {
  room: CanvasRoom;
  skillMedia: SkillMediaService;
  runAdapter: AgentRunAdapter;
  projector: CanvasTaskProjector;
  submitted: Array<{ runId?: string; inputs?: unknown[] }>;
  cancelled: string[];
  history: PptaskExecutionRecord[];
  failCancelFor: Set<string>;
  restart: () => { service: SkillMediaService; store: SqliteSkillMediaStore };
  close: () => void;
};

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "woohaa-skill-e2e-"));
  dirs.push(dir);
  const dbPath = join(dir, "application.sqlite");
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({
    canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "seed",
    baseRevision: 0,
    actorId: "test",
    commands: [
      { type: "node.add", node: { id: IMAGE, type: "image", position: { x: 0, y: 0 } } },
      {
        type: "nodeData.patch",
        nodeId: IMAGE,
        value: { title: "主图", prompt: "旧提示词", panelPrompt: "旧提示词", modelKey: "image-model" }
      }
    ]
  });

  const submitted: Array<{ runId?: string; inputs?: unknown[] }> = [];
  const cancelled: string[] = [];
  const failCancelFor = new Set<string>();
  const runService = new CanvasRunService({
    resolveRoom: async () => room,
    taskClient: {
      submit: async (input: { runId?: string; inputs?: unknown[] }) => { submitted.push(input); },
      cancel: async (taskKey: string) => {
        cancelled.push(taskKey);
        if (failCancelFor.has(taskKey)) throw new Error("provider cancel unavailable");
      }
    } as never,
    resolveCatalog: async () => catalog(),
    now: () => NOW
  });

  let skillMedia!: SkillMediaService;
  const adapter = new AgentRunAdapter({
    resolveRoom: async () => room,
    runService,
    skillAttempts: () => skillMedia,
    now: () => NOW
  });
  const canvas: SkillMediaCanvasPort = {
    run: (input) => adapter.run(input),
    cancel: (input) => adapter.cancel(input),
    status: (input) => adapter.status(input),
    output: (input) => adapter.output(input)
  };

  let canvasStore = new SqliteSkillMediaStore({ path: dbPath });
  const history: PptaskExecutionRecord[] = [];
  skillMedia = createSkillMediaService({
    store: canvasStore,
    canvas,
    deriveRunId: ({ canvasId, nodeId, requestId }) => deriveRunIdentity(canvasId, nodeId, requestId).runId,
    authorize: async () => ({ ok: true }),
    now: () => NOW,
    pollMs: 1
  });
  const projector = new CanvasTaskProjector({
    resolveRoom: async () => room,
    receipts: new InMemoryProjectionReceiptStore(),
    registerHistory: async (entry) => { history.push(entry); },
    registerFailure: async (entry) => { history.push(entry); },
    onSettled: (entry) => {
      skillMedia.settleFromRun({
        canvasId: entry.canvasId,
        nodeId: entry.nodeId,
        runId: entry.runId,
        jobId: entry.jobId,
        state: entry.status,
        ...(entry.output?.mediaKind ? { mediaKind: entry.output.mediaKind } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        terminalAt: entry.terminalAt
      });
    },
    now: () => NOW
  });

  return {
    room,
    skillMedia,
    runAdapter: adapter,
    projector,
    submitted,
    cancelled,
    history,
    failCancelFor,
    restart: () => {
      canvasStore.close();
      canvasStore = new SqliteSkillMediaStore({ path: dbPath });
      const service = createSkillMediaService({ store: canvasStore, canvas, deriveRunId: ({ canvasId, nodeId, requestId }) => deriveRunIdentity(canvasId, nodeId, requestId).runId, authorize: async () => ({ ok: true }), now: () => NOW, pollMs: 1 });
      return { service, store: canvasStore };
    },
    close: () => canvasStore.close()
  };
}

async function exported(h: Harness): Promise<ServerCanvas> {
  const result = h.room.exportCanvas();
  if (!result.ok) throw new Error(result.message);
  return result.canvas;
}

describe("Skill 媒体续接端到端（任务 6.1 / 6.2）", () => {
  it("图片中断改词重生成后，外部 Agent 取得最新图片并可继续生成视频", async () => {
    const h = await createHarness();
    try {
      // 1) 首个图片尝试：ledger begin + 真实 Canvas run（同一步骤身份）。
      const imageRun1 = deriveRunIdentity(CANVAS, IMAGE, "image-req-1").runId;
      const imageJob1 = deriveRunIdentity(CANVAS, IMAGE, "image-req-1").jobId;
      expect(await h.skillMedia.begin({
        ...IMAGE_STEP, nodeId: IMAGE, requestId: "image-req-1", runId: imageRun1, jobId: imageJob1, prompt: "旧提示词", modelKey: "image-model"
      })).toMatchObject({ ok: true });
      expect(await h.runAdapter.run({
        owner: OWNER, canvasId: CANVAS, nodeId: IMAGE, requestId: "image-req-1", runId: imageRun1, modelKey: "image-model", prompt: "旧提示词",
        skill: { skillRunId: IMAGE_STEP.skillRunId, stepId: IMAGE_STEP.stepId, attempt: 1, promptRevision: 1 }
      })).toMatchObject({ ok: true, runId: imageRun1, jobId: imageJob1 });
      expect(h.submitted.map((entry) => entry.runId)).toEqual([imageRun1]);

      // 2) 用户停止：Provider 未确认前保持 cancel-requested。
      const cancelled = await h.skillMedia.cancel(IMAGE_STEP);
      expect(cancelled).toMatchObject({ ok: true, state: "cancel-requested" });

      // 3) 改提示词重生成：新 attempt 立即成为当前尝试，旧 run 只保留历史。
      const replaced = await h.skillMedia.replace({ ...IMAGE_STEP, requestId: "image-req-2", prompt: "新提示词", modelKey: "image-model" });
      expect(replaced.ok).toBe(true);
      if (!replaced.ok) return;
      const imageRun2 = replaced.runId;
      const imageJob2 = deriveRunIdentity(CANVAS, IMAGE, "image-req-2").jobId;
      expect(replaced.step.attempts.map((entry) => entry.state)).toEqual(["cancel-requested", "queued"]);
      expect(replaced.step.currentAttempt).toBe(2);

      // 4) 旧 run 迟到成功：只登记历史，不覆盖当前节点或 Skill 当前尝试。
      expect(await h.projector.project(record({ nodeId: IMAGE, runId: imageRun1, jobId: imageJob1, status: "succeeded", mediaKind: "image", terminalAt: "2026-10-28T00:00:05Z" })))
        .toMatchObject({ status: "skipped", reason: "stale-run" });
      const afterLate = await h.skillMedia.snapshot(IMAGE_STEP);
      expect(afterLate.ok && afterLate.step.attempts[0]).toMatchObject({ state: "cancel-requested", superseded: true });
      expect(afterLate.ok && afterLate.step.latestSuccessfulRunId).toBeUndefined();

      // 5) 新 run 成功：节点输出与 provenance 指向 run-2。
      expect(await h.projector.project(record({ nodeId: IMAGE, runId: imageRun2, jobId: imageJob2, status: "succeeded", mediaKind: "image", terminalAt: "2026-10-28T00:00:09Z" })))
        .toMatchObject({ status: "projected" });
      let canvas = await exported(h);
      expect(canvas.nodeData[IMAGE]).toMatchObject({ activeRunId: imageRun2, taskStatus: "successed", outputAssetId: `asset-${imageRun2}` });

      // 6) 外部 Agent 读取最新图片：只拿到稳定同源引用与 provenance。
      const imageOutput = await h.skillMedia.latestOutput(IMAGE_STEP);
      expect(imageOutput.ok && imageOutput.view).toMatchObject({
        available: true,
        current: true,
        runId: imageRun2,
        output: { kind: "image", provenance: { canvasId: CANVAS, nodeId: IMAGE, runId: imageRun2 } }
      });
      if (imageOutput.ok && imageOutput.view.available && imageOutput.view.current && imageOutput.view.output.kind === "image") {
        expect(imageOutput.view.output.url.startsWith("/api/media/")).toBe(true);
        expect(imageOutput.view.output.url).not.toMatch(/^https?:|^data:|^blob:/);
        expect(imageOutput.view.output.provenance.jobId).toBe(imageJob2);
      }

      // 7) 用最新图片作为参考输入创建视频节点并生成。
      canvas = await exported(h);
      const imageAssetId = canvas.nodeData[IMAGE]?.outputAssetId;
      expect(typeof imageAssetId).toBe("string");
      await h.room.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId: "add-video",
        baseRevision: canvas.revision,
        actorId: "agent",
        commands: [
          { type: "node.add", node: { id: VIDEO, type: "video", position: { x: 240, y: 0 } } },
          { type: "edge.add", edge: { id: "edge-image-video", source: IMAGE, target: VIDEO } },
          {
            type: "nodeData.patch",
            nodeId: VIDEO,
            value: {
              title: "视频",
              prompt: "让主图动起来",
              panelPrompt: "让主图动起来",
              modelKey: "video-model",
              inputMapping: [{ sourceNodeId: IMAGE, slotId: "image-slot", role: "reference_image" }]
            }
          }
        ]
      });
      const videoRun1 = deriveRunIdentity(CANVAS, VIDEO, "video-req-1").runId;
      const videoJob1 = deriveRunIdentity(CANVAS, VIDEO, "video-req-1").jobId;
      expect(await h.skillMedia.begin({ ...VIDEO_STEP, nodeId: VIDEO, requestId: "video-req-1", runId: videoRun1, jobId: videoJob1, prompt: "让主图动起来", modelKey: "video-model" }))
        .toMatchObject({ ok: true });
      expect(await h.runAdapter.run({
        owner: OWNER, canvasId: CANVAS, nodeId: VIDEO, requestId: "video-req-1", runId: videoRun1, modelKey: "video-model", prompt: "让主图动起来",
        skill: { skillRunId: VIDEO_STEP.skillRunId, stepId: VIDEO_STEP.stepId, attempt: 1, promptRevision: 1 }
      })).toMatchObject({ ok: true, runId: videoRun1 });
      // 视频任务输入来自上一张最新图片（assistant 取得的稳定资产引用）。
      expect(h.submitted.find((entry) => entry.runId === videoRun1)?.inputs).toEqual([
        expect.objectContaining({ assetId: `asset-${imageRun2}`, role: "reference_image", mediaKind: "image" })
      ]);

      // 8) 视频成功：任务输入携带上一张最新图片，媒体 provenance 指向视频 run。
      expect(await h.projector.project(record({ nodeId: VIDEO, runId: videoRun1, jobId: videoJob1, status: "succeeded", mediaKind: "video", terminalAt: "2026-10-28T00:00:15Z" })))
        .toMatchObject({ status: "projected" });
      canvas = await exported(h);
      expect(canvas.nodeData[VIDEO]).toMatchObject({ activeRunId: videoRun1, taskStatus: "successed", outputAssetId: `asset-${videoRun1}`, posterAssetId: `poster-${videoRun1}` });
      const videoOutput = await h.skillMedia.latestOutput(VIDEO_STEP);
      expect(videoOutput.ok && videoOutput.view).toMatchObject({
        available: true,
        current: true,
        output: { kind: "video", durationSeconds: 3, provenance: { runId: videoRun1 } }
      });
      const steps = await h.skillMedia.list({ owner: OWNER, canvasId: CANVAS });
      expect(steps.ok && Object.fromEntries(steps.steps.map((entry) => [entry.stepId, [entry.currentAttempt, entry.latestSuccessfulRunId]]))).toEqual({
        "step-image": [2, imageRun2],
        "step-video": [1, videoRun1]
      });
      const events = await h.skillMedia.events({ ...IMAGE_STEP, after: 0 });
      expect(events.ok).toBe(true);
      if (events.ok) {
        expect(events.page.events.some((entry) => entry.state === "succeeded" && entry.runId === imageRun2)).toBe(true);
        expect(events.page.events.some((entry) => entry.state === "succeeded" && entry.runId === imageRun1)).toBe(false);
        expect(JSON.stringify(events.page.events)).not.toContain("新提示词");
      }
    } finally {
      h.close();
    }
  });

  it("视频中断 + Provider 取消失败 + 重启与事件游标恢复都不重复提交", async () => {
    const h = await createHarness();
    try {
      const run1 = deriveRunIdentity(CANVAS, VIDEO, "video-req-1").runId;
      const job1 = deriveRunIdentity(CANVAS, VIDEO, "video-req-1").jobId;
      await h.room.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId: "add-video",
        baseRevision: (await exported(h)).revision,
        actorId: "agent",
        commands: [{ type: "node.add", node: { id: VIDEO, type: "video", position: { x: 240, y: 0 } } }, { type: "nodeData.patch", nodeId: VIDEO, value: { prompt: "旧视频", panelPrompt: "旧视频", modelKey: "video-model" } }]
      });
      expect(await h.skillMedia.begin({ ...VIDEO_STEP, nodeId: VIDEO, requestId: "video-req-1", runId: run1, jobId: job1, prompt: "旧视频", modelKey: "video-model" }))
        .toMatchObject({ ok: true });
      expect(await h.runAdapter.run({
        owner: OWNER, canvasId: CANVAS, nodeId: VIDEO, requestId: "video-req-1", runId: run1, modelKey: "video-model", prompt: "旧视频",
        skill: { skillRunId: VIDEO_STEP.skillRunId, stepId: VIDEO_STEP.stepId, attempt: 1, promptRevision: 1 }
      })).toMatchObject({ ok: true, runId: run1 });
      h.failCancelFor.add(run1);
      const replaced = await h.skillMedia.replace({ ...VIDEO_STEP, requestId: "video-req-2", prompt: "新视频", modelKey: "video-model" });
      expect(replaced.ok).toBe(true);
      if (!replaced.ok) return;
      const run2 = replaced.runId;
      const job2 = deriveRunIdentity(CANVAS, VIDEO, "video-req-2").jobId;
      // 取消失败不回滚新 attempt，旧尝试保持「取消中 + 已替代」。
      expect(replaced.step.attempts[0]).toMatchObject({ state: "cancel-requested", superseded: true, supersededByRunId: run2 });
      expect(replaced.step.currentAttempt).toBe(2);

      // 旧视频迟到成功不能覆盖当前结果。
      expect(await h.projector.project(record({ nodeId: VIDEO, runId: run1, jobId: job1, status: "succeeded", mediaKind: "video", terminalAt: "2026-10-28T00:00:05Z" })))
        .toMatchObject({ status: "skipped", reason: "stale-run" });
      const late = await h.skillMedia.latestOutput(VIDEO_STEP);
      expect(late.ok && late.view).toMatchObject({ available: false, reason: "running", fallbackAvailable: false });

      // 新尝试成功后节点才出现结果。
      expect(await h.projector.project(record({ nodeId: VIDEO, runId: run2, jobId: job2, status: "succeeded", mediaKind: "video", terminalAt: "2026-10-28T00:00:09Z" })))
        .toMatchObject({ status: "projected" });
      const submittedBeforeRestart = h.submitted.length;
      const eventsBefore = await h.skillMedia.events({ ...VIDEO_STEP, after: 0 });
      expect(eventsBefore.ok).toBe(true);
      const cursor = eventsBefore.ok ? eventsBefore.page.cursor : 0;

      // 服务重启：从持久事实恢复，不重新提交任何 Provider 请求。
      const restarted = h.restart();
      const snapshot = await restarted.service.snapshot(VIDEO_STEP);
      expect(snapshot.ok && snapshot.step.currentAttempt).toBe(2);
      expect(snapshot.ok && snapshot.step.latestSuccessfulRunId).toBe(run2);
      expect(h.submitted).toHaveLength(submittedBeforeRestart);
      expect(h.submitted.map((entry) => entry.runId)).toEqual([run1, run2]);

      // 断线恢复：重复游标 no-op；无法证明连续性时要求重读步骤快照。
      const duplicate = await restarted.service.events({ ...VIDEO_STEP, after: cursor });
      expect(duplicate.ok && duplicate.page.events).toEqual([]);
      const gap = await restarted.service.events({ ...VIDEO_STEP, after: cursor + 10 });
      expect(gap.ok && gap.page.resetRequired).toBe(true);
      const recovered = await restarted.service.snapshot(VIDEO_STEP);
      expect(recovered.ok && recovered.step.latestSuccessfulRunId).toBe(run2);
    } finally {
      h.close();
    }
  });
});
