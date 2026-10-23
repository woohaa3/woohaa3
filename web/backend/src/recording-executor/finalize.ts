/**
 * 宿主录制成片的流式上传与权威提交
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 6.1 / 6.2 / 6.3）。
 *
 * 分层：
 * - worker 的成片只是**不可信字节**：这里重新校验大小/hash/媒体事实，再经现有 Media 端口
 *   流式上传，得到 stable storageKey；
 * - 保存走扩展的 `planCommit` 构造的单一原子批次，并用固定 `commandId` 提交，重复回执幂等；
 * - `cancel` 与提交由协调器线性化（见 `coordinator.ts`），这里只负责「已被接受的上传」。
 *
 * 不直接写 SQLite、不拼 Y.Doc；全部通过注入端口。
 */
import type { CanvasCommand } from "@woohaa3/contracts";
import type { ContentRecordingCommitPlan, ContentRecordingCommitRequest } from "@woohaa3/contracts";
import type { RecordingJobIdentity } from "./coordinator.js";
import {
  compareArtifact,
  probeArtifact,
  type ArtifactProbe,
  type ArtifactProbeFailure
} from "./probe.js";

/** 上传结果：与 Media 服务的返回一致（stable key + checksum）。 */
export type RecordingUploadedArtifact = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
};

export type RecordingUploadDeps = {
  /** 打开 worker 产物为可读流（或提供字节分块）；必须支持分块并有界。 */
  openArtifact: (input: { path: string; sizeBytes: number }) => Promise<AsyncIterable<Uint8Array>>;
  /** 上传到 Media；实现负责内容寻址与 stable key。 */
  upload: (input: {
    chunks: AsyncIterable<Uint8Array>;
    contentType: string;
    sizeBytes: number;
    fileName: string;
    /** 成片属于哪张画布：远端画布的字节必须写进托管存储，否则只有本机能读。 */
    canvasId: string;
    signal: AbortSignal;
  }) => Promise<{ ok: true; artifact: RecordingUploadedArtifact } | { ok: false; code: string; message: string }>;
  /** 权威提交：固定 commandId，返回是否 committed。 */
  submit: (input: {
    canvasId: string;
    commandId: string;
    commands: CanvasCommand[];
  }) => Promise<{ ok: true; duplicate: boolean } | { ok: false; code: string; message: string }>;
  log?: (event: Record<string, unknown>) => void;
};

export type RecordingArtifactClaim = {
  path: string;
  sizeBytes: number;
  /** 成片自查 sha256（宿主会重新计算并比对）。 */
  contentSha256: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameCount: number;
  mimeType: string;
};

export type RecordingCommitDeps = RecordingUploadDeps & {
  /** 内容扩展的提交计划。 */
  planCommit: (
    request: ContentRecordingCommitRequest & { sourcePosition?: { x: number; y: number; width: number } | null }
  ) => Promise<ContentRecordingCommitPlan>;
};

/**
 * 宿主独立复核成片字节（任务 4.4 / design D8）。
 *
 * worker 的自报只是**声明**：这里从实际字节重新解析容器、尺寸、时长、帧数与 codec，
 * 与任务期望比对后才允许上传。任何不一致都在上传前失败。
 */
export function verifyArtifactBytes(
  bytes: Uint8Array,
  expected: { width?: number; height?: number; durationSeconds?: number; frameRate?: number; contentSha256?: string }
): { ok: true; probe: ArtifactProbe } | ArtifactProbeFailure {
  const probe = probeArtifact(bytes);
  if (!probe.ok) return probe;
  const compared = compareArtifact(probe, expected);
  if (!compared.ok) return compared;
  return { ok: true, probe };
}

/** 上传失败/校验失败时的稳定错误。 */
export type RecordingFinalizeFailure = {
  ok: false;
  stage: "RECORDING_ERROR_STAGE_UPLOAD" | "RECORDING_ERROR_STAGE_COMMIT" | "RECORDING_ERROR_STAGE_MUX";
  code: string;
  message: string;
};

export type RecordingFinalizeResult =
  | { ok: true; artifact: RecordingUploadedArtifact; commandId: string; nodeId?: string; duplicate: boolean }
  | RecordingFinalizeFailure;

/**
 * 校验 worker 产物声明是否自洽。
 *
 * 只做**声明层**自洽性检查（大小/尺寸/时长/帧数/无音轨）；真实容器解析由执行器与
 * 宿主的 probe 适配完成。任何不一致都拒绝，避免把半成品当成功上传。
 */
export function validateArtifactClaim(claim: RecordingArtifactClaim, limits: {
  expectedWidth?: number;
  expectedHeight?: number;
  expectedDurationSeconds?: number;
  expectedFrameRate?: number;
}): RecordingFinalizeFailure | { ok: true } {
  if (!Number.isFinite(claim.sizeBytes) || claim.sizeBytes <= 0) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-empty",
      message: "成片大小非法"
    };
  }
  if (!/^[0-9a-f]{64}$/.test(claim.contentSha256)) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-unverified",
      message: "成片缺少合法 sha256"
    };
  }
  if (claim.width <= 0 || claim.height <= 0 || claim.width % 2 !== 0 || claim.height % 2 !== 0) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-wrong-size",
      message: "成片尺寸非法"
    };
  }
  if (limits.expectedWidth !== undefined && claim.width !== limits.expectedWidth) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-wrong-size",
      message: `成片宽度 ${claim.width} 与 profile ${limits.expectedWidth} 不一致`
    };
  }
  if (limits.expectedHeight !== undefined && claim.height !== limits.expectedHeight) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-wrong-size",
      message: `成片高度 ${claim.height} 与 profile ${limits.expectedHeight} 不一致`
    };
  }
  if (!(claim.durationSeconds > 0)) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-wrong-duration",
      message: "成片时长非法"
    };
  }
  if (limits.expectedDurationSeconds !== undefined) {
    const tolerance = Math.max(1 / (limits.expectedFrameRate ?? 30), 0.01);
    if (Math.abs(claim.durationSeconds - limits.expectedDurationSeconds) > tolerance) {
      return {
        ok: false,
        stage: "RECORDING_ERROR_STAGE_MUX",
        code: "recording-artifact-wrong-duration",
        message: `成片时长 ${claim.durationSeconds} 与片段 ${limits.expectedDurationSeconds} 不一致`
      };
    }
  }
  if (claim.frameCount <= 0) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-empty",
      message: "成片没有帧"
    };
  }
  if (claim.mimeType !== "video/mp4") {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-wrong-container",
      message: `成片容器不是 video/mp4（${claim.mimeType}）`
    };
  }
  return { ok: true };
}

/** 上传 + 提交一条龙；调用方负责先 `beginCommit` 再调用本函数。 */
export async function finalizeRecording(input: {
  identity: RecordingJobIdentity;
  claim: RecordingArtifactClaim;
  commitRequest: ContentRecordingCommitRequest;
  sourcePosition: { x: number; y: number; width: number } | null;
  limits: { expectedWidth?: number; expectedHeight?: number; expectedDurationSeconds?: number; expectedFrameRate?: number };
  deps: RecordingCommitDeps;
  signal: AbortSignal;
  /**
   * 宿主独立复核的实际字节（任务 4.4）。
   *
   * 未提供时**拒绝**：没有实际字节就无法验证容器/尺寸/时长/codec，不能只信 worker 声明。
   */
  readArtifactBytes?: (input: { path: string; sizeBytes: number }) => Promise<Uint8Array>;
}): Promise<RecordingFinalizeResult> {
  const log = input.deps.log ?? (() => undefined);
  const validated = validateArtifactClaim(input.claim, input.limits);
  if ("ok" in validated && !validated.ok) return validated;

  // 先用**实际字节**复核成片事实，再上传。
  if (!input.readArtifactBytes) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: "recording-artifact-unverified",
      message: "宿主未提供成片字节复核能力，拒绝上传未验证的成片"
    };
  }
  const bytes = await input.readArtifactBytes({
    path: input.claim.path,
    sizeBytes: input.claim.sizeBytes
  });
  const verification = verifyArtifactBytes(bytes, {
    ...(input.limits.expectedWidth !== undefined ? { width: input.limits.expectedWidth } : {}),
    ...(input.limits.expectedHeight !== undefined ? { height: input.limits.expectedHeight } : {}),
    ...(input.limits.expectedDurationSeconds !== undefined
      ? { durationSeconds: input.limits.expectedDurationSeconds }
      : {}),
    ...(input.limits.expectedFrameRate !== undefined ? { frameRate: input.limits.expectedFrameRate } : {}),
    contentSha256: input.claim.contentSha256
  });
  if (!verification.ok) {
    log({ event: "recording-artifact-rejected", code: verification.code, message: verification.message });
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_MUX",
      code: verification.code,
      message: verification.message
    };
  }

  const chunks = await input.deps.openArtifact({
    path: input.claim.path,
    sizeBytes: input.claim.sizeBytes
  });
  const uploaded = await input.deps.upload({
    chunks,
    contentType: input.claim.mimeType,
    sizeBytes: input.claim.sizeBytes,
    fileName: `${input.commitRequest.title || "片场动画"}.mp4`,
    canvasId: input.commitRequest.canvasId,
    signal: input.signal
  });
  if (!uploaded.ok) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_UPLOAD",
      code: uploaded.code,
      message: uploaded.message
    };
  }
  if (uploaded.artifact.size !== input.claim.sizeBytes) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_UPLOAD",
      code: "recording-upload-size-mismatch",
      message: "上传后的字节数与成片声明不一致"
    };
  }

  const plan = await input.deps.planCommit({
    ...input.commitRequest,
    sourcePosition: input.sourcePosition,
    artifact: {
      storageKey: uploaded.artifact.storageKey,
      checksum: uploaded.artifact.checksum,
      mimeType: uploaded.artifact.contentType,
      sizeBytes: uploaded.artifact.size,
      width: input.claim.width,
      height: input.claim.height,
      durationSeconds: input.claim.durationSeconds,
      frameRate: input.limits.expectedFrameRate ?? 30,
      hasAudio: false
    }
  });
  if (!plan.ok) {
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_COMMIT",
      code: plan.code,
      message: plan.message
    };
  }

  const submitted = await input.deps.submit({
    canvasId: input.commitRequest.canvasId,
    commandId: plan.commandId,
    commands: plan.commands
  });
  if (!submitted.ok) {
    log({ event: "recording-commit-rejected", code: submitted.code, message: submitted.message });
    return {
      ok: false,
      stage: "RECORDING_ERROR_STAGE_COMMIT",
      code: submitted.code,
      message: submitted.message
    };
  }
  return {
    ok: true,
    artifact: uploaded.artifact,
    commandId: plan.commandId,
    ...(plan.nodeId ? { nodeId: plan.nodeId } : {}),
    duplicate: submitted.duplicate
  };
}

/** 以固定块大小读取本地文件（有界内存；≥1 块，供流式上传）。 */
export async function* readFileChunks(
  path: string,
  sizeBytes: number,
  chunkBytes = 512 * 1024
): AsyncGenerator<Uint8Array> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(chunkBytes, sizeBytes - offset);
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
