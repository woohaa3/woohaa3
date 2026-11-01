/**
 * 节点生成历史服务：恢复命令构造
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * 把历史条目转换为单批 `CanvasCommand`；不读取/写入任何状态（纯函数），
 * 由恢复协调器在同一原子批次内提交。
 */
import {
  type CanvasCommand,
  type NodeGenerationHistoryEntry,
  type NodeHistoryMediaPayload,
  type NodeHistoryModelPayload,
  type NodeHistoryTextPayload
} from "@woohaa3/contracts";
import { imageEditBaseAssetFor, mediaAssetFor, posterAssetFor, textAssetFor } from "./assets.js";

export type RestoreCommandsBuild =
  | { ok: true; commands: CanvasCommand[] }
  | { ok: false; code: string; message: string };

export function buildRestoreCommands(
  nodeId: string,
  entry: NodeGenerationHistoryEntry
): RestoreCommandsBuild {
  if (entry.kind === "model") {
    const payload = entry.payload as NodeHistoryModelPayload;
    // 片场 items-only 历史版本：完整恢复独立根 + 共享 items + 全部 clips；不写顶层模型字段。
    if (payload.animation?.schemaVersion === 4) {
      return { ok: true, commands: [{ type: "nodeData.patch", nodeId, value: {
        filmSetGroup: payload.animation.filmSetGroup,
        activeRunId: `history:${entry.entryId}`,
        taskStatus: "successed",
        progress: 100,
        error: null,
        errorMessage: null
      } as import("@woohaa3/contracts").CanvasNodeData }] };
    }
    if (payload.animation?.schemaVersion === 3) {
      return { ok: false, code: "unrecoverable", message: "旧片场历史须先完成离线迁移" };
    }
    if (payload.modelScript.trim() === "") return { ok: false, code: "unrecoverable", message: "历史模型脚本为空" };
    // 普通模型节点版本：写回模型脚本/摆放/镜头。
    return {
      ok: true,
      commands: [
        {
          type: "nodeData.patch",
          nodeId,
          value: {
            modelScript: payload.modelScript,
            modelScriptLanguage: payload.language,
            modelScriptVersion: payload.version,
            modelScriptStatus: "ok",
            modelScriptError: null,
            activeRunId: `history:${entry.entryId}`,
            taskStatus: "successed",
            progress: 100,
            error: null,
            errorMessage: null,
            // 编辑版本携带摆放则写回；生成版本不携带，保留当前摆放（既有语义）。
            ...(payload.placement ? { modelPlacement: payload.placement } : {}),
            // 可选规范镜头快照：携带时写回；旧条目缺省保留当前镜头，不伪造。
            ...(payload.modelCameras ? { modelCameras: payload.modelCameras } : {})
          }
        }
      ]
    };
  }
  if (entry.kind === "text") {
    const payload = entry.payload as NodeHistoryTextPayload;
    const asset = textAssetFor(entry, payload.text);
    return {
      ok: true,
      commands: [
        { type: "asset.upsert", asset },
        {
          type: "nodeData.patch",
          nodeId,
          value: {
            outputAssetId: asset.id,
            resourceKind: "text",
            activeRunId: `history:${entry.entryId}`,
            taskStatus: "successed",
            progress: 100,
            error: null,
            errorMessage: null,
            result: { kind: "text", text: payload.text }
          }
        }
      ]
    };
  }
  const payload = entry.payload as NodeHistoryMediaPayload;
  const asset = mediaAssetFor(entry, payload);
  const posterAsset = payload.poster ? posterAssetFor(entry, payload.poster) : undefined;
  // 图片编辑版本：同时写回稳定原图引用、输出与严格编辑定义；纯媒体版本显式清除旧编辑定义。
  const editAssets: CanvasCommand[] = [];
  let imageEditPatch: Record<string, unknown> = {};
  if (entry.kind === "image") {
    if (payload.imageEdit && payload.base) {
      const baseAsset = imageEditBaseAssetFor(payload.base);
      if (baseAsset.id !== asset.id) editAssets.push({ type: "asset.upsert", asset: baseAsset });
      imageEditPatch = { imageEdit: payload.imageEdit };
    } else {
      imageEditPatch = { imageEdit: null };
    }
  }
  return {
    ok: true,
    commands: [
      { type: "asset.upsert", asset },
      ...editAssets,
      ...(posterAsset ? [{ type: "asset.upsert", asset: posterAsset } as CanvasCommand] : []),
      {
        type: "nodeData.patch",
        nodeId,
        value: {
          outputAssetId: asset.id,
          resourceKind: payload.kind,
          activeRunId: `history:${entry.entryId}`,
          taskStatus: "successed",
          progress: 100,
          error: null,
          errorMessage: null,
          ...(posterAsset ? { posterAssetId: posterAsset.id } : {}),
          ...(payload.durationSeconds !== undefined ? { durationSeconds: payload.durationSeconds } : {}),
          ...imageEditPatch
        }
      }
    ]
  };
}
