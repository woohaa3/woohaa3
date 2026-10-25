/**
 * 节点生成历史：稳定身份、内容身份与哈希
 * （自 `node-history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R06）。
 *
 * `entryId` / `sourceIdentity` / `currentIdentity` 由稳定生成来源派生，重复事件、重试与重启
 * 重放都落到同一 identity。纯函数、跨运行单元一致。
 */
import { imageEditShapesHash, isImageProjectDocument } from "../image-edit.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "../domain/core/composite-asset-identity.js";
import type {
  NodeGenerationSourceIdentity,
  NodeHistoryContentPayload,
  NodeHistoryModelPlacement
} from "./types.js";

/**
 * woohaa3 节点类型 → 历史种类。
 *
 * `model3d`/`composite-asset`（复合资产，含片场与炉体）承载模型脚本；非内容节点没有生成历史。
 */
export function nodeHistoryKindForNodeType(type: string): "text" | "image" | "video" | "audio" | "model" | null {
  switch (type) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "model3d":
    case COMPOSITE_ASSET_NODE_TYPE:
      return "model";
    default:
      return null;
  }
}

/** 历史种类 → 节点类型集合（权威恢复时校验节点类型兼容）。 */
export function nodeTypesForHistoryKind(kind: "text" | "image" | "video" | "audio" | "model"): readonly string[] {
  switch (kind) {
    case "text":
      return ["text"];
    case "image":
      return ["image"];
    case "video":
      return ["video"];
    case "audio":
      return ["audio"];
    case "model":
      return ["model3d", COMPOSITE_ASSET_NODE_TYPE];
  }
}

/**
 * 当前版本 identity：**内容寻址**，用于与节点当前生效输出比较。
 *
 * 文本为正文哈希、媒体为稳定 storageKey、模型为脚本 source hash。
 */
export function nodeHistoryContentIdentity(payload: NodeHistoryContentPayload): string {
  switch (payload.kind) {
    case "text":
      return `text:${hashText(payload.text)}`;
    case "model":
      return modelContentIdentity(payload.sourceHash, payload.placement);
    case "image":
      // 图片编辑版本使用编辑身份（base/尺寸/shapes/输出），与纯媒体身份刻意分离；
      // 无编辑定义/无原图 metadata 的旧条目继续使用稳定媒体身份（design D4）。
      if (payload.imageEdit && payload.base) {
        if (isImageProjectDocument(payload.imageEdit)) {
          // 工程分支：以引擎/格式版本、来源与画布尺寸、文档内容 hash 与工程对象身份表述，
          // 同 PNG 不同图层结构可区分（change editor-extension-workspace）。
          return `image-project:${payload.base.storageKey}:${payload.imageEdit.sourceWidth}x${payload.imageEdit.sourceHeight}:${payload.imageEdit.canvasWidth}x${payload.imageEdit.canvasHeight}:${payload.imageEdit.engineVersion}:${payload.imageEdit.formatVersion}:${payload.imageEdit.documentContentHash}:${payload.imageEdit.project.storageKey}:${payload.storageKey}`;
        }
        return `image-edit:${payload.base.storageKey}:${payload.imageEdit.sourceWidth}x${payload.imageEdit.sourceHeight}:${imageEditShapesHash(payload.imageEdit)}:${payload.storageKey}`;
      }
      return `media:${payload.storageKey}`;
    default:
      return `media:${payload.storageKey}`;
  }
}

/**
 * 模型当前版本 identity。
 *
 * - 无摆放：只按脚本 `model-source:<hash>`。
 * - 有摆放：脚本 + 摆放快照 `model-edit:<hash>:<key>`。
 */
export function modelContentIdentity(
  sourceHash: string,
  placement: NodeHistoryModelPlacement | undefined
): string {
  return placement
    ? `model-edit:${sourceHash}:${modelPlacementSnapshotKey(placement)}`
    : `model-source:${sourceHash}`;
}

export const NODE_HISTORY_CURRENT_IDENTITY_MAX = 512;

/** 编码为稳定、可比较、抗注入的字符串（写入 repository 与 cursor）。 */
export function encodeNodeGenerationIdentity(identity: NodeGenerationSourceIdentity): string {
  switch (identity.kind) {
    case "task-run":
      return `task-run:${identity.runId}`;
    case "task-run-failure":
      return `task-run-failure:${identity.runId}`;
    case "local-operation":
      return `local-operation:${identity.operationId}`;
    case "image-baseline":
      return `image-baseline:${identity.baseStorageKey}`;
    case "image-edit":
      return `image-edit:${identity.baseStorageKey}:${identity.editKey}`;
    case "image-project":
      return `image-project:${identity.baseStorageKey}:${identity.projectKey}`;
    case "model-edit":
      return `model-edit:${identity.sourceHash}:${identity.snapshotKey}`;
    case "model-source":
      return `model-source:${identity.sourceHash}`;
  }
}

export function decodeNodeGenerationIdentity(raw: unknown): NodeGenerationSourceIdentity | null {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("task-run-failure:")) {
    const runId = raw.slice("task-run-failure:".length);
    return runId ? { kind: "task-run-failure", runId } : null;
  }
  if (raw.startsWith("local-operation:")) {
    const operationId = raw.slice("local-operation:".length);
    return operationId ? { kind: "local-operation", operationId } : null;
  }
  if (raw.startsWith("task-run:")) {
    const runId = raw.slice("task-run:".length);
    return runId ? { kind: "task-run", runId } : null;
  }
  if (raw.startsWith("image-baseline:")) {
    const baseStorageKey = raw.slice("image-baseline:".length);
    return baseStorageKey ? { kind: "image-baseline", baseStorageKey } : null;
  }
  if (raw.startsWith("image-edit:")) {
    const rest = raw.slice("image-edit:".length);
    const index = rest.indexOf(":");
    if (index <= 0) return null;
    const baseStorageKey = rest.slice(0, index);
    const editKey = rest.slice(index + 1);
    return baseStorageKey && editKey ? { kind: "image-edit", baseStorageKey, editKey } : null;
  }
  if (raw.startsWith("image-project:")) {
    const rest = raw.slice("image-project:".length);
    const index = rest.indexOf(":");
    if (index <= 0) return null;
    const baseStorageKey = rest.slice(0, index);
    const projectKey = rest.slice(index + 1);
    return baseStorageKey && projectKey ? { kind: "image-project", baseStorageKey, projectKey } : null;
  }
  if (raw.startsWith("model-edit:")) {
    const rest = raw.slice("model-edit:".length);
    const index = rest.indexOf(":");
    if (index <= 0) return null;
    const sourceHash = rest.slice(0, index);
    const snapshotKey = rest.slice(index + 1);
    return sourceHash && snapshotKey ? { kind: "model-edit", sourceHash, snapshotKey } : null;
  }
  if (raw.startsWith("model-source:")) {
    const sourceHash = raw.slice("model-source:".length);
    return sourceHash ? { kind: "model-source", sourceHash } : null;
  }
  return null;
}

/**
 * 稳定 entryId：由 `(canvasId, nodeId, sourceIdentity)` 派生。
 *
 * 同一画布同一节点同一生成来源 → 同一 entryId，因此重复事件/轮询补偿/重启重放只登记一次。
 */
export function nodeHistoryEntryId(input: {
  canvasId: string;
  nodeId: string;
  identity: NodeGenerationSourceIdentity;
}): string {
  const raw = `${input.canvasId}\u0000${input.nodeId}\u0000${encodeNodeGenerationIdentity(input.identity)}`;
  return `ngh-${hashText(raw)}`;
}

/**
 * 模型摆放快照 key：对摆放做确定性哈希（分组小数避免浮点噪声）。
 *
 * 同一摆放稳定映射同一 key，因此同一「回退操作」重试命中同一 `model-edit` identity。
 */
export function modelPlacementSnapshotKey(placement: NodeHistoryModelPlacement): string {
  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  return hashText(
    `${round(placement.offset.x)},${round(placement.offset.y)},${round(placement.offset.z)},${round(placement.scale)},${round(placement.yaw)}`
  );
}

/**
 * 图片编辑版本的稳定去重键（change: 图片聚焦编辑，design D4/D5）。
 *
 * 由 base storageKey、源尺寸、规范化 shapes hash 与输出 storageKey 派生。
 */
export function imageEditSnapshotKey(input: {
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  shapesHash: string;
  outputStorageKey: string;
}): string {
  return hashText(
    `${input.baseStorageKey},${input.sourceWidth}x${input.sourceHeight},${input.shapesHash},${input.outputStorageKey}`
  );
}

/**
 * 编辑工程版本的稳定去重键
 * （编辑扩展工作区，design D4/D5）。
 *
 * 由 base storageKey、来源/画布尺寸、定义身份（引擎/格式/文档内容 hash）与输出 storageKey
 * 派生：同一内容重试命中同一 identity，不同图层结构产生不同键。
 */
export function imageProjectSnapshotKey(input: {
  baseStorageKey: string;
  definitionHash: string;
  outputStorageKey: string;
}): string {
  return hashText(`${input.baseStorageKey},${input.definitionHash},${input.outputStorageKey}`);
}

/** 稳定短哈希（djb2）——无外部依赖，跨运行单元一致。 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
