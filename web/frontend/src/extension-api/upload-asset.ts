/**
 * 本地上传 → 画布节点（change: 后续 change 补齐右键菜单「上传」）。
 *
 * 边界（与既有约定一致）：
 * - bytes 先上传到 Media Service（`POST /api/media`，内容寻址），**上传成功后**才提交命令；
 * - 画布只持有稳定引用：`asset.metadata` 的 storageKey/checksum/contentType/size 与同源 `url`，
 *   绝不写入 blob/data URL；
 * - 上传失败或文件类型不支持时不产生任何命令，规范画布保持不变。
 *
 * 纯规划逻辑（`planUploadedNode`）无 DOM/fetch 依赖，便于单测；网络调用在 `uploadMediaFile`。
 */
import {
  createHighEntropyId,
  uploadedMediaKind,
  inferWoohaa3CanvasInputRole,
  type CanvasCommand,
  type CanvasNodeData,
  type StoredAsset,
  type Woohaa3CanvasPosition
} from "@woohaa3/contracts";
import { planInsertNode } from "./command-planner.js";
import { mediaUrlFor as mediaUrlForStorageKey } from "../cordis/services/paths.js";

/** 上传菜单接受的文件类型（与 Media Service 白名单一致）。 */
export const UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4,text/plain,text/markdown,application/json";

/** 浏览器文件的三要素（`File` 的结构子集，便于单测传字面量）。 */
export type UploadFile = { name: string; type: string; size: number };

export type UploadedMedia = {
  /** 服务端返回的稳定 storageKey（`sha256-...` 或 `generation-outputs/...`）。 */
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  /** 同源读取地址。 */
  url: string;
  deduplicated: boolean;
};

/** 文件 → 规范节点类型；不支持的类型返回 `null`。`generate`（3D 模型）不来自上传。 */
export function uploadedNodeType(file: UploadFile): string | null {
  const kind = uploadedMediaKind(file);
  if (!kind) return null;
  // upload 的 kind 与节点类型同名（text/image/video/audio）。
  return kind;
}

/** 已成功的媒体上传 → 稳定资产（内容寻址）。仅用于 image/video/audio。 */
export function buildUploadedAsset(input: {
  media: UploadedMedia;
  mediaKind: "image" | "video" | "audio";
  file: UploadFile;
  now?: string;
}): StoredAsset {
  const { media, mediaKind, file } = input;
  return {
    id: `asset-upload-${media.checksum}`,
    title: file.name || "上传素材",
    mediaKind,
    source: "uploaded",
    status: "ready",
    createdAt: input.now ?? new Date().toISOString(),
    url: media.url || mediaUrlForStorageKey(media.storageKey),
    metadata: {
      storageKey: media.storageKey,
      checksum: media.checksum,
      contentType: media.contentType,
      size: media.size
    }
  };
}

/** 文本上传：正文直接进资产 `text` 字段（无需媒体对象，也不上传 COS）。 */
export function buildUploadedTextAsset(input: {
  file: UploadFile;
  text: string;
  now?: string;
}): StoredAsset {
  return {
    id: createHighEntropyId("asset-upload-text"),
    title: input.file.name || "上传文本",
    mediaKind: "text",
    source: "uploaded",
    status: "ready",
    createdAt: input.now ?? new Date().toISOString(),
    text: input.text,
    metadata: {}
  };
}

/**
 * 规划「上传 → 节点」命令批次。
 *
 * 顺序：`asset.upsert` → `node.add`（携带引用该资产的 nodeData）。服务端按序应用，
 * 因此节点就绪时资产已存在。失败时整批拒绝，不产生部分状态。
 *
 * `connectFrom` 用于拉线到空白后选择「上传…」：上传的节点会与源节点连线。
 */
export function planUploadedNode(input: {
  nodeType: string;
  position: Woohaa3CanvasPosition;
  file: UploadFile;
  asset: StoredAsset;
  /** 显式节点 ID（批量导入需要稳定回执）；缺省生成。 */
  nodeId?: string;
  connectFrom?: { nodeId: string; nodeType: string; label?: string };
}): CanvasCommand[] {
  const nodeData = uploadedNodeData(input.nodeType, input.asset, input.file);
  const connect = input.connectFrom;
  const commands: CanvasCommand[] = [{ type: "asset.upsert", asset: input.asset }];
  if (connect) {
    const data: CanvasNodeData = { ...(nodeData ?? {}) };
    data.inputMapping = [
      {
        sourceNodeId: connect.nodeId,
        role: inferWoohaa3CanvasInputRole({
          sourceNode: { id: connect.nodeId, type: connect.nodeType },
          targetNode: { id: "pending", type: input.nodeType }
        }),
        sortKey: "0"
      }
    ];
    commands.push(
      ...planInsertNode({
        nodeType: input.nodeType,
        position: input.position,
        nodeData: data,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        connectFromNodeId: connect.nodeId,
        ...(connect.label ? { connectLabel: connect.label } : {})
      })
    );
    return commands;
  }
  commands.push(
    ...planInsertNode({
      nodeType: input.nodeType,
      position: input.position,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(nodeData ? { nodeData } : {})
    })
  );
  return commands;
}

/**
 * 规划「替换选中图片节点」命令批次
 * （change: add-paste-import-workflows，任务 5.3 / design D5）。
 *
 * 只在图片上传成功后调用。顺序：`asset.upsert` 新稳定资产 → `nodeData.patch` 目标节点。
 * patch 只更新输出资产引用与 ready 状态，并清理不再有效的运行态/结果/错误字段；**保留**
 * 节点 ID、位置、尺寸、边、inputMapping、用户 prompt、模型和 parameters（其它字段不写入）。
 */
export function planReplaceImage(input: {
  nodeId: string;
  asset: StoredAsset;
}): CanvasCommand[] {
  // nodeData.patch 是浅合并：写入 null 只会覆盖为 null，不会删除键；因此用
  // `sanitizeNodeDataForClipboard` 记录要清理的运行态字段名，再由调用方显式删除。
  // 目标节点是可替换的 canonical 非 processing 图片节点，因此不存在 activeRunId/progress
  // 等仍有效的运行态；这里把不再有效的错误态、结果态显式置 null（nodeData.patch 是浅合并，
  // null 是受支持的“清除”值），并更新输出资产引用与 ready 状态。
  const patch: CanvasNodeData = {
    outputAssetId: input.asset.id,
    resourceKind: "image",
    status: "ready",
    taskStatus: "successed",
    error: null,
    errorMessage: null,
    result: null as never,
    resultPreview: null as never,
    progress: null as never
  };
  return [
    { type: "asset.upsert", asset: input.asset },
    { type: "nodeData.patch", nodeId: input.nodeId, value: patch }
  ];
}

/** 上传节点的初始 nodeData：直接指向已就绪资产（无需执行任务）。 */
function uploadedNodeData(nodeType: string, asset: StoredAsset, file: UploadFile): CanvasNodeData | undefined {
  if (nodeType === "text") {
    return { title: file.name, outputAssetId: asset.id, resourceKind: "text", taskStatus: "successed" };
  }
  if (nodeType === "image" || nodeType === "video" || nodeType === "audio") {
    return {
      title: file.name,
      outputAssetId: asset.id,
      resourceKind: nodeType,
      taskStatus: "successed"
    };
  }
  return undefined;
}
