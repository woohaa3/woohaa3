/**
 * 镜头参考的**冻结与登记**（任务 8.6 / design D9）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 下游执行前，把已在版本缓存里 ready 的镜头视频**冻结**成权威引用：登记真实视频资产（带镜头版本
 * metadata）并把资产 id 写入目标节点 `inputMapping[].sourceAssetIds`。服务端随后据 `asset.upsert`
 * 与 `nodeData.patch` 的结果解析出 `reference_video`。
 *
 * 语义：
 * - **未就绪只等待**：对应版本没有 ready 资产时只回报 `waiting`，绝不写半成品、不调 Provider；
 * - **身份去重**：同版本资产 id 稳定，重复规划是幂等的（已写入则不再产出命令）；
 * - **不偷换版本**：结算用当时冻结的内容身份，内容更新后旧版本仍以其原身份登记；
 * - **不写预览节点**：只写目标节点与 `canvas.assets`，预览 nodeData 不承载 outputAssetId。
 *
 * 纯函数：只读画布、返回命令，不提交、不联网。
 */
import { decodeFilmSetNodeData, DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, filmSetAnimationsOf, shotReferenceAssetMetadata, shotReferenceContentIdentity, shotReferenceOwnershipOf, shotReferenceProfileKey, SHOT_REFERENCE_ROLE, type CanvasCommand, type CanvasNodeData, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";

/** 默认录制 profile key；与录制能力保持一致（内容身份也按默认 profile 计算）。 */
const DEFAULT_SHOT_REFERENCE_PROFILE_KEY = shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE);

/** 与录制缓存一致的资产投影。 */
export type ShotReferenceReadyAsset = { storageKey: string; checksum: string; mediaType: string; size: number };

export type ShotReferenceFreezeRequest = {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
};

export type ShotReferenceWaiting = ShotReferenceFreezeRequest;

export type ShotReferenceFreezePlan = {
  /** 幂等命令：登记资产并写入 sourceAssetIds。 */
  commands: CanvasCommand[];
  /** 尚未就绪、需要继续等待的镜头版本。 */
  waiting: ShotReferenceWaiting[];
  /** 无法解析（预览/片场/镜头失效）的映射，明确跳过。 */
  invalid: string[];
};

/** 同版本资产 id：内容身份 + profile 决定，重复规划稳定。 */
export function shotReferenceAssetId(request: ShotReferenceFreezeRequest): string {
  return `shot-reference-video:${request.filmSetNodeId}:${request.clipId}:${request.contentIdentity}:${request.profileKey}`;
}

/** 构造登记用的真实视频资产。 */
export function buildShotReferenceAsset(
  request: ShotReferenceFreezeRequest,
  ready: ShotReferenceReadyAsset,
  title: string,
  createdAt: string
): StoredAsset {
  return {
    id: shotReferenceAssetId(request),
    title,
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt,
    metadata: {
      storageKey: ready.storageKey,
      // 服务端 `validateAssetReferences` 要求 checksum 为 64 位 hex 且与 storageKey 内嵌哈希一致；
      // 缺它会让整批 `asset.upsert + nodeData.patch` 以 `asset-reference-invalid` 被拒。
      checksum: ready.checksum,
      contentType: ready.mediaType,
      size: ready.size,
      ...shotReferenceAssetMetadata({
        filmSetNodeId: request.filmSetNodeId,
        clipId: request.clipId,
        contentIdentity: request.contentIdentity,
        profileKey: request.profileKey
      })
    }
  };
}

/**
 * 规划冻结：扫描权威画布中所有目标节点的 `shot_reference` 映射，为已就绪版本产出幂等命令。
 */
export function planShotReferenceFreeze(input: {
  canvas: ServerCanvas;
  readyAsset(request: ShotReferenceFreezeRequest): ShotReferenceReadyAsset | null;
  now(): string;
}): ShotReferenceFreezePlan {
  const { canvas, readyAsset, now } = input;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const commands: CanvasCommand[] = [];
  const waiting: ShotReferenceWaiting[] = [];
  const invalid: string[] = [];
  const registered = new Set(canvas.assets.map((asset) => asset.id));

  for (const node of canvas.document.nodes) {
    const target = nodeData[node.id];
    const mappings = target?.inputMapping ?? [];
    if (!mappings.some((mapping) => mapping.role === SHOT_REFERENCE_ROLE)) continue;
    let patched: CanvasNodeData | null = null;

    for (const mapping of mappings) {
      if (mapping.role !== SHOT_REFERENCE_ROLE) continue;
      const ownership = shotReferenceOwnershipOf(nodeData[mapping.sourceNodeId]);
      if (!ownership) {
        invalid.push(`镜头参考来源 ${mapping.sourceNodeId} 不是拍摄镜头预览节点`);
        continue;
      }
      const animation = decodeFilmSetNodeData(nodeData[ownership.filmSetNodeId]);
      if (!animation.ok) {
        invalid.push(`镜头参考所属片场 ${ownership.filmSetNodeId} 无法解析`);
        continue;
      }
      const clip = filmSetAnimationsOf(animation.value).clips.find((entry) => entry.id === ownership.clipId);
      if (!clip) {
        invalid.push(`镜头参考的镜头 ${ownership.clipId} 已不存在`);
        continue;
      }
      const contentIdentity = shotReferenceContentIdentity({ animation: animation.value, clipId: clip.id });
      if (!contentIdentity) {
        invalid.push(`镜头参考的镜头 ${clip.id} 无法计算内容身份`);
        continue;
      }
      const request: ShotReferenceFreezeRequest = {
        canvasId: canvas.id,
        filmSetNodeId: ownership.filmSetNodeId,
        clipId: clip.id,
        contentIdentity,
        profileKey: DEFAULT_SHOT_REFERENCE_PROFILE_KEY
      };
      const ready = readyAsset(request);
      if (!ready) {
        waiting.push(request);
        continue;
      }
      const assetId = shotReferenceAssetId(request);
      const already = (mapping.sourceAssetIds ?? []).includes(assetId);
      if (already) continue;
      if (!registered.has(assetId)) {
        commands.push({ type: "asset.upsert", asset: buildShotReferenceAsset(request, ready, `${clip.name} · 镜头参考`, now()) });
        registered.add(assetId);
      }
      patched ??= structuredClone(target) as CanvasNodeData;
      const patchedMappings = (patched.inputMapping ?? []) as CanvasNodeData["inputMapping"];
      const index = patchedMappings!.findIndex((entry) => entry.slotId === mapping.slotId);
      if (index >= 0) patchedMappings![index] = { ...patchedMappings![index]!, sourceAssetIds: [assetId] };
    }

    if (patched) commands.push({ type: "nodeData.patch", nodeId: node.id, value: patched });
  }

  return { commands, waiting, invalid };
}
