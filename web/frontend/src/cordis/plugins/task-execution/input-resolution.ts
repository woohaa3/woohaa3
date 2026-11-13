/**
 * 上游参考资产解析（change: add-image-text-node-execution，任务 4.1–4.5；
 * change: add-audio-video-generation-and-align-model-catalog，任务 3.1）。
 *
 * 输入是**当前规范画布** + 目标节点 + 所选模型的参考输入 bindings，输出是
 * 1. `references`：带 slotId/role/sortKey/sourceNodeId 的完整解析结果（可诊断）；
 * 2. `inputs`：只含 assetId/role/storageKey/mediaType/mediaKind 的**提交形态**；
 * 3. `blockingReasons`：任何阻止执行的输入问题。
 *
 * 关键约束（design D4/D6）：
 * - 显式 `sourceAssetIds` 优先；否则读 source node 的 `outputAssetId`。
 * - 只接受当前画布 `assets` 中 status ready、mediaKind 为 image/video/audio、
 *   带有效 metadata.storageKey 的资产。
 * - 只输出稳定引用，绝不输出 bytes、浏览器 URL 或签名 URL。
 * - 模型能力不匹配时形成 blocking reason，**不得静默丢弃**上游输入。
 *
 * 每次渲染都从当前画布重算（不缓存旧快照）。
 */
import { decodeWorldCamera, worldCameraShotContext, alignRoleToDeclaredSlot, ensureWoohaa3CanvasInputMappingSlotId,
  inferWoohaa3CanvasInputRole,
  missingRequiredSlots,
  sortWoohaa3CanvasInputMappings,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type CanvasReferenceMediaKind,
  type CanvasTaskInputBinding,
  type ServerCanvas,
  type StoredAsset } from "@woohaa3/contracts";
import type { CanvasTaskInput } from "@woohaa3/contracts";

export type ResolvedReference = {
  slotId: string;
  role: string;
  sortKey?: string;
  sourceNodeId: string;
  input: CanvasTaskInput;
};

export type InputResolution = {
  references: ResolvedReference[];
  /** 提交给网关的形态：只有稳定媒体引用。 */
  inputs: CanvasTaskInput[];
  blockingReasons: string[];
  /**
   * Camera media is frozen by the host at submission, never fabricated here. Dynamic
   * shots resolve as video; static shots stay images.
   */
  deferredReferences: Array<{ role: string; mediaKind: "image" | "video" }>;
};

export type ResolveNodeInputsOptions = {
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
  const deferredReferences: InputResolution["deferredReferences"] = [];

  if (!targetNode) {
    return { references, deferredReferences, inputs: [], blockingReasons: [`节点 ${nodeId} 不存在`] };
  }

  const mappings = collectInputMappings(canvas, nodeId, nodeData);
  /**
   * 已被占用的角色（与参考区投影同一规则）：只收模型接受的显式角色。连线的推断角色
   * 若模型根本不接受，它并不真正占用槽位。
   */
  const claimedRoles = new Set(
    mappings
      .map((mapping) => mapping.role)
      .filter((role) => bindings.some((entry) => entry.roles.includes(role)))
  );

  for (const mapping of mappings) {
    if (mapping.role === "text_prompt") continue;
    const providerRole = mapping.role;
    if (canvas.document.nodes.some(node => node.id === mapping.sourceNodeId && node.type === "world-camera")) {
      const camera = decodeWorldCamera(nodeData[mapping.sourceNodeId]?.worldCamera);
      if (!camera.ok) { blockingReasons.push("上游镜头配置无效"); continue; }
      // 镜头类型由动画上下文派生：动态镜头是视频参考，静态继续是图片。
      const shot = worldCameraShotContext(canvas, camera.value);
      const mediaKind: "image" | "video" = shot?.kind === "dynamic" ? "video" : "image";
      const mediaType = mediaKind === "video" ? "video/mp4" : "image/png";
      // 动态镜头代表视频：参考角色固定为 reference_video，不沿用图片角色。
      const referenceRole = mediaKind === "video" ? "reference_video" : providerRole;
      const binding = bindings.find(entry => entry.roles.includes(referenceRole)
        && entry.mediaKinds.includes(mediaKind) && entry.mediaTypes.includes(mediaType));
      if (!binding) {
        blockingReasons.push(
          mediaKind === "video"
            ? "所选模型不接受镜头视频参考，未降级为图片"
            : "所选模型不接受镜头图像参考"
        );
        continue;
      }
      const used = (counts.get(binding.field) ?? 0) + 1;
      counts.set(binding.field, used);
      if (used > binding.maxItems) { blockingReasons.push(`参考输入数量超过模型对 ${binding.field} 的上限 ${binding.maxItems}`); continue; }
      deferredReferences.push({ role: referenceRole, mediaKind });
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
      /**
       * 连线推断的角色可能不是模型声明的槽位（图片源默认 `reference_image`，而工作流只声明
       * `control_image`）。先对齐再校验：否则会出现「功能明明支持，却被判成不支持参考角色」
       * 的自相矛盾门禁，而用户没有任何入口能改映射角色。
       */
      const assetKind = asset?.mediaKind;
      const effectiveRole =
        assetKind === "image" || assetKind === "video" || assetKind === "audio"
          ? alignRoleToDeclaredSlot({ inferredRole: providerRole, mediaKind: assetKind, bindings, claimedRoles })
          : providerRole;
      const problem = validateReferenceAsset(asset, assetId, bindings, effectiveRole);
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
          entry.roles.includes(effectiveRole) &&
          entry.mediaKinds.includes(mediaKind) &&
          entry.mediaTypes.includes(mediaType)
      );
      if (binding) {
        const used = (counts.get(binding.field) ?? 0) + 1;
        if (used > binding.maxItems) {
          blockingReasons.push(
            `参考输入数量 ${used} 超过模型对 ${binding.field} 的上限 ${binding.maxItems}`
          );
          continue;
        }
        counts.set(binding.field, used);
      }
      references.push({
        slotId: mapping.slotId ?? "",
        role: effectiveRole,
        sortKey: mapping.sortKey,
        sourceNodeId: mapping.sourceNodeId,
        input: { assetId, role: effectiveRole, storageKey, mediaType, mediaKind }
      });
      // 对齐结果占住槽位：后续连线不能再被归到同一处（与参考区投影同一规则）。
      claimedRoles.add(effectiveRole);
    }
  }

  // 必填槽位未填充时在提交前拦住：这是"能不能跑"的问题，不是"填得对不对"，
  // 所以与上面的逐条输入校验分开，且同样用稳定原因串。
  const filledRoles = new Set(references.map((reference) => reference.role));
  for (const deferred of deferredReferences) filledRoles.add(deferred.role);
  blockingReasons.push(...missingRequiredSlots(bindings, filledRoles));

  return {
    references,
    deferredReferences,
    inputs: references.map((reference) => reference.input),
    blockingReasons
  };
}

/**
 * 收集目标节点的输入映射：
 * 1. 显式 `nodeData.inputMapping`（仅保留 source 仍在连线上的条目）按 sortKey 排序；
 * 2. 连线存在但没有映射的 source 追加在后（role 用 domain 的推断规则）。
 */
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

/** 返回阻止原因；`null` 表示该资产可以作为参考输入。 */
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
  if (!binding.mediaTypes.includes(mediaType)) {
    return `所选模型不接受参考类型「${mediaType}」`;
  }
  return null;
}

function readStorageKey(asset: StoredAsset): string | null {
  const key = asset.metadata?.storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

/**
 * 参考输入的类型：优先 `metadata.contentType`，否则按 storageKey 扩展名推断。
 * 缺失时保守取 `image/png`（模型白名单里一定有它），避免因为元数据缺失就静默放行任意类型。
 */
function readMediaType(asset: StoredAsset, storageKey: string): string {
  const contentType = asset.metadata?.contentType;
  if (typeof contentType === "string" && contentType !== "") {
    return contentType.split(";")[0].trim().toLowerCase();
  }
  const extension = storageKey.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "image/png";
}
