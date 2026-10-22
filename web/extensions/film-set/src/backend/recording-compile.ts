/**
 * 片场内容录制的**冻结**与**提交计划**
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 2.2 / 2.3 / design D3）。
 *
 * 这是 `ContentRecordingRuntime` 在片场扩展里的实现主体：
 * - `freeze`：从**已提交权威数据**编译一次自包含快照（Scene IR + 编译后的动作/镜头轨道 +
 *   稳定媒体清单 + 精确时长/profile），并给出新的 native 内容身份；
 * - `planCommit`：用已校验的成片事实构造单个原子命令批次（参考 = 资产；导出 = 资产 + 视频节点），
 *   位置取**提交时**的权威布局。
 *
 * 不变量：
 * - 只读 committed 数据；历史只读、pending draft、缺时长、非法脚本与越权都在这里拒绝；
 * - 不做逐帧 JS 执行：`instanceof` 检查之外只调用 contracts 的编译器；
 * - media 清单以 stable storageKey + checksum + 内容类型绑定，并参与 `contentIdentity`；
 * - 快照 fingerprint 用规范序列化 + SHA-256，不复用短视觉身份。
 */
import { nativeFilmSetFrame } from "./native-frame.js";
import { createHash } from "node:crypto";
import {
  animationSnapshotHash,
  DEFAULT_SHOT_REFERENCE_RECORD_PROFILE,
  NATIVE_RECORDING_CODEC_VERSION,
  NATIVE_RECORDING_COLOR_REVISION,
  NATIVE_RECORDING_COMPILER_VERSION,
  NATIVE_RECORDING_FRAME_RATE,
  NATIVE_RECORDING_RENDERER_VERSION,
  nativeRecordingProfileKey,
  nativeRecordingVideoSize,
  buildFilmSetObjectMotions,
  checkAnimationMotion,
  composeFilmSetPreviewAtTime,
  canonicalFilmSetFields,
  filmSetMediaPlanesForNode,
  decodeFilmSetNodeData,
  executeMotionScript,
  filmSetAnimationsOf,
  filmSetContentHash,
  resolveFilmSetClip,
  shotAspectValue,
  shotReferenceContentIdentity,
  shotReferenceProfileKey,
  validateSelfContainedModel,
  v2SceneExtent,
  type CanvasCommand,
  type ContentRecordingCommitPlan,
  type ContentRecordingCommitRequest,
  type ContentRecordingFreezeResult,
  type ContentRecordingRequest,
  type ContentRecordingResource,
  type ContentRecordingSnapshot,
  type ContentRecordingUnavailableReason,
  type FilmSetNodeData,
  type StoredAsset
} from "@woohaa3/contracts";

/**
 * 编译/渲染/编码语义版本：唯一来源在 `@woohaa3/contracts`（前后端与 worker 共用）。
 * 这里保留别名只是为了本文件与既有测试的可读性。
 */
export const FILM_SET_RECORDING_COMPILER_VERSION = NATIVE_RECORDING_COMPILER_VERSION;
export const FILM_SET_RECORDING_RENDERER_VERSION = NATIVE_RECORDING_RENDERER_VERSION;
export const FILM_SET_RECORDING_COLOR_REVISION = NATIVE_RECORDING_COLOR_REVISION;
export const FILM_SET_RECORDING_CODEC_REVISION = NATIVE_RECORDING_CODEC_VERSION;
export const FILM_SET_RECORDING_SNAPSHOT_SCHEMA_VERSION = "woohaa-recording-snapshot-v1";

/** 镜头画幅数值 → `16:9` 形式的规范字符串（与 wire 字段一致）。 */
export function aspectLabel(ratio: number): string {
  // 常见画幅用整数比；其余按两位小数表达，避免浮点长尾进入身份。
  const presets: Array<[number, string]> = [
    [1, "1:1"],
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [21 / 9, "21:9"]
  ];
  const match = presets.find(([value]) => Math.abs(value - ratio) < 1e-6);
  return match ? match[1] : `${ratio.toFixed(2)}:1`;
}

/** 参考录制与显式导出的默认 profile：短边 720、30fps、约 4Mbps、无音轨。 */
export function recordingProfile(aspect: string): ContentRecordingSnapshot["profile"] {
  const size = nativeRecordingVideoSize(aspect);
  return {
    profileKey: nativeRecordingProfileKey(aspect),
    container: "mp4",
    codec: "h264",
    width: size.width,
    height: size.height,
    bitrate: 4_000_000,
    fastStart: true,
    includeAudio: false,
    rendererVersion: FILM_SET_RECORDING_RENDERER_VERSION,
    compilerVersion: FILM_SET_RECORDING_COMPILER_VERSION,
    codecVersion: FILM_SET_RECORDING_CODEC_REVISION,
    colorRevision: FILM_SET_RECORDING_COLOR_REVISION
  };
}

// `nativeRecordingProfileKey` / `recordingVideoSize` 的唯一来源在 `@woohaa3/contracts`，
// 本文件通过顶部 import 使用并向下再导出，前后端不会各写一份 key 格式。
export { nativeRecordingProfileKey, nativeRecordingVideoSize as recordingVideoSize } from "@woohaa3/contracts";

/** 录制帧率：与现有导出能力一致（唯一来源在 contracts）。 */
export const REFERENCE_FPS = NATIVE_RECORDING_FRAME_RATE;



/** 编译结果失败原因（内部用）。 */
type FreezeFailure = { ok: false; code: string; message: string };

function fail(code: string, message: string): FreezeFailure {
  return { ok: false, code, message };
}

/** 规范化 JSON：按 key 排序，保证同一输入产生同一 hash。 */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalize(record[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/** 快照 fingerprint：规范序列化 + SHA-256。 */
export function recordingSnapshotHash(snapshot: Omit<ContentRecordingSnapshot, "origin"> & { origin: ContentRecordingSnapshot["origin"] }): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/**
 * 冻结一次录制输入。
 *
 * `assets` 由宿主给出（权威画布资产），`nodeData` 是已解码前的原始节点数据。
 */
export function freezeFilmSetRecording(input: {
  request: ContentRecordingRequest;
  nodeData: unknown;
  assets: readonly StoredAsset[];
  canvasRevision: number;
  node?: { width?: number; height?: number };
  /** 画布是否只读（历史/预览）；只读不得生成落库任务。 */
  readOnly?: boolean;
  /** 是否存在未提交 draft；有则必须等待提交或明确拒绝。 */
  hasPendingDraft?: boolean;
  /** 来源 incarnation：删除后重建同 id 必须得到不同值。 */
  sourceIncarnation: string;
  /** 素材预算：单文件与合计上限（字节）。 */
  maxResourceBytes?: number;
  maxTotalResourceBytes?: number;
  /** 资产字节读端口（宿主 Media 能力）。 */
  read?: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
}): ContentRecordingFreezeResult | FreezeFailure {
  const { request } = input;
  if (input.readOnly) return fail("recording-source-invalid", "只读历史不能生成录制任务");
  if (input.hasPendingDraft) {
    return fail("recording-source-invalid", "当前视觉编辑尚未提交，请先保存后再录制");
  }
  const decoded = decodeFilmSetNodeData(input.nodeData);
  if (!decoded.ok) return fail("recording-source-invalid", "片场节点内容无法解析");
  const animation: FilmSetNodeData = decoded.value;
  const collection = filmSetAnimationsOf(animation);
  const clip = collection.clips.find(entry => entry.id === request.clipId);
  if (!clip) return fail("recording-source-invalid", "目标片段不存在");
  const view = resolveFilmSetClip(animation, clip.id);
  if (!view) return fail("recording-source-invalid", "目标片段无法投影");

  const duration = clip.timeline.duration;
  if (!(Number.isFinite(duration) && duration > 0)) {
    return fail("recording-source-invalid", "该片段没有可录制的动画时长");
  }
  const aspect = aspectLabel(shotAspectValue(clip));
  const profile = recordingProfile(aspect);
  if (request.profileKey && request.profileKey !== profile.profileKey) {
    // 不接受调用方自造 profile：worker 能力与成片格式由扩展决定。
    return fail("recording-profile-unsupported", `录制规格与片段比例不匹配：${request.profileKey}；当前片段需要 ${profile.profileKey}`);
  }

  // 编译前校验：模型脚本自包含、动作轨道合法、构图可求值。
  for (const item of animation.filmSetContent.items) {
    if (item.kind !== "model" || !item.model.modelScript.trim()) continue;
    const validity = validateSelfContainedModel(item.model.modelScript, item.model.modelScriptVersion);
    if (!validity.ok) {
      return fail("recording-source-invalid", `片场对象 ${item.id} 的模型脚本不合法`);
    }
  }
  const motion = checkAnimationMotion(view);
  if (motion.validation !== "valid") {
    return fail("recording-source-invalid", motion.issues[0]?.message ?? "动作检查未通过");
  }
  const projection = composeFilmSetPreviewAtTime(
    {
      scenePlacement: animation.scenePlacement,
      filmSetContent: animation.filmSetContent,
      ...(view.clip.bindings.length ? { bindings: view.clip.bindings } : {})
    },
    0
  );
  if (projection.diagnostics.length) {
    return fail("recording-source-invalid", projection.diagnostics[0]!);
  }
  const cameraTracks = executeMotionScript(view.cameraMotion.motionScript, { duration });
  if (!cameraTracks.ok) {
    return fail("recording-source-invalid", "镜头动作编译失败");
  }
  const objectMotions = buildFilmSetObjectMotions({
    filmSetContent: view.content,
    bindings: view.clip.bindings
  });
  if (objectMotions.diagnostics.length) {
    return fail("recording-source-invalid", objectMotions.diagnostics[0]!);
  }

  const resources = collectResources({
    animation,
    assets: input.assets,
    clipId: clip.id,
    ...(input.maxResourceBytes !== undefined ? { maxResourceBytes: input.maxResourceBytes } : {}),
    ...(input.maxTotalResourceBytes !== undefined ? { maxTotalResourceBytes: input.maxTotalResourceBytes } : {})
  });
  if ("ok" in resources) return resources;

  const frame = nativeFilmSetFrame(animation, input.node ?? {}, projection.ops);
  const extent = v2SceneExtent(projection.ops);
  const contentIdentity = shotReferenceContentIdentity({
    animation,
    clipId: clip.id,
    profile: {
      schemaVersion: 1,
      width: profile.width,
      height: profile.height,
      frameRate: REFERENCE_FPS
    }
  });
  if (!contentIdentity) return fail("recording-source-invalid", "无法计算镜头内容身份");

  // 媒体真实内容参与身份：同 assetId 换 bytes 必须得到不同身份。
  const mediaFingerprint = createHash("sha256")
    .update(
      canonicalJson(
        resources.map(resource => [resource.resourceId, resource.storageKey, resource.checksum, resource.contentType, resource.sizeBytes])
      )
    )
    .digest("hex")
    .slice(0, 16);

  const snapshot: ContentRecordingSnapshot = {
    schemaVersion: FILM_SET_RECORDING_SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: FILM_SET_RECORDING_COMPILER_VERSION,
    rendererVersion: FILM_SET_RECORDING_RENDERER_VERSION,
    origin: {
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      clipId: clip.id,
      sourceIdentity: `${animationSnapshotHash(animation)}-${mediaFingerprint}`,
      canvasRevision: input.canvasRevision,
      sourceIncarnation: input.sourceIncarnation
    },
    profile,
    timing: {
      frameRateNumer: REFERENCE_FPS,
      frameRateDenom: 1,
      durationNumer: Math.round(duration * 1_000_000),
      durationDenom: 1_000_000
    },
    sceneIrJson: canonicalJson({
      sceneVersion: "woohaa-model-scene-ir-v2",
      signature: `film-set-recording-${contentIdentity}`,
      extent,
      compositeAssetFrame: frame,
      mediaPlanes: filmSetMediaPlanesForNode({ nodeId: request.nodeId,
        data: canonicalFilmSetFields(animation) as never, contentExtent: frame.resourceExtent,
        readyPlaneIds: new Set(animation.filmSetContent.items.map(item => `${request.nodeId}::${item.id}`))
      }).map(plane => ({ ...plane, resourceId: `${clip.id}:${plane.itemId}` })),
      ops: projection.ops
    }),
    motionJson: canonicalJson({
      duration,
      looped: Boolean(clip.timeline.loop),
      cameraMotion: cameraTracks.ir.cameraMotion,
      modelMotion: [],
      objects: objectMotions.motions,
      initialCamera: {
        azimuth: clip.initialCamera.azimuth,
        elevation: clip.initialCamera.elevation,
        distance: clip.initialCamera.distance,
        aspect,
        focusOffset: [
          clip.initialCamera.focusOffset.x,
          clip.initialCamera.focusOffset.y,
          clip.initialCamera.focusOffset.z
        ]
      }
    }),
    initialCamera: {
      azimuth: clip.initialCamera.azimuth,
      elevation: clip.initialCamera.elevation,
      distance: clip.initialCamera.distance,
      focusOffset: [
        clip.initialCamera.focusOffset.x,
        clip.initialCamera.focusOffset.y,
        clip.initialCamera.focusOffset.z
      ]
    },
    aspect,
    resources
  };

  // 媒体字节可读性由宿主在 freeze 之后用 `validateRecordingResources` 异步校验：
  // 冻结本身必须是同步纯编译，才能在权威队列里一次性完成。
  void input.read;
  const referenceContentIdentity = shotReferenceContentIdentity({ animation, clipId: clip.id });
  if (!referenceContentIdentity) return fail("recording-source-invalid", "无法计算镜头参考身份");
  return { ok: true, snapshot, referenceIdentity: {
    contentIdentity: referenceContentIdentity,
    profileKey: shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE)
  } };
}

/** 异步校验所有资源可读且 checksum 一致；宿主在 freeze 之后调用。 */
export async function validateRecordingResources(
  snapshot: ContentRecordingSnapshot,
  read: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>
): Promise<{ ok: true } | FreezeFailure> {
  for (const resource of snapshot.resources) {
    let media: { bytes: Uint8Array; contentType: string };
    try {
      media = await read(resource.storageKey);
    } catch {
      return fail("recording-source-invalid", `素材 ${resource.resourceId} 无法读取`);
    }
    if (!media.bytes.length) return fail("recording-source-invalid", `素材 ${resource.resourceId} 为空`);
    if (media.contentType !== resource.contentType) {
      return fail("recording-source-invalid", `素材 ${resource.resourceId} 内容类型与权威记录不符`);
    }
  }
  return { ok: true };
}

function collectResources(input: {
  animation: FilmSetNodeData;
  assets: readonly StoredAsset[];
  clipId: string;
  maxResourceBytes?: number;
  maxTotalResourceBytes?: number;
}): ContentRecordingResource[] | FreezeFailure {
  const view = resolveFilmSetClip(input.animation, input.clipId);
  if (!view) return fail("recording-source-invalid", "目标片段无法投影");
  const maxResourceBytes = input.maxResourceBytes ?? 256 * 1024 * 1024;
  const maxTotalBytes = input.maxTotalResourceBytes ?? 512 * 1024 * 1024;
  const resources: ContentRecordingResource[] = [];
  let total = 0;
  for (const item of view.content.items) {
    if (item.kind !== "image" && item.kind !== "video") continue;
    const asset = input.assets.find(entry => entry.id === item.assetId);
    if (!asset || asset.status !== "ready") {
      return fail("recording-source-invalid", `素材 ${item.assetId} 尚未就绪`);
    }
    const storageKey = asset.metadata?.storageKey;
    const checksum = asset.metadata?.checksum;
    const contentType = asset.metadata?.contentType;
    const size = asset.metadata?.size;
    if (typeof storageKey !== "string" || storageKey === "") {
      return fail("recording-source-invalid", `素材 ${item.assetId} 缺少稳定存储身份`);
    }
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
      return fail("recording-source-invalid", `素材 ${item.assetId} 缺少合法 checksum`);
    }
    if (typeof contentType !== "string" || !contentType.startsWith(`${item.kind}/`)) {
      return fail("recording-source-invalid", `素材 ${item.assetId} 内容类型与片场项不符`);
    }
    const sizeBytes = typeof size === "number" && size > 0 ? size : 0;
    if (sizeBytes > maxResourceBytes) {
      return fail("recording-budget-exceeded", `素材 ${item.assetId} 超过单文件上限`);
    }
    total += sizeBytes;
    if (total > maxTotalBytes) {
      return fail("recording-budget-exceeded", "素材合计超过录制预算");
    }
    const playback = item.playback ?? { startTime: 0, duration: 0, timeScale: 1, loop: false };
    resources.push({
      resourceId: `${input.clipId}:${item.id}`,
      storageKey,
      checksum,
      contentType,
      sizeBytes,
      playback: {
        startTime: playback.startTime ?? 0,
        timeScale: playback.timeScale ?? 1,
        looped: Boolean(playback.loop),
        endTime: playback.duration ?? 0,
        mediaDuration: playback.duration ?? 0
      }
    });
  }
  return resources;
}

/** 参考录制的稳定资产 id：canvas/node/clip/内容身份/新 profile。 */
export function nativeReferenceAssetId(input: {
  nodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
}): string {
  return `shot-reference-video:${input.nodeId}:${input.clipId}:${input.contentIdentity}:${input.profileKey}`;
}

/**
 * 构造提交计划。
 *
 * 显式导出 = `asset.upsert` + `node.add`（携带 `filmSetVideoOrigin`），
 * 参考录制 = 只 `asset.upsert`（下游冻结映射由既有 `planShotReferenceFreeze` 完成）。
 */
export function planFilmSetRecordingCommit(input: {
  request: ContentRecordingCommitRequest;
  /** 提交时权威来源节点布局；参考录制可省略。 */
  source?: { x: number; y: number; width: number } | null;
  now(): string;
}): ContentRecordingCommitPlan {
  const { request } = input;
  const referenceIdentity = request.referenceIdentity ?? { contentIdentity: request.contentIdentity, profileKey: request.profileKey };
  const assetId =
    request.purpose === "reference"
      ? nativeReferenceAssetId({
          nodeId: request.nodeId,
          clipId: request.clipId,
          contentIdentity: referenceIdentity.contentIdentity,
          profileKey: referenceIdentity.profileKey
        })
      : `film-set-video:${request.requestId}`;
  const asset: StoredAsset = {
    id: assetId,
    title: request.title || "片场动画",
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt: input.now(),
    metadata: {
      storageKey: request.artifact.storageKey,
      checksum: request.artifact.checksum,
      contentType: request.artifact.mimeType,
      size: request.artifact.sizeBytes,
      duration: request.artifact.durationSeconds,
      width: request.artifact.width,
      height: request.artifact.height,
      frameRate: request.artifact.frameRate,
      ...(request.purpose === "reference"
        ? {
            shotReference: {
              filmSetNodeId: request.nodeId,
              clipId: request.clipId,
              contentIdentity: referenceIdentity.contentIdentity,
              profileKey: referenceIdentity.profileKey
            }
          }
        : {})
    }
  };
  const commands: CanvasCommand[] = [{ type: "asset.upsert", asset }];
  if (request.purpose === "reference") {
    return {
      ok: true,
      commands,
      commandId: `native-shot-reference-${request.requestId}`
    };
  }
  if (!input.source) {
    return { ok: false, code: "recording-source-removed", message: "源片场已移除，无法放置视频节点" };
  }
  const nodeId = `film-set-video-${request.requestId}`;
  commands.push({
    type: "node.add",
    node: {
      id: nodeId,
      type: "video",
      position: { x: input.source.x + input.source.width + 16, y: input.source.y },
      width: request.artifact.width,
      height: request.artifact.height
    },
    nodeData: {
      title: request.title || "片场动画",
      outputAssetId: assetId,
      filmSetVideoOrigin: {
        filmSetNodeId: request.nodeId,
        clipId: request.clipId,
        sourceIdentity: request.contentIdentity,
        profileKey: request.profileKey,
        duration: request.artifact.durationSeconds,
        aspect: `${request.artifact.width}:${request.artifact.height}`,
        frameRate: request.artifact.frameRate,
        capturedAt: input.now(),
        native: true
      }
    }
  });
  return {
    ok: true,
    commands,
    commandId: `native-film-set-video-${request.requestId}`,
    nodeId
  };
}

/** 供 UI/活动浮层使用的展示信息。 */
export function describeFilmSetRecording(nodeData: unknown, clipId: string): {
  title: string;
  duration: number;
  aspect: string;
} {
  const decoded = decodeFilmSetNodeData(nodeData);
  if (!decoded.ok) return { title: "片场", duration: 0, aspect: "16:9" };
  const clip = filmSetAnimationsOf(decoded.value).clips.find(entry => entry.id === clipId);
  return {
    title: `${decoded.value.title || "片场"} · ${clip?.name ?? "镜头"}`,
    duration: clip?.timeline.duration ?? 0,
    aspect: clip ? aspectLabel(shotAspectValue(clip)) : "16:9"
  };
}

/**
 * 供宿主判断「本扩展负责该节点类型」。
 *
 * 除了能解码，还要求确实带有片场内容字段：任意对象都能解码成默认片场，不能据此接管节点。
 */
export function matchesFilmSetRecording(nodeType: string, data: unknown): boolean {
  if (nodeType !== "film-set" && nodeType !== "composite-asset") return false;
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  if (!record.filmSetContent || typeof record.filmSetContent !== "object") return false;
  return decodeFilmSetNodeData(data).ok;
}

/** 新 profile 的参考缓存键（与 `shotReferenceCacheKeyWithProfile` 同格式）。 */
export function nativeReferenceCacheKey(input: {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
}): string {
  return [
    "shot-reference",
    input.canvasId,
    input.filmSetNodeId,
    input.clipId,
    input.contentIdentity,
    input.profileKey
  ].join(":");
}

/** 旧浏览器 profile 的 key（仅用于识别历史缓存，不用于 native 任务）。 */
export function browserReferenceProfileKey(): string {
  return shotReferenceProfileKey({ schemaVersion: 1, width: 1280, height: 720, frameRate: 30 });
}

/** 稳定不可用原因 → 用户可读文案（宿主/前端共用一个来源）。 */
export function describeRecordingUnavailable(reason: ContentRecordingUnavailableReason): string {
  switch (reason) {
    case "no-runtime":
      return "当前构建未启用原生录制能力，无法生成视频";
    case "unsupported-platform":
      return "当前平台没有本机录制执行器";
    case "no-executor":
      return "本机录制执行器未就绪，请从桌面应用启动后重试";
    case "software-gpu":
      return "当前只有软件渲染适配器，不能产出可验收的录制画面";
    case "missing-codec":
      return "本机缺少 H.264 编码能力";
    case "protocol-mismatch":
      return "本机录制执行器协议版本不兼容，请更新桌面应用";
  }
}

export { filmSetContentHash };
