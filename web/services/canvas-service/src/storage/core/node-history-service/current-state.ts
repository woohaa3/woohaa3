import { readFilmSetGroupMarker, fnv1a64Hex, nodeHistoryKindForNodeType, decodeAnimationPayload, type ContentContributionResolver } from "@woohaa3/contracts";
/**
 * 节点生成历史服务：当前生效状态读取与判定
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 */
import {
  animationDefinitionSnapshotHash,
  animationSnapshotHash,
  decodeFilmSetNodeData,
  decodeImageEditDocument,
  decodeModelPlacement,
  hashModelScript,
  imageEditDocumentContentIdentity,
  modelContentIdentity,
  type NodeGenerationHistoryEntry,
  type NodeGenerationKind,
  type NodeHistoryAnimationPayload,
  type NodeHistoryModelPlacement,
  type ServerCanvas
} from "@woohaa3/contracts";

/** 节点当前生效状态：脚本 identity 与（模型）显式摆放。 */
export type CurrentNodeState = {
  identity: string | null;
  placement: NodeHistoryModelPlacement | null;
};

/**
 * 自包含动画节点的完整定义身份
 * （change: 2026-10-06，任务 2.1/R3）：`animation:<snapshotHash>`。非动画节点返回 null。
 */
export function animationDefinitionIdentity(data: Record<string, unknown>, content?: ContentContributionResolver): string | null {
  if (content && Object.prototype.hasOwnProperty.call(data, "filmSetGroup")) {
    const owned = decodeAnimationPayload({ schemaVersion: 4, filmSetGroup: data.filmSetGroup }, { content });
    return owned ? animationDefinitionIdentityFromPayload(owned) : null;
  }
  const marker = readFilmSetGroupMarker(data);
  if (marker) return `film-set-group:${fnv1a64Hex(JSON.stringify(marker))}`;
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return null;
  if (content && (Object.prototype.hasOwnProperty.call(data, "filmSetContent") || Object.prototype.hasOwnProperty.call(data, "filmSetAnimations"))) {
    const owned = decodeAnimationPayload({
      schemaVersion: 3,
      scenePlacement: decoded.value.scenePlacement,
      sceneCamera: decoded.value.sceneCamera,
      filmSetContent: decoded.value.filmSetContent,
      filmSetAnimations: decoded.value.filmSetAnimations,
      ...(decoded.value.origin ? { origin: decoded.value.origin } : {})
    }, { content });
    return owned?.schemaVersion === 3 ? animationDefinitionIdentityFromPayload(owned) : null;
  }
  return `animation:${animationSnapshotHash(decoded.value)}`;
}

/** 由历史动画 payload 计算同一完整定义身份（供登记去重与当前身份复用）。 */
export function animationDefinitionIdentityFromPayload(animation: NodeHistoryAnimationPayload): string {
  if (animation.schemaVersion === 4) return `film-set-group:${fnv1a64Hex(JSON.stringify(animation.filmSetGroup))}`;
  if (animation.schemaVersion !== 3) throw new Error("历史片场必须先完成离线迁移");
  return `animation:${animationDefinitionSnapshotHash({ scenePlacement: animation.scenePlacement, sceneCamera: animation.sceneCamera, filmSetContent: animation.filmSetContent, filmSetAnimations: animation.filmSetAnimations })}`;
}

export const historyKindForNodeType = nodeHistoryKindForNodeType;

/**
 * 判定历史条目是否为节点当前版本（change: 模型编辑历史）。
 */
export function entryMatchesCurrent(entry: NodeGenerationHistoryEntry, current: CurrentNodeState): boolean {
  if (current.identity === null) return false;
  return entry.currentIdentity === current.identity;
}

/** 从规范聚合读取节点当前状态（同步版；供 `restore` 使用）。 */
export function currentNodeStateOf(canvas: ServerCanvas, nodeId: string, kind: NodeGenerationKind, content?: ContentContributionResolver): CurrentNodeState {
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  const raw = data?.modelPlacement;
  const placement = raw === undefined || raw === null ? null : decodeModelPlacement(raw);
  return { identity: currentIdentityOf(canvas, nodeId, kind, content), placement };
}

/** 节点当前生效版本 identity；无则 null。与 `nodeHistoryContentIdentity` 同构。 */
export function currentIdentityOf(canvas: ServerCanvas, nodeId: string, kind: NodeGenerationKind, content?: ContentContributionResolver): string | null {
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  if (!data) return null;
  if (kind === "model") {
    // 自包含片场（items-only）当前身份覆盖完整片场定义（独立根 + items + 全部片段），
    // 与顶层作者模型字段无关；必须先于顶层模型脚本读取判断（否则合法片场身份恒为 null）。
    const animationIdentity = animationDefinitionIdentity(data, content);
    if (animationIdentity) return animationIdentity;
    const source = typeof data.modelScript === "string" ? data.modelScript : "";
    if (source === "") return null;
    // 摆放感知：同一脚本、不同摆放的历史版本互不冒充当前。
    const placement = data.modelPlacement === undefined || data.modelPlacement === null
      ? undefined
      : (decodeModelPlacement(data.modelPlacement) ?? undefined);
    return modelContentIdentity(hashModelScript(source), placement);
  }
  if (kind === "text") {
    const result = data.result as { kind?: unknown; text?: unknown } | undefined;
    const text = result?.kind === "text" && typeof result.text === "string"
      ? result.text
      : readOutputTextAsset(canvas, data);
    if (text === null) return null;
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return `text:${(hash >>> 0).toString(36)}`;
  }
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  const storageKey = asset?.metadata && typeof (asset.metadata as { storageKey?: unknown }).storageKey === "string"
    ? (asset.metadata as { storageKey: string }).storageKey
    : "";
  if (!storageKey) return null;
  // 图片编辑/工程版本使用编辑身份（base/尺寸/文档 hash/输出），与纯媒体 `media:` 身份分离；
  // 否则恢复后的当前判定永远不成立，列表不会标记「当前版本」，应用也会一直停在确认中。
  if (kind === "image") {
    const decoded = data.imageEdit !== undefined && data.imageEdit !== null
      ? decodeImageEditDocument(data.imageEdit)
      : null;
    if (decoded?.ok) {
      const baseAsset = canvas.assets.find((candidate) => candidate.id === decoded.value.baseAssetId);
      const baseStorageKey = baseAsset?.metadata && typeof (baseAsset.metadata as { storageKey?: unknown }).storageKey === "string"
        ? (baseAsset.metadata as { storageKey: string }).storageKey
        : "";
      if (baseStorageKey) {
        return imageEditDocumentContentIdentity({
          document: decoded.value,
          baseStorageKey,
          outputStorageKey: storageKey
        });
      }
    }
  }
  return `media:${storageKey}`;
}

function readOutputTextAsset(canvas: ServerCanvas, data: Record<string, unknown>): string | null {
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  return asset && typeof asset.text === "string" ? asset.text : null;
}

export function isActiveGeneration(data: Record<string, unknown> | undefined): boolean {
  const status = data?.taskStatus;
  return status === "pending" || status === "processing";
}

/** 画布级：一页内按 nodeId 去重读取当前状态（有界）。 */
export function currentStatesFor(
  canvas: ServerCanvas | null,
  entries: readonly NodeGenerationHistoryEntry[],
  content?: ContentContributionResolver
): Map<string, CurrentNodeState> {
  const states = new Map<string, CurrentNodeState>();
  if (!canvas) return states;
  for (const nodeId of new Set(entries.map((entry) => entry.nodeId))) {
    const kind = entryKindForNode(canvas, nodeId);
    states.set(
      nodeId,
      kind ? currentNodeStateOf(canvas, nodeId, kind, content) : { identity: null, placement: null }
    );
  }
  return states;
}

export function entryKindForNode(canvas: ServerCanvas, nodeId: string): NodeGenerationKind | null {
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  return node ? historyKindForNodeType(node.type, canvas.nodeData[nodeId]) : null;
}

/** 安全节点标题：优先节点用户可见标题。 */
export function nodeTitleOf(canvas: ServerCanvas | null, nodeId: string): string | null {
  const data = canvas?.nodeData[nodeId] as { title?: unknown } | undefined;
  const title = data?.title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : null;
}

/** 无标题节点的稳定回退标题（按内容种类派生，不暴露内部字段）。 */
export function fallbackNodeTitle(kind: NodeGenerationKind): string {
  switch (kind) {
    case "text":
      return "文本节点";
    case "image":
      return "图片节点";
    case "video":
      return "视频节点";
    case "audio":
      return "音频节点";
    case "model":
      return "模型节点";
  }
}
