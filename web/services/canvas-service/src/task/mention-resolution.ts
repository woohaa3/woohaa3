/**
 * Canvas 权威 mention 解析与 prompt 编译
 * （change: add-reference-inputs-and-mentions，任务 5.1–5.4 / design D4/D5/D9）。
 *
 * 从**当前 published Y.Doc**（非 Frontend 提交）构造直接 slot 候选，校验 token 的类型、
 * 画布归属、ready 状态与 storageKey。编译规则：
 * - `input_text` token 原位展开为权威文字内容；
 * - 媒体 token 渲染为稳定可读文字（如“图片 1”）；
 * - 直接媒体输入先按 mapping 顺序解析；
 * - 直接文字 source 明确 mention 的 ready 媒体作为 carried inputs 追加（一层，按 asset ID 去重）。
 */
import {
  collectWoohaa3CanvasMentions,
  selfReferenceMapping,
  decodeWorldCamera,
  worldCameraShotContext,
  ensureWoohaa3CanvasInputMappingSlotId,
  inferWoohaa3CanvasInputRole,
  pickInputBinding,
  renderWoohaa3CanvasMentionProviderText,
  sortWoohaa3CanvasInputMappings,
  type Woohaa3CanvasMentionType,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type CanvasReferenceMediaKind,
  type CanvasTaskInput,
  type CanvasTaskInputBinding,
  type ServerCanvas,
  type StoredAsset,
  type Woohaa3CanvasMention
} from "@woohaa3/contracts";

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4"
};

export type MentionCandidate = {
  slotId: string;
  type: Woohaa3CanvasMentionType;
  role: string;
  sourceNodeId: string;
  label: string;
  /** 该 slot 当前解析出的稳定媒体（文字 slot 为 text 资产）。 */
  input: CanvasTaskInput | null;
  /** 文字 slot 的权威文字内容（仅 input_text 有效）。 */
  text?: string;
};

export type MentionResolution =
  | { kind: "ok"; providerText: string; inputs: CanvasTaskInput[]; candidates: MentionCandidate[] }
  | { kind: "invalid-mention"; message: string };

/**
 * 有效 authored prompt 的来源：
 * - 目标自身 authored 非空 → 用目标 authored（token 归属目标自身 mappings）；
 * - 目标 authored 为空且直接连接文字节点 → 用文字内容（token 归属文字节点自身 mappings，
 *   图片任务的上游文字回退语义）。
 */
type EffectivePrompt = {
  text: string;
  /** token 指向哪个节点上的 slot（默认目标；上游文字回退时为文字 source 汇总）。 */
  candidateNodeIds: string[];
};

function resolveEffectivePrompt(canvas: ServerCanvas, nodeId: string, authored: string): EffectivePrompt {
  const trimmed = authored.trim();
  if (trimmed !== "") return { text: authored, candidateNodeIds: [nodeId] };
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const textSources = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source)
    .filter((sourceId) => canvas.document.nodes.find((node) => node.id === sourceId)?.type === "text");
  if (textSources.length === 0) return { text: authored, candidateNodeIds: [nodeId] };
  const parts = textSources.map((sourceId) => textNodeContent(nodeData[sourceId], canvas.assets));
  return { text: parts.filter((part) => part !== "").join("\n\n"), candidateNodeIds: textSources };
}

/** 直接 slot 候选（当前节点直接 mapping，含文字）。 */
export function collectDirectMentionCandidates(
  canvas: ServerCanvas,
  nodeId: string,
  cameraInputs?: ReadonlyMap<string, CanvasTaskInput>
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  let ordinal = 0;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  for (const mapping of collectDirectMappings(canvas, nodeId)) {
    let kind = mentionTypeForMapping(mapping);
    let role = mapping.role;
    const isCamera = canvas.document.nodes.some(node => node.id === mapping.sourceNodeId && node.type === "world-camera");
    if (isCamera) {
      // 镜头槽类型按动画上下文派生：动态镜头是视频槽，静态仍是图片槽。
      const camera = decodeWorldCamera(nodeData[mapping.sourceNodeId]?.worldCamera);
      if (camera.ok && worldCameraShotContext(canvas, camera.value)?.kind === "dynamic") {
        kind = "input_video";
        role = "reference_video";
      }
    }
    ordinal += 1;
    const resolved = resolveMappingAsset(canvas, mapping);
    const slotId = mapping.slotId;
    if (typeof slotId !== "string" || slotId === "") continue;
    const cameraInput = cameraInputs?.get(mapping.sourceNodeId);
    candidates.push({
      slotId,
      type: kind,
      role,
      sourceNodeId: mapping.sourceNodeId,
      label: mentionLabel(kind, ordinal, mapping),
      input: cameraInput ? { ...cameraInput, role } : resolved?.input ?? null,
      ...(kind === "input_text" && resolved?.text !== undefined ? { text: resolved.text } : {})
    });
  }
  return candidates;
}

/**
 * 权威解析与编译（任务 5.1 / 5.2 / 5.3）。
 *
 * `authored` 是本次请求的 authored prompt（可能为空）。图片节点空 authored 时先按既有
 * 规则计算 effective prompt（上游文字内容），再做 token 编译。
 */
export function resolveMentionsAndCompile(options: {
  canvas: ServerCanvas;
  nodeId: string;
  authored: string;
  bindings: CanvasTaskInputBinding[];
  /** 直接媒体输入（由 input-resolution 解析，需与 carried inputs 合并去重）。 */
  directInputs: CanvasTaskInput[];
  cameraInputs?: ReadonlyMap<string, CanvasTaskInput>;
}): MentionResolution {
  const { canvas, nodeId, bindings } = options;
  const candidates = collectDirectMentionCandidates(canvas, nodeId, options.cameraInputs);

  // 有效 prompt 与 token 的归属节点（上游文字回退时 token 属于文字节点自身 mappings）。
  const effective = resolveEffectivePrompt(canvas, nodeId, options.authored);
  const ownerCandidates = new Map<string, MentionCandidate>();
  for (const ownerId of effective.candidateNodeIds) {
    const ownerSlots = ownerId === nodeId ? candidates : collectDirectMentionCandidates(canvas, ownerId);
    for (const candidate of ownerSlots) ownerCandidates.set(candidate.slotId, candidate);
  }

  // 1) 校验 effective prompt 中的 token（不信任 Frontend 候选）。
  for (const mention of collectWoohaa3CanvasMentions(effective.text)) {
    const candidate = ownerCandidates.get(mention.slotId);
    if (!candidate) {
      return { kind: "invalid-mention", message: `提示词引用了不存在的输入槽：${mention.label || mention.slotId}` };
    }
    if (candidate.type !== mention.type) {
      return { kind: "invalid-mention", message: `输入槽类型不匹配：${mention.label || mention.slotId}` };
    }
    if (candidate.type !== "input_text" && candidate.input === null) {
      return { kind: "invalid-mention", message: `被引用的素材尚未就绪：${mention.label || mention.slotId}` };
    }
  }

  // 2) 直接媒体输入（保持顺序）+ carried inputs（一层文字 source）。
  const direct = options.directInputs;
  const carried = collectCarriedInputs(canvas, nodeId);
  const merged = mergeInputs(direct, carried);

  // 3) binding 校验 + 字段归属（合并后统一处理，不静默丢弃）。
  //    每条输入必须带上它要写进的字段：carried inputs 是从文字节点的 mapping 来的，那里没有
  //    分配过字段；模型又可能有多个同类字段（主图/参考图），不补就只能落回「第一个」。
  const assigned = assignInputFields(merged, bindings);
  if (typeof assigned === "string") return { kind: "invalid-mention", message: assigned };

  // 4) Provider 文本：文字 token 原位展开，媒体 token 渲染为可读文字。
  const { text: providerText } = renderWoohaa3CanvasMentionProviderText(effective.text, {
    resolveText: (slotId) => {
      const candidate = ownerCandidates.get(slotId);
      return candidate?.type === "input_text" ? candidate.text ?? "" : null;
    },
    resolveMediaLabel: (mention: Woohaa3CanvasMention) => mention.label
  });

  return { kind: "ok", providerText, inputs: assigned, candidates };
}

/**
 * 目标节点直接连接的文字 source 中，明确 mention 且属于该文字节点直接 mapping 的 ready 媒体。
 * 只展开一层，不递归（design D5）。
 */
export function collectCarriedInputs(
  canvas: ServerCanvas,
  nodeId: string
): CanvasTaskInput[] {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const textSources = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source)
    .filter((sourceId) => canvas.document.nodes.find((node) => node.id === sourceId)?.type === "text");

  const carried: CanvasTaskInput[] = [];
  for (const textNodeId of textSources) {
    const authored = textNodeContent(nodeData[textNodeId], canvas.assets);
    if (authored === "") continue;
    const textCandidates = collectDirectMentionCandidates(canvas, textNodeId);
    const bySlot = new Map(textCandidates.map((candidate) => [candidate.slotId, candidate]));
    // 按 token 出现顺序追加。
    for (const mention of collectWoohaa3CanvasMentions(authored)) {
      const candidate = bySlot.get(mention.slotId);
      if (!candidate) continue;
      // 文字节点自身不产生媒体 carried input；只承载媒体 mention。
      if (candidate.type === "input_text") continue;
      if (candidate.type !== mention.type) continue;
      if (!candidate.input) continue;
      carried.push(candidate.input);
    }
  }
  return carried;
}

/** 合并直接输入与 carried inputs：保留直接输入的位置/role，按稳定 asset ID 去重。 */
export function mergeInputs(direct: readonly CanvasTaskInput[], carried: readonly CanvasTaskInput[]): CanvasTaskInput[] {
  const seen = new Set<string>();
  const merged: CanvasTaskInput[] = [];
  for (const input of [...direct, ...carried]) {
    if (seen.has(input.assetId)) continue;
    seen.add(input.assetId);
    merged.push(input);
  }
  return merged;
}

/**
 * 合并后统一校验 + 给每条输入补上它要写进的字段；返回带 `field` 的新列表，或阻止原因。
 *
 * 已有的 `field`（直接输入由 input-resolution 分配过）优先保留；没有的按剩余容量分配，
 * 这样 carried inputs 也能落到「主图满了之后」的下一个同类字段上。
 */
function assignInputFields(
  inputs: readonly CanvasTaskInput[],
  bindings: CanvasTaskInputBinding[]
): CanvasTaskInput[] | string {
  const counts = new Map<string, number>();
  const out: CanvasTaskInput[] = [];
  for (const input of inputs) {
    const mediaKind = input.mediaKind ?? mediaKindFromType(input.mediaType);
    const declared = input.field
      ? bindings.find(
          (entry) =>
            entry.field === input.field &&
            entry.roles.includes(input.role) &&
            entry.mediaKinds.includes(mediaKind) &&
            entry.mediaTypes.includes(input.mediaType)
        )
      : undefined;
    if (input.field && !declared) {
      return `所选模型不接受输入角色「${input.role}」或媒体类型「${input.mediaType}」`;
    }
    const binding = declared ?? pickInputBinding(bindings, { role: input.role, mediaKind, mediaType: input.mediaType }, counts);
    if (!binding) {
      return `所选模型不接受输入角色「${input.role}」或媒体类型「${input.mediaType}」`;
    }
    const used = (counts.get(binding.field) ?? 0) + 1;
    if (used > binding.maxItems) {
      return `输入数量 ${used} 超过模型对 ${binding.field} 的上限 ${binding.maxItems}`;
    }
    counts.set(binding.field, used);
    out.push({ ...input, field: binding.field });
  }
  return out;
}

function textNodeContent(data: CanvasNodeData | undefined, assets: readonly StoredAsset[]): string {
  const assetId = data?.outputAssetId;
  const asset = typeof assetId === "string" ? assets.find((entry) => entry.id === assetId) : undefined;
  const generated = asset?.mediaKind === "text" ? asset.text?.trim() ?? "" : "";
  if (generated !== "") return generated;
  const prompt = data?.prompt ?? data?.panelPrompt ?? "";
  return typeof prompt === "string" ? prompt.trim() : "";
}

/** 目标节点直接 mapping（仅保留合法 incoming source，稳定排序 + 补 slot）。 */
function collectDirectMappings(canvas: ServerCanvas, nodeId: string): CanvasNodeInputMapping[] {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const incoming = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  const sourceSet = new Set(incoming);
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const declared = (nodeData[nodeId]?.inputMapping ?? [])
    .filter((mapping) => sourceSet.has(mapping.sourceNodeId));
  const declaredSources = new Set(declared.map((mapping) => mapping.sourceNodeId));
  const synthesized = incoming
    .filter((sourceNodeId) => !declaredSources.has(sourceNodeId))
    .map((sourceNodeId, index) =>
      ensureWoohaa3CanvasInputMappingSlotId({
        sourceNodeId,
        role: inferWoohaa3CanvasInputRole({
          sourceNode: nodeById.get(sourceNodeId) ?? { id: sourceNodeId, type: "custom" },
          targetNode: { id: nodeId, type: nodeById.get(nodeId)?.type ?? "custom" },
          sourceData: nodeData[sourceNodeId],
          readNodeData: id => nodeData[id],
          targetData: nodeData[nodeId],
          existingRoles: declared.map((mapping) => mapping.role)
        }),
        sortKey: String(declared.length + index)
      })
    );
  const self = selfReferenceMapping(nodeId, nodeData[nodeId]);
  return [...(self ? [self] : []), ...sortWoohaa3CanvasInputMappings(declared), ...synthesized];
}

/** mapping → mention 类型（文字角色为 input_text，其余按 role 判定媒体类型）。 */
function mentionTypeForMapping(mapping: CanvasNodeInputMapping): Woohaa3CanvasMentionType {
  if (mapping.role === "text_prompt") return "input_text";
  const role = mapping.role;
  if (role.includes("video")) return "input_video";
  if (role.includes("audio") || role.includes("voice") || role.includes("music")) return "input_audio";
  return "input_image";
}

type ResolvedMappingAsset = { input: CanvasTaskInput | null; text?: string };

/** 解析 mapping 当前指向的稳定资产（显式 sourceAssetIds 优先，其次 source outputAssetId）。 */
function resolveMappingAsset(canvas: ServerCanvas, mapping: CanvasNodeInputMapping): ResolvedMappingAsset | null {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  if (mapping.role === "text_prompt") {
    const text = textNodeContent(nodeData[mapping.sourceNodeId], canvas.assets);
    return { input: null, text };
  }
  const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  const assetIds = explicit.length > 0 ? explicit : [nodeData[mapping.sourceNodeId]?.outputAssetId].filter(
    (id): id is string => typeof id === "string" && id !== ""
  );
  if (assetIds.length === 0) return { input: null };
  const assetId = assetIds[0]!;
  const asset = canvas.assets.find((entry) => entry.id === assetId);
  if (!asset || asset.status !== "ready") return { input: null };
  const mediaKind = asset.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") return { input: null };
  const storageKey = readStorageKey(asset);
  if (!storageKey) return { input: null };
  return {
    input: {
      assetId,
      role: mapping.role,
      storageKey,
      mediaType: readMediaType(asset, storageKey),
      mediaKind
    }
  };
}

function mentionLabel(type: Woohaa3CanvasMentionType, ordinal: number, mapping: CanvasNodeInputMapping): string {
  if (typeof mapping.label === "string" && mapping.label !== "") return mapping.label;
  const noun = type === "input_image" ? "图片" : type === "input_video" ? "视频" : type === "input_audio" ? "音频" : "文本";
  return `${noun} ${ordinal}`;
}

function readStorageKey(asset: StoredAsset): string | null {
  const key = asset.metadata?.storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

function readMediaType(asset: StoredAsset, storageKey: string): string {
  const contentType = asset.metadata?.contentType;
  if (typeof contentType === "string" && contentType !== "") {
    return contentType.split(";")[0].trim().toLowerCase();
  }
  const extension = storageKey.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "image/png";
}

/** 由 mediaType 前缀推断 mediaKind（旧客户端缺 mediaKind 时的保守回退）。 */
function mediaKindFromType(mediaType: string): CanvasReferenceMediaKind {
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "image";
}
