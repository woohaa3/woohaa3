/**
 * Canvas Agent run adapter
 * （change: add-agent-canvas-authoring-mcp，任务 6.1–6.5 / design D10）。
 *
 * 把 MCP Agent 的类型化 run/status/cancel/output 意图映射到 Canvas 已有的权威生命周期：
 * - run/cancel 复用 `CanvasRunService`（catalog 校验、prompt/reference 编译、durable begin、
 *   Task 提交、取消、latest-run-wins）；本 adapter 不复制任何任务权威；
 * - status/output 从 canonical nodeData/jobs/asset 派生，不把 provider 临时状态声明为成功；
 * - output 对文本有界返回、对媒体只返回受授权同源引用与安全 metadata。
 */
import type { CanvasRoom } from "../sync/index.js";
import {
  AGENT_TEXT_OUTPUT_MAX_CHARS,
  mediaPublicUrlFor,
  type AgentNodeOutputView,
  type AgentRunView,
  type CanvasNodeData,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import type { CanvasRunService } from "../task/run-service.js";

export type AgentRunPort = Pick<CanvasRunService, "run" | "cancel">;

export type AgentRunAdapterDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  runService?: AgentRunPort;
  now?: () => string;
};

export type AgentRunAccepted =
  | { ok: true; canvasId: string; nodeId: string; runId: string; jobId: string; state: "accepted" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentRunStatus =
  | { ok: true; view: AgentRunView }
  | { ok: false; code: string; message: string };

export type AgentRunCancel =
  | { ok: true; canvasId: string; nodeId: string; runId: string; state: "cancel-requested" | "already-terminal" | "stale-run" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentOutput =
  | { ok: true; nodeId: string; runId: string; view: AgentNodeOutputView }
  | { ok: false; code: string; message: string };

/** 确定性派生 runId/jobId：同 canvas + requestId 重试得到同一 run（任务 6.2）。 */
export function deriveRunIdentity(canvasId: string, nodeId: string, requestId: string): { runId: string; jobId: string } {
  const digest = hashText(`${canvasId}\u0000${nodeId}\u0000${requestId}`);
  return { runId: `agent-run-${digest}`, jobId: `agent-job-${digest}` };
}

export class AgentRunAdapter {
  private readonly deps: AgentRunAdapterDependencies;

  constructor(deps: AgentRunAdapterDependencies) {
    this.deps = deps;
  }

  async run(input: {
    canvasId: string;
    requestId: string;
    nodeId: string;
    modelKey?: string;
    prompt?: string;
    parameters?: Record<string, unknown>;
  }): Promise<AgentRunAccepted> {
    if (!this.deps.runService) {
      return { ok: false, code: "run-unavailable", message: "本部署未启用节点执行" };
    }
    const room = await this.deps.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message, retryable: true };

    // 模型身份只接受 opaque modelKey；节点 nodeData.modelKey 作为缺省（change:
    // 2026-10-07-remove-residual-compatibility）。
    const data = exported.canvas.nodeData[input.nodeId] as CanvasNodeData | undefined;
    const modelKey =
      input.modelKey ??
      (typeof data?.modelKey === "string" ? data.modelKey : "") ??
      "";
    if (modelKey === "") {
      return { ok: false, code: "model-required", message: "缺少 modelKey 且节点没有默认模型" };
    }

    const { runId, jobId } = deriveRunIdentity(input.canvasId, input.nodeId, input.requestId);
    const outcome = await this.deps.runService.run({
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      runId,
      jobId,
      modelKey,
      prompt: input.prompt ?? (typeof data?.prompt === "string" ? data.prompt : ""),
      parameters: input.parameters ?? {}
    });
    if (!outcome.ok) {
      const retryable = outcome.code === "catalog-unavailable" || outcome.code === "task-unavailable";
      return { ok: false, code: outcome.code, message: outcome.message, retryable };
    }
    return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId, jobId, state: "accepted" };
  }

  async status(input: { canvasId: string; nodeId: string; runId: string; waitMs?: number }): Promise<AgentRunStatus> {
    const room = await this.deps.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    let view = projectRunView(input.canvasId, input.nodeId, input.runId, exported.canvas);
    // 有界 long-poll：仅在 active 且请求了 waitMs 时轮询，最长 AGENT_RUN_MAX_WAIT_MS 由契约钳制。
    const waitMs = input.waitMs ?? 0;
    if (view.phase !== "terminal" && waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        const latest = room.exportCanvas();
        if (!latest.ok) break;
        view = projectRunView(input.canvasId, input.nodeId, input.runId, latest.canvas);
        if (view.phase === "terminal" || view.stale) break;
      }
    }
    return { ok: true, view };
  }

  async cancel(input: { canvasId: string; nodeId: string; runId: string }): Promise<AgentRunCancel> {
    const room = await this.deps.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message, retryable: true };

    const view = projectRunView(input.canvasId, input.nodeId, input.runId, exported.canvas);
    // stale 优先：run 已被较新 run 取代时明确返回 stale-run，不冒充已终态。
    if (view.stale) {
      return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, state: "stale-run" };
    }
    if (view.phase === "terminal") {
      return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, state: "already-terminal" };
    }
    if (!this.deps.runService) {
      return { ok: false, code: "run-unavailable", message: "本部署未启用节点执行" };
    }
    const outcome = await this.deps.runService.cancel({ canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId });
    if (!outcome.ok) {
      if (outcome.code === "stale-run") {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, state: "stale-run" };
      }
      return { ok: false, code: outcome.code, message: outcome.message, retryable: outcome.code === "task-unavailable" };
    }
    return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, state: "cancel-requested" };
  }

  async output(input: { canvasId: string; nodeId: string; runId: string }): Promise<AgentOutput> {
    const room = await this.deps.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const view = projectOutputView(exported.canvas, input.canvasId, input.nodeId, input.runId);
    return { ok: true, nodeId: input.nodeId, runId: input.runId, view };
  }
}

/**
 * 从权威画布派生 run 视图（任务 6.3）。
 *
 * activeRunId === runId 时以 nodeData 状态为准；否则查 job：
 * - job 存在且终态 → terminal；
 * - 否则 stale（run 已被较新 run 取代且无终态证据）。
 */
export function projectRunView(canvasId: string, nodeId: string, runId: string, canvas: ServerCanvas): AgentRunView {
  const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return { protocolVersion: 1, canvasId, nodeId, runId, jobId: "", phase: "terminal", state: "failed", stale: true, error: "节点不存在" };
  }
  const job = canvas.jobs.find((entry) => entry.runId === runId && entry.nodeId === nodeId);
  const isActive = data?.activeRunId === runId;

  if (isActive) {
    const taskStatus = data?.taskStatus;
    const jobId = job?.id ?? "";
    if (taskStatus === "successed") {
      return { protocolVersion: 1, canvasId, nodeId, runId, jobId, phase: "terminal", state: "succeeded", stale: false, progress: 100 };
    }
    if (taskStatus === "failed") {
      return { protocolVersion: 1, canvasId, nodeId, runId, jobId, phase: "terminal", state: "failed", stale: false, ...(typeof data?.error === "string" ? { error: data.error } : {}) };
    }
    if (taskStatus === "cancelled") {
      return { protocolVersion: 1, canvasId, nodeId, runId, jobId, phase: "terminal", state: "cancelled", stale: false };
    }
    const phase = taskStatus === "processing" ? "running" : "queued";
    return { protocolVersion: 1, canvasId, nodeId, runId, jobId, phase, stale: false, ...(typeof data?.progress === "number" ? { progress: data.progress } : {}) };
  }

  // active run 不是本 run：job 终态可作为历史终态证据；否则 stale。
  if (job) {
    const jobId = job.id;
    if (job.status === "success" || job.status === "failed") {
      return {
        protocolVersion: 1,
        canvasId,
        nodeId,
        runId,
        jobId,
        phase: "terminal",
        state: job.status === "success" ? "succeeded" : "failed",
        stale: true,
        ...(job.error ? { error: job.error } : {})
      };
    }
    if (job.status === "running" || job.status === "queued") {
      return { protocolVersion: 1, canvasId, nodeId, runId, jobId, phase: "running", stale: true };
    }
  }
  return { protocolVersion: 1, canvasId, nodeId, runId, jobId: job?.id ?? "", phase: "terminal", state: "cancelled", stale: true };
}

/**
 * 从权威画布派生节点输出视图（任务 6.5）。
 *
 * 只有 run 仍是节点 active run 且终态成功时才返回输出；媒体只返回同源引用与安全 metadata
 * （不返回 storageKey/COS 凭据/临时 URL）。
 */
export function projectOutputView(canvas: ServerCanvas, canvasId: string, nodeId: string, runId: string): AgentNodeOutputView {
  const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { available: false, reason: "no-output", message: `节点 ${nodeId} 不存在` };

  const view = projectRunView(canvasId, nodeId, runId, canvas);
  if (view.stale) return { available: false, reason: "no-output", message: "run 已不是节点当前 run，无法读取输出" };
  if (view.phase !== "terminal") return { available: false, reason: "running", message: "run 尚未结束" };
  if (view.state === "failed") return { available: false, reason: "failed", message: view.error ?? "run 失败，无输出" };
  if (view.state === "cancelled") return { available: false, reason: "failed", message: "run 已取消，无输出" };

  const provenance = { canvasId, nodeId, runId, jobId: view.jobId };

  // 文本结果：优先 nodeData.result，其次文本 output asset。
  const result = data?.result as { kind?: unknown; text?: unknown } | undefined;
  if (result?.kind === "text" && typeof result.text === "string") {
    return { available: true, output: boundedTextOutput(runId, result.text, provenance) };
  }
  const outputAssetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  const asset = outputAssetId ? canvas.assets.find((entry) => entry.id === outputAssetId) : undefined;
  if (asset?.mediaKind === "text" && typeof asset.text === "string") {
    return { available: true, output: boundedTextOutput(runId, asset.text, provenance) };
  }
  if (!asset) return { available: false, reason: "no-output", message: "节点没有可读取的输出" };

  const storageKey = readStorageKey(asset);
  if (!storageKey) return { available: false, reason: "output-unavailable", message: "输出媒体缺少稳定引用" };
  const mediaKind = asset.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    return { available: false, reason: "output-unavailable", message: "输出不是可读取的媒体" };
  }

  const posterStorageKey = typeof data?.posterAssetId === "string"
    ? readStorageKey(canvas.assets.find((entry) => entry.id === data.posterAssetId))
    : null;
  return {
    available: true,
    output: {
      kind: mediaKind,
      runId,
      url: mediaPublicUrlFor(storageKey),
      contentType: readContentType(asset, storageKey),
      size: readSize(asset),
      ...(typeof data?.durationSeconds === "number" ? { durationSeconds: data.durationSeconds } : {}),
      ...(posterStorageKey ? { posterUrl: mediaPublicUrlFor(posterStorageKey) } : {}),
      provenance
    }
  };
}

function boundedTextOutput(
  runId: string,
  text: string,
  provenance: { canvasId: string; nodeId: string; runId: string; jobId: string }
) {
  const truncated = text.length > AGENT_TEXT_OUTPUT_MAX_CHARS;
  return {
    kind: "text" as const,
    runId,
    text: truncated ? text.slice(0, AGENT_TEXT_OUTPUT_MAX_CHARS) : text,
    truncated,
    provenance
  };
}

function readStorageKey(asset: StoredAsset | undefined): string | null {
  const key = asset?.metadata?.storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

function readSize(asset: StoredAsset): number {
  const size = asset.metadata?.size;
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
}

function readContentType(asset: StoredAsset, storageKey: string): string {
  const contentType = asset.metadata?.contentType;
  if (typeof contentType === "string" && contentType !== "") return contentType.split(";")[0]!.trim().toLowerCase();
  const extension = storageKey.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "mp4") return "video/mp4";
  if (extension === "webm") return "video/webm";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "ogg") return "audio/ogg";
  return "image/png";
}

function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
