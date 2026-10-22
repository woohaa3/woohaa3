/**
 * 动态镜头参考关系的中立协议原语
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.1 / design D9）。
 *
 * 「镜头参考」是**可删除、可重连的持久化语义引用**：从动态拍摄镜头预览节点的输出端连到
 * 普通视频生成节点。它与 D5 的**派生归属线**不同——归属线不进 `document.edges`，没有端口与
 * 删除按钮；镜头参考是真实边 + `inputMapping.role = "shot_reference"`，因此可以删除、重连。
 *
 * 叶子模块：只读 plain 对象形状，不 import 任何业务解码器，供 `domain` 连接规则、规范化、
 * 角色推断与上层协议共用**同一份**判据，避免 `domain` → 业务模块的循环依赖。
 *
 * 版本语义：引用本身只保存「来源预览节点」这一稳定引用（预览节点承载片场 + clipId 归属），
 * **不**在 mapping/edge 上保存 outputAssetId、纹理句柄或临时 URL。实际视频资产由片场按
 * 「视觉内容身份 + 录制 profile」缓存，并在下游执行准备阶段冻结版本后解析（见任务 8.3–8.7）。
 */

/** 镜头参考映射角色（目标节点的 `inputMapping[].role`）。 */
export const SHOT_REFERENCE_ROLE = "shot_reference" as const;

/**
 * Provider 侧角色：镜头参考以**视频参考**身份参与模型绑定校验、生成模式校验与任务输入。
 *
 * 模型的参考输入 bindings 只声明 provider 语义（`reference_video`），不会出现画布内部的
 * `shot_reference`；前沿与 Canvas Service 必须用同一映射，否则会出现「面板说可用、服务端
 * 已接受」或反过来的误报。
 */
export const SHOT_REFERENCE_PROVIDER_ROLE = "reference_video" as const;

/** 把画布输入角色映射为 provider 绑定角色（镜头参考 → `reference_video`）。 */
export function providerReferenceRole(role: string): string {
  return role === SHOT_REFERENCE_ROLE ? SHOT_REFERENCE_PROVIDER_ROLE : role;
}

/** 镜头参考边的 `data.kind`，与普通 `dependency` 边区分。 */
export const SHOT_REFERENCE_EDGE_KIND = "shot-reference" as const;

/**
 * 镜头参考持久化结构版本（能力门禁）。
 *
 * 新增的预览→视频持久化边旧客户端会当作非法预览端点清理，因此除同步协议握手外，边数据本身也
 * 携带版本：本客户端只接受自己理解的结构，遇到更高版本明确拒绝而非猜测。
 */
export const SHOT_REFERENCE_SCHEMA_VERSION = 1 as const;

/** 边数据是否为**本客户端支持**的镜头参考结构（kind + version 都匹配）。 */
export function isSupportedShotReferenceEdgeData(
  data: Record<string, unknown> | undefined
): boolean {
  if (!data || !isShotReferenceEdgeKind(data.kind)) return false;
  const version = data.schemaVersion;
  // 缺失版本按 v1 处理（兼容本 change 早期写入的 `{ kind }` 边），更高版本明确拒绝。
  if (version === undefined || version === null) return true;
  return version === SHOT_REFERENCE_SCHEMA_VERSION;
}

export type ShotReferenceRole = typeof SHOT_REFERENCE_ROLE;
export type ShotReferenceEdgeKind = typeof SHOT_REFERENCE_EDGE_KIND;

export function isShotReferenceRole(value: unknown): value is ShotReferenceRole {
  return value === SHOT_REFERENCE_ROLE;
}

export function isShotReferenceEdgeKind(value: unknown): value is ShotReferenceEdgeKind {
  return value === SHOT_REFERENCE_EDGE_KIND;
}

/**
 * 镜头参考来源/目标的形状读取（不做严格业务解码）。
 *
 * 只提取判据所需的最小字段；非法/缺失一律返回 `null`，由调用方拒绝，不猜测。
 */
export type ShotReferenceSourceShape = {
  previewNodeId: string;
  filmSetNodeId: string;
  clipId: string;
  /** 只接受 dynamic；静态镜头不猜视频时长（design D9）。 */
  kind: "static" | "dynamic";
};

function readOwnership(nodeData: Record<string, unknown> | undefined): { filmSetNodeId: string; clipId: string } | null {
  const ownership = nodeData?.shotPreview;
  if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) return null;
  const record = ownership as Record<string, unknown>;
  const filmSetNodeId = record.filmSetNodeId;
  const clipId = record.clipId;
  if (typeof filmSetNodeId !== "string" || !filmSetNodeId) return null;
  if (typeof clipId !== "string" || !clipId) return null;
  return { filmSetNodeId, clipId };
}

function readClipKind(filmSetData: Record<string, unknown> | undefined, clipId: string): "static" | "dynamic" | null {
  const animations = filmSetData?.filmSetAnimations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations)) return null;
  const clips = (animations as Record<string, unknown>).clips;
  if (!Array.isArray(clips)) return null;
  for (const clip of clips) {
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) continue;
    const record = clip as Record<string, unknown>;
    if (record.id !== clipId) continue;
    return record.kind === "dynamic" ? "dynamic" : record.kind === "static" ? "static" : null;
  }
  return null;
}

/**
 * 解析预览节点为镜头参考来源；非预览、归属非法、源片场缺失或 clip 不存在时返回 `null`。
 *
 * `readNodeData` 由调用方注入（reducer 用工作副本、前端用画布 nodeData）。
 */
export function resolveShotReferenceSource(
  previewNodeId: string,
  previewNodeData: Record<string, unknown> | undefined,
  readNodeData: (nodeId: string) => Record<string, unknown> | undefined
): ShotReferenceSourceShape | null {
  const ownership = readOwnership(previewNodeData);
  if (!ownership) return null;
  const kind = readClipKind(readNodeData(ownership.filmSetNodeId), ownership.clipId);
  if (!kind) return null;
  return {
    previewNodeId,
    filmSetNodeId: ownership.filmSetNodeId,
    clipId: ownership.clipId,
    kind
  };
}

/** 目标是否为可接受镜头参考的视频生成节点（按 canonical type / taskKind 判定）。 */
export function isShotReferenceTargetNode(type: string | undefined, nodeData: Record<string, unknown> | undefined): boolean {
  if (type === "video") return true;
  const taskKind = nodeData?.taskKind;
  if (typeof taskKind === "string" && taskKind.includes("video")) return true;
  const parameters = nodeData?.parameters;
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    const generationMode = (parameters as Record<string, unknown>).generationMode;
    if (typeof generationMode === "string" && generationMode.includes("video")) return true;
  }
  return false;
}

export type ShotReferenceDecision = { ok: true; source: ShotReferenceSourceShape } | { ok: false; reason: string };

/**
 * 判定「动态镜头预览 → 视频生成节点」的镜头参考连接（任务 8.1）。
 *
 * 明确拒绝：
 * - 预览作为**目标**（预览不接受任何输入）；
 * - 静态镜头来源（不猜视频时长）；
 * - 非视频生成目标；
 * - 归属非法、源片场或 clip 不存在；
 * - 自环或重复边。
 */
export function decideShotReferenceConnection(input: {
  sourceId: string;
  targetId: string;
  sourceIsPreview: boolean;
  targetIsPreview: boolean;
  sourceData: Record<string, unknown> | undefined;
  targetType: string | undefined;
  targetData: Record<string, unknown> | undefined;
  readNodeData: (nodeId: string) => Record<string, unknown> | undefined;
  hasExistingEdge: boolean;
}): ShotReferenceDecision {
  if (input.targetIsPreview) {
    return { ok: false, reason: "拍摄镜头预览不接受任何输入连接" };
  }
  if (!input.sourceIsPreview) {
    return { ok: false, reason: "镜头参考必须从拍摄镜头预览拉出" };
  }
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: "镜头参考不能自连" };
  }
  const source = resolveShotReferenceSource(input.sourceId, input.sourceData, input.readNodeData);
  if (!source) {
    return { ok: false, reason: "镜头参考来源的片场或拍摄镜头不存在" };
  }
  if (source.kind !== "dynamic") {
    return { ok: false, reason: "静态拍摄镜头不能作为视频参考" };
  }
  if (!isShotReferenceTargetNode(input.targetType, input.targetData)) {
    return { ok: false, reason: "镜头参考只能连到视频生成节点" };
  }
  if (input.hasExistingEdge) {
    return { ok: false, reason: "该镜头参考已存在" };
  }
  return { ok: true, source };
}

/** 镜头参考边/映射上的媒体字段名黑名单：引用只保存稳定身份，不得携带媒体结果。 */
export const SHOT_REFERENCE_FORBIDDEN_MEDIA_FIELDS = [
  "outputAssetId",
  "resultUrl",
  "url",
  "posterUrl",
  "textureHandle",
  "textureKey"
] as const;
