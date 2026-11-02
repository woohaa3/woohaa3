/**
 * 节点生成历史服务：原子恢复协调器
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * **唯一恢复 owner**：独占恢复前留档（当前模型/图片编辑）、最新状态检查、并发身份校验与
 * 串行提交。恢复不覆盖 prompt/panelParameters/inputMapping；模型恢复保留当前摆放；以稳定
 * operation identity 提交**单个**原子 command batch。禁止在读后异步写导致 TOCTOU。
 */
import {
  decodeImageEditDocument,
  decodeModelPlacement,
  encodeNodeGenerationIdentity,
  hashModelScript,
  imageEditDefinitionHash,
  imageEditShapesHash,
  imageEditShapesOf,
  imageEditSnapshotKey,
  imageProjectSnapshotKey,
  isImageProjectDocument,
  nodeHistoryContentIdentity,
  nodeHistoryEntryId,
  nodeTypesForHistoryKind,
  readFilmSetContent,
  YJS_SYNC_PROTOCOL_VERSION,
  type NodeGenerationHistoryEntry,
  type NodeHistoryMediaPayload,
  type NodeHistoryModelPayload,
  type ServerCanvas
} from "@woohaa3/contracts";
import { CanvasStorageError } from "../errors.js";
import {
  currentNodeStateOf,
  type CurrentNodeState
} from "./current-state.js";
import {
  isMediaResolvable,
  mediaExists
} from "./queries.js";
import { buildRestoreCommands } from "./restore-commands.js";
import {
  readAssetMeta,
  readAssetMetaNumber,
  readAssetStorageKey
} from "./assets.js";
import { readAnimationHistoryPayload, readModelCamerasSnapshot } from "./registration.js";
import type {
  NodeHistoryRestoreOutcome,
  NodeHistoryServiceContext,
  RegisterModelEditInput
} from "./types.js";

export type RestoreDependencies = {
  context: NodeHistoryServiceContext;
  /** 幂等登记一条编辑版本条目（委托给登记协作者，保持 capacity 触发一致）。 */
  registerModelEdit: (input: RegisterModelEditInput) => Promise<{ status: "inserted" | "duplicate"; entryId: string }>;
  /** 按容量策略清理。 */
  enforceCapacity: (canvasId: string, nodeId?: string) => Promise<void>;
};

/**
 * 原子恢复历史版本。
 */
export async function restoreNodeHistory(
  deps: RestoreDependencies,
  input: {
    canvasId: string;
    nodeId: string;
    entryId: string;
    expectedCurrentIdentity?: string;
  }
): Promise<NodeHistoryRestoreOutcome> {
  const { context } = deps;
  const entry = await context.repository.get(input.canvasId, input.nodeId, input.entryId);
  if (!entry) return { ok: false, code: "not-found", message: "历史条目不存在" };

  const room = await context.resolveRoom(input.canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const canvas = exported.canvas;

  const node = canvas.document.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${input.nodeId} 不存在` };
  if (!nodeTypesForHistoryKind(entry.kind).includes(node.type)) {
    return { ok: false, code: "invalid-node-type", message: `节点 ${input.nodeId} 与历史种类不兼容` };
  }
  const data = canvas.nodeData[input.nodeId] as Record<string, unknown> | undefined;

  // 并发保护：调用方认为的当前身份与服务端权威状态不一致时拒绝（不覆盖他人写入）。
  const currentNode = currentNodeStateOf(canvas, input.nodeId, entry.kind, context.content);
  if (input.expectedCurrentIdentity !== undefined && currentNode.identity !== input.expectedCurrentIdentity) {
    return { ok: false, code: "conflict", message: "当前内容已被其它写入改变，恢复被拒绝" };
  }

  // 媒体条目在应用前校验底层对象可解析；缺失即稳定不可恢复。
  if (entry.kind === "image" || entry.kind === "video" || entry.kind === "audio") {
    // 条目自带画布 id：远端画布的字节只在托管存储里，核验必须带作用域。
    const scope = { canvasId: entry.canvasId };
    const recoverable = await isMediaResolvable(context, entry.payload as NodeHistoryMediaPayload, scope);
    if (!recoverable) {
      if (entry.recoverable) {
        await context.repository.markUnrecoverable(entry.canvasId, entry.nodeId, entry.entryId);
      }
      return { ok: false, code: "unrecoverable", message: "历史媒体对象已不可用" };
    }
    // 图片编辑版本：必需原图缺失时明确区分预览可用与编辑/恢复不可用（design D6）。
    if (entry.kind === "image" && (entry.payload as NodeHistoryMediaPayload).imageEdit) {
      const media = entry.payload as NodeHistoryMediaPayload;
      if (!media.base || !(await mediaExists(context, media.base.storageKey, scope))) {
        if (entry.recoverable) {
          await context.repository.markUnrecoverable(entry.canvasId, entry.nodeId, entry.entryId);
        }
        return { ok: false, code: "unrecoverable", message: "图片编辑所需原图已不可用，无法恢复可编辑版本" };
      }
      // 工程版本：工程对象与 PNG 成对；工程缺失时拒绝**部分恢复**（design D6）。
      if (media.project) {
        if (!(await mediaExists(context, media.project.storageKey, scope))) {
          if (entry.recoverable) {
            await context.repository.markUnrecoverable(entry.canvasId, entry.nodeId, entry.entryId);
          }
          return { ok: false, code: "unrecoverable", message: "图片工程对象已不可用，无法恢复可编辑版本" };
        }
      }
    }
  }

  if (entry.kind === "model" && (entry.payload as NodeHistoryModelPayload).animation?.schemaVersion === 3) {
    return { ok: false, code: "unrecoverable", message: "旧片场历史须先完成离线迁移" };
  }
  const alreadyCurrent = currentNode.identity !== null && entryMatchesCurrentIdentity(entry, currentNode);
  if (alreadyCurrent) {
    return { ok: true, revision: canvas.revision, entryId: entry.entryId, alreadyCurrent: true };
  }

  const built = buildRestoreCommands(input.nodeId, entry);
  if (!built.ok) return built;

  // 模型回退留档：把即将被替换的当前模型状态存为一条编辑版本。
  if (entry.kind === "model") {
    await snapshotCurrentModelEdit(deps, input.canvasId, input.nodeId, data);
  }
  // 图片回退留档：当前图片带编辑定义时，先把即将被替换的当前编辑版本留档。
  if (entry.kind === "image") {
    await snapshotCurrentImageEdit(deps, input.canvasId, input.nodeId, canvas, data);
  }

  // 回到同一内容后再次恢复是新操作；修订号区分这次操作与以前的 durable 回执。
  const operationId = `nghr:${entry.entryId}:${canvas.revision}:${hashModelScript(currentNode.identity ?? "none")}`;
  const result = await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: input.canvasId,
    commandId: operationId,
    baseRevision: canvas.revision,
    actorId: "canvas-node-history",
    commands: built.commands
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  // 恢复成功后按容量策略清理（保护已变为当前的版本）。
  await deps.enforceCapacity(input.canvasId, input.nodeId);
  return { ok: true, revision: result.revision, entryId: entry.entryId, alreadyCurrent: false };
}

function entryMatchesCurrentIdentity(entry: NodeGenerationHistoryEntry, current: CurrentNodeState): boolean {
  return current.identity !== null && entry.currentIdentity === current.identity;
}

/**
 * 把当前模型状态留档为编辑版本（change: 模型编辑历史）。
 *
 * 返回非 null 为占用删除保护的当前状态。
 */
export async function snapshotCurrentModelEdit(
  deps: RestoreDependencies,
  canvasId: string,
  nodeId: string,
  data: Record<string, unknown> | undefined
): Promise<{ status: "inserted" | "duplicate"; entryId: string } | null> {
  // items-only 片场没有顶层模型脚本；其完整当前版本由片段/内容定义身份留档（D8/D10）。
  // 因此先读动画 payload，再决定是否需要顶层脚本字段。
  const animation = readAnimationHistoryPayload(data, deps.context.content);
  const modelItem = data?.filmSetContent !== undefined && data.filmSetContent !== null
    ? readFilmSetContent(data).items.find((item) => item.kind === "model")
    : undefined;
  const modelScript = animation !== null
    ? (modelItem?.model.modelScript ?? "")
    : (typeof data?.modelScript === "string" ? data.modelScript : "");
  if (animation === null && modelScript.trim() === "") return null;
  const language = animation !== null
    ? (modelItem?.model.modelScriptLanguage ?? "")
    : (typeof data?.modelScriptLanguage === "string" ? data.modelScriptLanguage : "");
  const version = animation !== null
    ? (modelItem?.model.modelScriptVersion ?? "")
    : (typeof data?.modelScriptVersion === "string" ? data.modelScriptVersion : "");
  if (animation === null && (language === "" || version === "")) return null;
  const placement = decodeModelPlacement(data?.modelPlacement) ?? { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
  const modelCameras = readModelCamerasSnapshot(data);
  try {
    return await deps.registerModelEdit({
      canvasId,
      nodeId,
      sourceHash: hashModelScript(modelScript),
      modelScript,
      language,
      version,
      placement,
      ...(modelCameras ? { modelCameras } : {}),
      ...(animation ? { animation } : {}),
      createdAt: deps.context.now()
    });
  } catch {
    // 留档失败不应阻断权威恢复。
    return null;
  }
}

/**
 * 把当前图片编辑状态留档为编辑版本（change: 图片聚焦编辑，design D8）。
 */
export async function snapshotCurrentImageEdit(
  deps: RestoreDependencies,
  canvasId: string,
  nodeId: string,
  canvas: ServerCanvas,
  data: Record<string, unknown> | undefined
): Promise<void> {
  if (!data || data.imageEdit === undefined || data.imageEdit === null) return;
  const decoded = decodeImageEditDocument(data.imageEdit);
  if (!decoded.ok) return;
  const doc = decoded.value;
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  const outputAsset = canvas.assets.find((candidate) => candidate.id === outputId);
  const outputStorageKey = readAssetStorageKey(outputAsset);
  const baseAsset = canvas.assets.find((candidate) => candidate.id === doc.baseAssetId);
  const baseStorageKey = readAssetStorageKey(baseAsset);
  if (!outputStorageKey || !baseStorageKey) {
    throw new CanvasStorageError("NODE_HISTORY_UNRECOVERABLE", "当前图片缺少稳定原图/输出引用");
  }
  const isProject = isImageProjectDocument(doc);
  const identity = isProject
    ? {
        kind: "image-project" as const,
        baseStorageKey,
        projectKey: imageProjectSnapshotKey({
          baseStorageKey,
          definitionHash: imageEditDefinitionHash(doc),
          outputStorageKey
        })
      }
    : {
        kind: "image-edit" as const,
        baseStorageKey,
        editKey: imageEditSnapshotKey({
          baseStorageKey,
          sourceWidth: doc.sourceWidth,
          sourceHeight: doc.sourceHeight,
          shapesHash: imageEditShapesHash({ shapes: imageEditShapesOf(doc) }),
          outputStorageKey
        })
      };
  const payload: NodeHistoryMediaPayload = {
    kind: "image",
    storageKey: outputStorageKey,
    checksum: readAssetMeta(outputAsset, "checksum") ?? "",
    contentType: readAssetMeta(outputAsset, "contentType") ?? "image/png",
    size: readAssetMetaNumber(outputAsset, "size") ?? 0,
    base: {
      baseAssetId: doc.baseAssetId,
      storageKey: baseStorageKey,
      checksum: readAssetMeta(baseAsset, "checksum") ?? "",
      contentType: readAssetMeta(baseAsset, "contentType") ?? "image/png",
      size: readAssetMetaNumber(baseAsset, "size") ?? 0,
      sourceWidth: doc.sourceWidth,
      sourceHeight: doc.sourceHeight
    },
    imageEdit: doc,
    ...(isProject ? { project: doc.project } : {})
  };
  await deps.context.repository.insert({
    version: "woohaa-node-generation-history-v1",
    entryId: nodeHistoryEntryId({ canvasId, nodeId, identity }),
    canvasId,
    nodeId,
    kind: "image",
    createdAt: deps.context.now(),
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: nodeHistoryContentIdentity(payload),
    recoverable: true,
    previewable: true,
    source: { label: isProject ? "图像工程" : "图片编辑" },
    payload
  });
}
