/**
 * 本机录制执行器控制协议的 TS 投影
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.3 / design D2）。
 *
 * 唯一契约来源是本仓库的 `api/gen/es/woohaa/recording/v1alpha1/recording_pb.ts`（协议源码不在本仓库）；本文件只做
 * **protobuf JSON 表示**的解析与校验，不另立 schema、不重新生成绑定：
 * - 字段名 lowerCamelCase，枚举用 ProtoJSON 的 UPPER_SNAKE 符号；
 * - 64 位整数按 ProtoJSON 以字符串承载（同时容忍普通数字，便于测试与旧版对端）；
 * - `ControlMessage` 的 `oneof payload`：JSON 里必须恰好一个 payload 键；
 * - 版本不兼容、身份不完整、未知枚举、分块超限与乱序在**解析阶段**拒绝。
 *
 * Rust 侧 `bevy/src/recording_protocol.rs` 使用同一 JSON 契约；两边共享
 * `web/contracts/fixtures/recording-protocol/control-messages.json` 保证一致。
 * 纯函数、无副作用：可在浏览器、Node 与扩展中复用。
 */

/** 控制协议版本；与 proto 的 `RECORDING_PROTOCOL_VERSION_1_ALPHA_1` 一致。 */
export const RECORDING_PROTOCOL_VERSION = "RECORDING_PROTOCOL_VERSION_1_ALPHA_1";

/** 控制消息体上限：元数据帧不得超过 8 MiB。 */
export const MAX_CONTROL_MESSAGE_BYTES = 8 * 1024 * 1024;

/** 资源/成片分块上限：每块至多 1 MiB。 */
export const MAX_RESOURCE_CHUNK_BYTES = 1024 * 1024;

/** 快照 schema；worker 只接受自己编译版本生成的快照。 */
export const RECORDING_SNAPSHOT_SCHEMA_VERSION = "woohaa-recording-snapshot-v1";

/** 稳定错误码；与 Rust 的 `ERROR_*` 常量一致。 */
export const RECORDING_PROTOCOL_ERROR_CODES = {
  versionMismatch: "recording-protocol-version-mismatch",
  malformed: "recording-malformed-message",
  unknownPayload: "recording-unknown-payload",
  identityIncomplete: "recording-identity-incomplete",
  staleEpoch: "recording-stale-epoch",
  chunkTooLarge: "recording-chunk-too-large",
  unknownEnum: "recording-unknown-enum",
  sequenceOutOfOrder: "recording-sequence-out-of-order"
} as const;

export type RecordingProtocolErrorCode =
  (typeof RECORDING_PROTOCOL_ERROR_CODES)[keyof typeof RECORDING_PROTOCOL_ERROR_CODES];

/** 已声明的 payload 名称：未知名称在解析期拒绝，不能静默忽略新消息。 */
export const CONTROL_PAYLOAD_NAMES = [
  "capabilityRequest",
  "capabilityResponse",
  "submitJob",
  "submitJobResponse",
  "getJob",
  "listJobs",
  "jobList",
  "cancelJob",
  "cancelJobResponse",
  "pauseJob",
  "resumeJob",
  "jobControlResponse",
  "leaseHeartbeat",
  "leaseRenewal",
  "progress",
  "frameDiagnostic",
  "stateChanged",
  "artifactChunkRequest",
  "artifactChunk"
] as const;

export type ControlPayloadName = (typeof CONTROL_PAYLOAD_NAMES)[number];

/** 携带完整任务身份的 payload：缺身份不能归并状态。 */
const JOB_SCOPED_PAYLOADS: readonly ControlPayloadName[] = [
  "submitJobResponse",
  "getJob",
  "cancelJob",
  "cancelJobResponse",
  "pauseJob",
  "resumeJob",
  "jobControlResponse",
  "leaseHeartbeat",
  "leaseRenewal",
  "progress",
  "frameDiagnostic",
  "stateChanged"
];

export const RECORDING_JOB_STATES = [
  "RECORDING_JOB_STATE_UNSPECIFIED",
  "RECORDING_JOB_STATE_QUEUED",
  "RECORDING_JOB_STATE_PREPARING",
  "RECORDING_JOB_STATE_RENDERING",
  "RECORDING_JOB_STATE_PAUSED",
  "RECORDING_JOB_STATE_ENCODING",
  "RECORDING_JOB_STATE_UPLOADING",
  "RECORDING_JOB_STATE_COMMITTING",
  "RECORDING_JOB_STATE_SUCCEEDED",
  "RECORDING_JOB_STATE_CANCELLED",
  "RECORDING_JOB_STATE_FAILED",
  "RECORDING_JOB_STATE_STALE"
] as const;

export type RecordingJobState = (typeof RECORDING_JOB_STATES)[number];

export const RECORDING_TERMINAL_STATES: readonly RecordingJobState[] = [
  "RECORDING_JOB_STATE_SUCCEEDED",
  "RECORDING_JOB_STATE_CANCELLED",
  "RECORDING_JOB_STATE_FAILED",
  "RECORDING_JOB_STATE_STALE"
];

export const RECORDING_PURPOSES = [
  "RECORDING_PURPOSE_UNSPECIFIED",
  "RECORDING_PURPOSE_REFERENCE",
  "RECORDING_PURPOSE_EXPORT"
] as const;

export type RecordingPurpose = (typeof RECORDING_PURPOSES)[number];

export const RECORDING_PRIORITIES = [
  "RECORDING_PRIORITY_UNSPECIFIED",
  "RECORDING_PRIORITY_REFERENCE",
  "RECORDING_PRIORITY_EXPORT",
  "RECORDING_PRIORITY_INTERACTIVE"
] as const;

export type RecordingPriority = (typeof RECORDING_PRIORITIES)[number];

/** 失败阶段：区分真正的 readiness 超时与执行器不在、编码不支持。 */
export const RECORDING_ERROR_STAGES = [
  "RECORDING_ERROR_STAGE_UNSPECIFIED",
  "RECORDING_ERROR_STAGE_CAPABILITY",
  "RECORDING_ERROR_STAGE_COMPILE",
  "RECORDING_ERROR_STAGE_RESOURCE_FETCH",
  "RECORDING_ERROR_STAGE_DECODE",
  "RECORDING_ERROR_STAGE_FRAME_READY",
  "RECORDING_ERROR_STAGE_READBACK",
  "RECORDING_ERROR_STAGE_ENCODE",
  "RECORDING_ERROR_STAGE_MUX",
  "RECORDING_ERROR_STAGE_UPLOAD",
  "RECORDING_ERROR_STAGE_COMMIT",
  "RECORDING_ERROR_STAGE_EXECUTOR_LOST"
] as const;

export type RecordingErrorStage = (typeof RECORDING_ERROR_STAGES)[number];

/** 记录任务的完整身份；任一字段缺失都不能参与状态归并或提交。 */
export type RecordingJobIdentity = {
  jobId: string;
  attemptId: string;
  executorInstanceId: string;
  executionEpoch: number;
  snapshotHash: string;
  contentIdentity: string;
  profileKey: string;
};

/** 结构化失败（不含媒体字节或凭据）。 */
export type RecordingError = {
  stage: RecordingErrorStage | (string & {});
  code: string;
  message: string;
  frameIndex?: number;
  sampleTime?: number;
  subjectId?: string;
  transient: boolean;
};

/** 校验通过的 envelope：唯一 payload 名称 + 原始 JSON 值。 */
export type ParsedControlMessage = {
  protocolVersion: string;
  sequence: number;
  payloadName: ControlPayloadName;
  payload: Record<string, unknown>;
};

export type RecordingProtocolFailure = {
  ok: false;
  code: RecordingProtocolErrorCode;
  message: string;
};

export type RecordingProtocolResult = ({ ok: true } & ParsedControlMessage) | RecordingProtocolFailure;

function fail(code: RecordingProtocolErrorCode, message: string): RecordingProtocolFailure {
  return { ok: false, code, message };
}

/**
 * ProtoJSON 64 位整数：字符串或有限非负整数；其余（含负数、小数、NaN）都拒绝。
 *
 * 不用 `Number()` 直接吞掉超范围字符串：超过 `Number.MAX_SAFE_INTEGER` 的值在 JS 侧
 * 无法精确表达，按 ProtoJSON 约定保留字符串形态时也只接受安全整数。
 */
export function parseProtoUint64(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** 读取任务身份；缺失或非法返回 `null`（调用方据此给出 identity-incomplete）。 */
export function readJobIdentity(value: unknown): RecordingJobIdentity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const epoch = parseProtoUint64(raw.executionEpoch);
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const identity: RecordingJobIdentity = {
    jobId: text("jobId"),
    attemptId: text("attemptId"),
    executorInstanceId: text("executorInstanceId"),
    executionEpoch: epoch ?? -1,
    snapshotHash: text("snapshotHash"),
    contentIdentity: text("contentIdentity"),
    profileKey: text("profileKey")
  };
  return identity.executionEpoch < 0 ? null : identity;
}

/** 身份是否完整（7 个字段全部非空；epoch 可为 0）。 */
export function isCompleteJobIdentity(identity: RecordingJobIdentity | null): identity is RecordingJobIdentity {
  return (
    identity !== null &&
    identity.jobId !== "" &&
    identity.attemptId !== "" &&
    identity.executorInstanceId !== "" &&
    identity.snapshotHash !== "" &&
    identity.contentIdentity !== "" &&
    identity.profileKey !== ""
  );
}

/** 同一 jobId 但 attempt/executor/epoch 不同 → 旧结果是迟到结果。 */
export function identitySupersedes(current: RecordingJobIdentity, incoming: RecordingJobIdentity): boolean {
  if (current.jobId !== incoming.jobId) return false;
  return (
    current.attemptId !== incoming.attemptId ||
    current.executorInstanceId !== incoming.executorInstanceId ||
    current.executionEpoch !== incoming.executionEpoch
  );
}

/** 只接受与当前尝试完全一致的结果。 */
export function acceptsResult(current: RecordingJobIdentity, incoming: RecordingJobIdentity): boolean {
  return (
    current.jobId === incoming.jobId &&
    current.attemptId === incoming.attemptId &&
    current.executorInstanceId === incoming.executorInstanceId &&
    current.executionEpoch === incoming.executionEpoch &&
    current.snapshotHash === incoming.snapshotHash &&
    current.contentIdentity === incoming.contentIdentity &&
    current.profileKey === incoming.profileKey
  );
}

/**
 * 解析并校验一条控制消息（JSON 字符串）。
 *
 * 校验顺序：体量 → JSON → 协议版本 → payload 唯一性/已知性 → 任务身份 → 枚举。
 * 通过后调用方再用 payload 自己的强类型读取器取值。
 */
export function parseControlMessage(json: string): RecordingProtocolResult {
  if (json.length > MAX_CONTROL_MESSAGE_BYTES) {
    return fail(
      RECORDING_PROTOCOL_ERROR_CODES.malformed,
      `控制消息超过 ${MAX_CONTROL_MESSAGE_BYTES} 字节上限`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return fail(RECORDING_PROTOCOL_ERROR_CODES.malformed, error instanceof Error ? error.message : "消息不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(RECORDING_PROTOCOL_ERROR_CODES.malformed, "控制消息必须是 JSON 对象");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.protocolVersion !== RECORDING_PROTOCOL_VERSION) {
    const received = typeof envelope.protocolVersion === "string" ? envelope.protocolVersion : "<空>";
    return fail(
      RECORDING_PROTOCOL_ERROR_CODES.versionMismatch,
      `协议版本不兼容：期望 ${RECORDING_PROTOCOL_VERSION}，收到 ${received}`
    );
  }
  const sequence = parseProtoUint64(envelope.sequence);
  if (sequence === null) {
    return fail(RECORDING_PROTOCOL_ERROR_CODES.malformed, "控制消息缺少合法 sequence");
  }
  const payloadKeys = CONTROL_PAYLOAD_NAMES.filter((name) => name in envelope);
  const unknownKeys = Object.keys(envelope).filter(
    (key) =>
      key !== "protocolVersion" &&
      key !== "sequence" &&
      !(CONTROL_PAYLOAD_NAMES as readonly string[]).includes(key)
  );
  if (payloadKeys.length !== 1 || unknownKeys.length > 0) {
    return fail(
      RECORDING_PROTOCOL_ERROR_CODES.unknownPayload,
      `控制消息必须恰好包含一个已知 payload，收到 ${payloadKeys.length} 个已知、${unknownKeys.length} 个未知`
    );
  }
  const payloadName = payloadKeys[0]!;
  const payload = envelope[payloadName];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fail(RECORDING_PROTOCOL_ERROR_CODES.malformed, `payload ${payloadName} 必须是对象`);
  }
  const body = payload as Record<string, unknown>;
  if (JOB_SCOPED_PAYLOADS.includes(payloadName) && !(
    (payloadName === "leaseHeartbeat" || payloadName === "leaseRenewal") &&
    !body.job && typeof body.executorInstanceId === "string" && body.executorInstanceId.length > 0
  )) {
    const identity = readJobIdentity(body.job);
    if (!isCompleteJobIdentity(identity)) {
      return fail(
        RECORDING_PROTOCOL_ERROR_CODES.identityIncomplete,
        `${payloadName} 缺少完整任务身份（jobId/attemptId/executorInstanceId/snapshotHash/contentIdentity/profileKey）`
      );
    }
  }
  const stateError = body.error;
  if (stateError && typeof stateError === "object") {
    const stage = (stateError as Record<string, unknown>).stage;
    if (typeof stage === "string" && stage !== "" && !(RECORDING_ERROR_STAGES as readonly string[]).includes(stage)) {
      return fail(RECORDING_PROTOCOL_ERROR_CODES.unknownEnum, `未知失败阶段枚举：${stage}`);
    }
  }
  return { ok: true, protocolVersion: RECORDING_PROTOCOL_VERSION, sequence, payloadName, payload: body };
}

/**
 * 同一 (jobId, attemptId) 的 sequence 必须严格递增；乱序/重复消息被丢弃而不是覆盖状态。
 *
 * 终态不可复活由状态机另行保证，本游标只解决重复与乱序。
 */
export class RecordingSequenceGuard {
  private readonly last = new Map<string, number>();

  accept(identity: Pick<RecordingJobIdentity, "jobId" | "attemptId">, sequence: number): boolean {
    const key = `${identity.jobId}\u0000${identity.attemptId}`;
    const previous = this.last.get(key);
    if (previous !== undefined && sequence <= previous) return false;
    this.last.set(key, sequence);
    return true;
  }

  lastSequence(identity: Pick<RecordingJobIdentity, "jobId" | "attemptId">): number | undefined {
    return this.last.get(`${identity.jobId}\u0000${identity.attemptId}`);
  }
}

/** 分块偏移与大小校验：超限或乱序都在写入前拒绝。 */
export function validateResourceChunk(
  offset: number,
  byteLength: number,
  expectedOffset: number
): { ok: true } | RecordingProtocolFailure {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    return fail(RECORDING_PROTOCOL_ERROR_CODES.malformed, "分块长度非法");
  }
  if (byteLength > MAX_RESOURCE_CHUNK_BYTES) {
    return fail(
      RECORDING_PROTOCOL_ERROR_CODES.chunkTooLarge,
      `分块 ${byteLength} 字节超过 ${MAX_RESOURCE_CHUNK_BYTES} 字节上限`
    );
  }
  if (offset !== expectedOffset) {
    return fail(
      RECORDING_PROTOCOL_ERROR_CODES.sequenceOutOfOrder,
      `分块偏移乱序：期望 ${expectedOffset}，收到 ${offset}`
    );
  }
  return { ok: true };
}
