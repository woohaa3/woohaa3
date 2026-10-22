/**
 * 片场 MCP 能力端口实现（`ContentMcpRuntime`）
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主 MCP 能力面只传协议 DTO；这里负责 DTO → 片场领域输入（`CreateFilmSetInput` 等）的适配，
 * 再调用片场领域服务。适配逻辑原先写在 canvas-service 的 composition 里，属于片场领域知识，归扩展。
 */
import type {
  ContentMcpRuntime,
  FilmSetNodeData,
  FilmSetNodeOutcome,
  ImportFilmSetContentOutcome,
  McpCommitAnimationRequest,
  McpConfirmAdaptationRequest,
  McpCreateFilmSetNodeRequest,
  McpImportFilmSetContentRequest,
  McpImportModelSnapshotRequest,
  McpMutateFilmSetItemRequest,
  MutateFilmSetItemOutcome,
  ReadFilmSetOutcome,
  SupportedModelScriptVersion
} from "@woohaa3/contracts";
import { FilmSetImportService, type FilmSetImportRequestItem } from "./film-set-import.js";
import { FilmSetItemService } from "./film-set-item.js";
import { FilmSetNodeService } from "./service.js";

export type { FilmSetNodeOutcome, ImportFilmSetContentOutcome, MutateFilmSetItemOutcome, ReadFilmSetOutcome };

export const filmSetMcpRuntime: ContentMcpRuntime = {
  createNodeService(deps) {
    const service = new FilmSetNodeService(deps);
    return {
      async createNode(request: McpCreateFilmSetNodeRequest): Promise<FilmSetNodeOutcome> {
        if (request.sourceNodeId) {
          return service.createFilmSetFromNode({
            canvasId: request.canvasId,
            requestId: request.requestId,
            nodeId: request.nodeId,
            position: request.position ?? { x: 0, y: 0 },
            sourceNodeId: request.sourceNodeId,
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.motionScript === undefined ? {} : { motionScript: request.motionScript }),
            ...(request.timeline === undefined ? {} : { timeline: request.timeline })
          });
        }
        return service.createFilmSet({
          canvasId: request.canvasId,
          requestId: request.requestId,
          nodeId: request.nodeId,
          position: request.position ?? { x: 0, y: 0 },
          model: {
            modelScript: request.model.modelScript,
            modelScriptVersion: request.model.modelScriptVersion as SupportedModelScriptVersion,
            ...(request.model.placement ? { placement: request.model.placement } : {})
          },
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.motionScript === undefined ? {} : { motionScript: request.motionScript }),
          ...(request.timeline === undefined ? {} : { timeline: request.timeline })
        });
      },
      importModelSnapshot(request: McpImportModelSnapshotRequest): Promise<FilmSetNodeOutcome> {
        return service.importModel({
          canvasId: request.canvasId,
          requestId: request.requestId,
          nodeId: request.nodeId,
          itemId: request.itemId,
          modelScript: request.modelScript,
          modelScriptVersion: request.modelScriptVersion as SupportedModelScriptVersion,
          ...(request.placement ? { placement: request.placement } : {}),
          ...(request.expectedSourceHash ? { expectedSourceHash: request.expectedSourceHash } : {})
        });
      },
      commitAnimation(request: McpCommitAnimationRequest): Promise<FilmSetNodeOutcome> {
        return service.commitFilmSet({
          canvasId: request.canvasId,
          nodeId: request.nodeId,
          requestId: request.requestId,
          animation: request.animation as FilmSetNodeData,
          ...(request.clipId ? { clipId: request.clipId } : {}),
          ...(request.expectedClipHash ? { expectedClipHash: request.expectedClipHash } : {}),
          ...(request.expectedSnapshotHash ? { expectedSnapshotHash: request.expectedSnapshotHash } : {}),
          ...(request.title === undefined ? {} : { title: request.title })
        });
      },
      confirmAdaptation(request: McpConfirmAdaptationRequest): Promise<FilmSetNodeOutcome> {
        return service.confirmAdaptation({
          canvasId: request.canvasId,
          nodeId: request.nodeId,
          requestId: request.requestId,
          clipId: request.clipId,
          itemId: request.itemId,
          expectedAdapterHash: request.expectedAdapterHash,
          ...(request.expectedSnapshotHash ? { expectedSnapshotHash: request.expectedSnapshotHash } : {})
        });
      },
      readAnimation(request: { canvasId: string; nodeId: string }): Promise<ReadFilmSetOutcome> {
        return service.readNodeFilmSet(request);
      }
    };
  },
  createImportService(deps) {
    const service = new FilmSetImportService(deps);
    return {
      importContent(request: McpImportFilmSetContentRequest): Promise<ImportFilmSetContentOutcome> {
        return service.import({
          canvasId: request.canvasId,
          requestId: request.requestId,
          nodeId: request.nodeId,
          items: request.items as FilmSetImportRequestItem[]
        });
      }
    };
  },
  createItemService(deps) {
    const service = new FilmSetItemService(deps);
    return {
      mutateItem(request: McpMutateFilmSetItemRequest): Promise<MutateFilmSetItemOutcome> {
        return service.mutate({
          canvasId: request.canvasId,
          requestId: request.requestId,
          nodeId: request.nodeId,
          itemId: request.itemId,
          op: request.op
        });
      }
    };
  }
};
