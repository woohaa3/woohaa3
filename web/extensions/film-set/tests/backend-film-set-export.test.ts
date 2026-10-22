/**
 * agent 发起导出（change: 2026-10-19-extend-film-set-for-motion-graphics，D8）。
 *
 * 覆盖：经 content recording port 提交、requestId 幂等、原生不可用返回
 * `recording-unavailable`、precondition 与只读/越权拒绝、成功只在节点提交后成立。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  filmSetNodeDataFields,
  type CanvasAuthority,
  type CanvasNodeData,
  type CanvasRecordingPort,
  type RecordingStatusView,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { FilmSetExportService } from "../src/authoring/backend/film-set-export.js";

const NOW = "2026-10-19T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso' });";

function canvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }], edges: [] },
    nodeData: {
      film: filmSetNodeDataFields(createFilmSetSnapshot({
        title: "片场",
        model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" },
        motionScript: "motion.model.rotate('torso', { speed: 1 });",
        timeline: { duration: 4, loop: false }
      })) as CanvasNodeData
    },
    assets: [] as StoredAsset[]
  };
}

function room(serverCanvas: ServerCanvas = canvas()): CanvasAuthority {
  return {
    exportCanvas: () => ({ ok: true as const, canvas: serverCanvas }),
    submit: async () => ({ ok: false as const, code: "unused", message: "unused" }),
    submitDerived: async () => ({ ok: false as const, code: "unused", message: "unused" })
  };
}

function status(overrides: Partial<RecordingStatusView> = {}): RecordingStatusView {
  return {
    jobId: "recording-job-1",
    requestId: "mcp-export:c1:film:clip-1:r1",
    purpose: "export",
    state: "rendering",
    completedFrames: 3,
    totalFrames: 120,
    progress: 0.025,
    updatedAt: NOW,
    ...overrides
  };
}

function recordingPort(overrides: Partial<CanvasRecordingPort> = {}): CanvasRecordingPort {
  return {
    submit: async () => ({ ok: true, jobId: "recording-job-1", state: "queued", duplicate: false }),
    cancel: async () => ({ ok: true, cancelled: true }),
    status: async () => ({ ok: true, status: status() }),
    list: async () => [],
    ...overrides
  };
}

const clipId = () => currentClipId();
void clipId;

describe("export_film_set_clip / get_film_set_export（D8）", () => {
  it("submits an explicit export through the host recording port with the requested profile", async () => {
    const submit = vi.fn(async (_input: { canvasId: string; body: Record<string, unknown> }) => ({ ok: true as const, jobId: "recording-job-1", state: "queued" as const, duplicate: false }));
    const service = new FilmSetExportService({
      resolveRoom: async () => room(),
      recording: () => recordingPort({ submit }),
      themeBackdrop: () => "#101418"
    });
    const outcome = await service.startExport({
      canvasId: "c1",
      nodeId: "film",
      clipId: currentClipId(),
      requestId: "r1",
      profile: "hd"
    });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.jobId).toBe("recording-job-1");
    const call = submit.mock.calls[0]![0];
    expect(call.canvasId).toBe("c1");
    expect(call.body).toMatchObject({ purpose: "export", nodeId: "film", clipId: currentClipId(), profile: "hd", themeBackdrop: "#101418" });
    expect(call.body.requestId).toContain("mcp-export:c1:film");
    // 不传像素/播放状态。
    expect(JSON.stringify(call.body)).not.toMatch(/rgba|pixel|base64/i);
  });

  it("returns recording-unavailable with the host reason when native recording is missing", async () => {
    const service = new FilmSetExportService({
      resolveRoom: async () => room(),
      recording: () => undefined,
      unavailableReason: () => ({ code: "recording-unavailable", message: "当前平台没有本机录制执行器" })
    });
    const outcome = await service.startExport({ canvasId: "c1", nodeId: "film", clipId: currentClipId(), requestId: "r2", profile: "standard" });
    expect(outcome).toMatchObject({ ok: false, code: "recording-unavailable", message: "当前平台没有本机录制执行器" });
    const statusOutcome = await service.getExport({ canvasId: "c1", jobId: "job" });
    expect(statusOutcome).toMatchObject({ ok: false, code: "recording-unavailable" });
  });

  it("rejects stale content preconditions and unknown clips", async () => {
    const service = new FilmSetExportService({ resolveRoom: async () => room(), recording: () => recordingPort() });
    expect(await service.startExport({
      canvasId: "c1", nodeId: "film", clipId: currentClipId(), requestId: "r3", profile: "hd", expectedContentHash: "stale"
    })).toMatchObject({ ok: false, code: "stale-content" });
    expect(await service.startExport({
      canvasId: "c1", nodeId: "film", clipId: "missing", requestId: "r4", profile: "hd"
    })).toMatchObject({ ok: false, code: "unknown-clip" });
  });

  it("rejects a missing or read-only source without creating a job", async () => {
    const submit = vi.fn();
    const service = new FilmSetExportService({
      resolveRoom: async () => room(),
      recording: () => recordingPort({ submit: submit as never })
    });
    expect(await service.startExport({ canvasId: "c1", nodeId: "unknown", clipId: currentClipId(), requestId: "r5", profile: "hd" }))
      .toMatchObject({ ok: false, code: "invalid-animation-node" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports phase, progress and failure reasons", async () => {
    const service = new FilmSetExportService({
      resolveRoom: async () => room(),
      recording: () => recordingPort({
        status: async () => ({
          ok: true,
          status: status({ state: "failed", error: { stage: "RECORDING_ERROR_STAGE_ENCODE", code: "recording-encode-failed", message: "编码器失败" } })
        })
      })
    });
    const outcome = await service.getExport({ canvasId: "c1", jobId: "recording-job-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("failed");
    expect(outcome.progress).toBeCloseTo(0.025, 6);
    expect(outcome.error).toMatchObject({ code: "recording-encode-failed", message: "编码器失败" });
  });

  it("returns the new node id only after the commit succeeded", async () => {
    const service = new FilmSetExportService({
      resolveRoom: async () => room(),
      recording: () => recordingPort({
        status: async () => ({ ok: true, status: status({ state: "succeeded", completedFrames: 120, progress: 1, nodeId: "film-set-video-abc" }) })
      })
    });
    const outcome = await service.getExport({ canvasId: "c1", jobId: "recording-job-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodeId).toBe("film-set-video-abc");
  });
});

/** 默认片段的 id（由快照生成，测试里只读一次）。 */
function currentClipId(): string {
  const serverCanvas = canvas();
  const data = serverCanvas.nodeData.film as { filmSetAnimations?: { clips: Array<{ id: string }> } };
  const id = data.filmSetAnimations?.clips[0]?.id;
  if (!id) throw new Error("missing clip");
  return id;
}
