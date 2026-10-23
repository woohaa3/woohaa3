/**
 * 从权威画布解析参考输入（change: split-web-runtime-services，任务 5.3 / design D6）。
 *
 * 迁自 `apps/site/src/task/input-resolution.ts`：**权威输入解析属于 Canvas Service**，
 * 浏览器派生结果不再作为 Task 的权威输入（proposal / canvas-reference-inputs spec）。
 *
 * 只输出稳定引用（assetId/role/storageKey/mediaType），绝不输出 bytes、浏览器 URL 或签名 URL。
 */
import {
  ensureWoohaa3CanvasInputMappingSlotId,
  inferWoohaa3CanvasInputRole,
  isShotReferenceRole, providerReferenceRole,
  sortWoohaa3CanvasInputMappings,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type CanvasTaskInputBinding,
  type CanvasReferenceMediaKind,
  type ServerCanvas,
  type StoredAsset } from "@woohaa3/contracts";
import type { CanvasTaskInput } from "@woohaa3/contracts";
import { resolveShotReferenceAsset } from "./shot-reference-resolution.js";

export type ResolvedReference = {
  slotId: string;
  role: string;
  sortKey?: string;
  sourceNodeId: string;
  input: CanvasTaskInput;
};

export type InputResolution = {
  references: ResolvedReference[];
  inputs: CanvasTaskInput[];
  blockingReasons: string[];
};

export type ResolveNodeInputsOptions = {
  frozenShotImages?: import("@woohaa3/contracts").FrozenShotImageReference[];
  canvas: ServerCanvas;
  nodeId: string;
  /** 模型参考输入 bindings（由 catalog 模型解析）。 */
  bindings: CanvasTaskInputBinding[];
};

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

export function resolveNodeReferenceInputs(options: ResolveNodeInputsOptions): InputResolution {
  const { canvas, nodeId, bindings } = options;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const targetNode = canvas.document.nodes.find((node) => node.id === nodeId);
  const blockingReasons: string[] = [];
  const references: ResolvedReference[] = [];
  const counts = new Map<string, number>();

  if (!targetNode) {
    return { references, inputs: [], blockingReasons: [`节点 ${nodeId} 不存在`] };
  }

  const mappings = collectInputMappings(canvas, nodeId, nodeData);

  for (const mapping of mappings) {
    // 文字角色是 prompt 来源，不是媒体参考资产。它的内容由 prompt-resolution 解析。
    if (mapping.role === "text_prompt") continue;
    if (isShotReferenceRole(mapping.role)) {
      resolveShotReferenceMapping({ canvas, nodeData, mapping, bindings, counts, references, blockingReasons,
        frozen: options.frozenShotImages?.find(ref => ref.slotId === mapping.slotId && ref.sourceNodeId === mapping.sourceNodeId) });
      continue;
    }
    const explicit = (mapping.sourceAssetIds ?? []).filter(
      (id): id is string => typeof id === "string" && id !== ""
    );
    let assetIds = explicit;
    if (assetIds.length === 0) {
      const outputAssetId = nodeData[mapping.sourceNodeId]?.outputAssetId;
      if (typeof outputAssetId !== "string" || outputAssetId === "") {
        blockingReasons.push(`上游节点 ${mapping.sourceNodeId} 还没有可用输出，无法作为参考输入`);
        continue;
      }
      assetIds = [outputAssetId];
    }

    for (const assetId of assetIds) {
      const asset = canvas.assets.find((entry) => entry.id === assetId);
      const problem = validateReferenceAsset(asset, assetId, bindings, mapping.role);
      if (problem) {
        blockingReasons.push(problem);
        continue;
      }
      const typedAsset = asset as StoredAsset;
      const storageKey = readStorageKey(typedAsset) as string;
      const mediaType = readMediaType(typedAsset, storageKey);
      const mediaKind = typedAsset.mediaKind as CanvasReferenceMediaKind;
      const binding = bindings.find(
        (entry) =>
          entry.roles.includes(mapping.role) &&
          entry.mediaKinds.includes(mediaKind) &&
          entry.mediaTypes.includes(mediaType)
      );
      if (binding) {
        const used = (counts.get(binding.field) ?? 0) + 1;
        if (used > binding.maxItems) {
          blockingReasons.push(`参考输入数量 ${used} 超过模型对 ${binding.field} 的上限 ${binding.maxItems}`);
          continue;
        }
        counts.set(binding.field, used);
      }
      references.push({
        slotId: mapping.slotId ?? "",
        role: mapping.role,
        sortKey: mapping.sortKey,
        sourceNodeId: mapping.sourceNodeId,
        input: {
          assetId,
          role: mapping.role,
          storageKey,
          mediaType,
          mediaKind
        }
      });
    }
  }

  return {
    references,
    inputs: references.map((reference) => reference.input),
    blockingReasons
  };
}

function resolveShotReferenceMapping(input: {
  frozen?: import("@woohaa3/contracts").FrozenShotImageReference;
  canvas: ServerCanvas;
  nodeData: Record<string, CanvasNodeData | undefined>;
  mapping: CanvasNodeInputMapping;
  bindings: CanvasTaskInputBinding[];
  counts: Map<string, number>;
  references: ResolvedReference[];
  blockingReasons: string[];
}): void {
  const { canvas, nodeData, mapping, bindings, counts, references, blockingReasons } = input;
  const role = providerReferenceRole(mapping.role);
  const resolution = resolveShotReferenceAsset({ canvas, nodeData, mapping, ...(input.frozen ? { frozen: input.frozen } : {}) });
  if (!resolution.ok) {
    blockingReasons.push(resolution.reason);
    return;
  }
  const asset = resolution.asset;
  const storageKey = readStorageKey(asset);
  if (!storageKey) {
    blockingReasons.push(`镜头参考资产「${asset.title || asset.id}」缺少稳定 storageKey`);
    return;
  }
  const mediaType = readMediaType(asset, storageKey);
  const mediaKind = asset.mediaKind as CanvasReferenceMediaKind;
  const binding = bindings.find(
    (entry) =>
      entry.roles.includes(role) &&
      entry.mediaKinds.includes(mediaKind) &&
      entry.mediaTypes.includes(mediaType)
  );
  if (!binding) {
    blockingReasons.push(`所选模型不接受${role === "reference_image" ? "图片" : "视频"}参考角色「${role}」或类型「${mediaType}」`);
    return;
  }
  const used = (counts.get(binding.field) ?? 0) + 1;
  if (used > binding.maxItems) {
    blockingReasons.push(`参考输入数量 ${used} 超过模型对 ${binding.field} 的上限 ${binding.maxItems}`);
    return;
  }
  counts.set(binding.field, used);
  references.push({
    slotId: mapping.slotId ?? "",
    role,
    sortKey: mapping.sortKey,
    sourceNodeId: mapping.sourceNodeId,
    input: {
      assetId: asset.id,
      role,
      storageKey,
      mediaType,
      mediaKind
    }
  });
}

function collectInputMappings(
  canvas: ServerCanvas,
  nodeId: string,
  nodeData: Record<string, CanvasNodeData | undefined>
): CanvasNodeInputMapping[] {
  const incomingSources = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  const sourceSet = new Set(incomingSources);
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));

  const declared = (nodeData[nodeId]?.inputMapping ?? [])
    .filter((mapping) => sourceSet.has(mapping.sourceNodeId));

  const declaredSources = new Set(declared.map((mapping) => mapping.sourceNodeId));
  const synthesized = incomingSources
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

  return [...sortWoohaa3CanvasInputMappings(declared), ...synthesized];
}

function validateReferenceAsset(
  asset: StoredAsset | undefined,
  assetId: string,
  bindings: CanvasTaskInputBinding[],
  role: string
): string | null {
  if (!asset) return `引用的资产 ${assetId} 不在当前画布中`;
  const label = asset.title || asset.id;
  if (asset.status !== "ready") return `参考资产「${label}」尚未就绪（${asset.status}）`;
  const mediaKind = asset.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    return `参考资产「${label}」不是可引用的媒体（${mediaKind}）`;
  }
  const storageKey = readStorageKey(asset);
  if (!storageKey) return `参考资产「${label}」缺少稳定 storageKey`;
  const mediaType = readMediaType(asset, storageKey);
  const binding = bindings.find(
    (entry) => entry.roles.includes(role) && entry.mediaKinds.includes(mediaKind)
  );
  if (!binding) return `所选模型不接受参考角色「${role}」或媒体类型「${mediaKind}」`;
  if (!binding.mediaTypes.includes(mediaType)) return `所选模型不接受参考类型「${mediaType}」`;
  return null;
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
