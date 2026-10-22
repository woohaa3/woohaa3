import { furnaceUploadFile } from "./upload-file.js";
import type { CanvasRuntimeService, CanvasStoreFacade, CanvasCommandsService, CanvasEditService, ApplicationRemoteService, MediaRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { createHighEntropyId, getWoohaa3CanvasNodeAbsolutePosition, type CanvasCommand, type ServerCanvas, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { isGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE } from "../geometry.js";
import { planUploadedResourceCollection, type UploadedFileMedia } from "../collection.js";
import { createGameFurnaceRemote, remoteFailureMessage } from "./remote.js";
import { reportGameFurnace } from "./feedback.js";

type FileDropContext = { slots: SlotsService; canvasRuntime: CanvasRuntimeService; canvasState: CanvasStoreFacade;
  canvasCommands: CanvasCommandsService; canvasEdit: CanvasEditService; applicationRemote: ApplicationRemoteService; mediaRemote: MediaRemoteService };

/** Files over the actual furnace are copied into its project, not imported as new canvas nodes. */
export function extendGameFurnaceFileDrop(ctx: FileDropContext): () => void {
  const remote = createGameFurnaceRemote({ transport: ctx.applicationRemote.transport });
  let disposed = false;
  const targetAt = (event: DragEvent) => {
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    const point = ctx.canvasRuntime.clientToWorld({ x: event.clientX, y: event.clientY });
    if (!canvas || !point) return null;
    const nodes = new Map(canvas.document.nodes.map(node => [node.id, { ...node, data: {} }]));
    const hit = [...canvas.document.nodes].reverse().filter(node => node.type !== "group")
      .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0)).find(node => {
        const position = getWoohaa3CanvasNodeAbsolutePosition({ ...node, data: {} } as never, nodes as never);
        return point.x >= position.x && point.y >= position.y && point.x <= position.x + (node.width ?? 196) && point.y <= position.y + (node.height ?? 64);
      });
    return hit?.type === GAME_FURNACE_NODE_TYPE && isGameFurnaceNodeData(canvas.nodeData[hit.id]) ? { canvas, nodeId: hit.id } : null;
  };
  const collect = async (canvas: ServerCanvas, nodeId: string, files: readonly File[]) => {
    const captured = JSON.stringify(canvas.nodeData[nodeId]);
    const current = () => {
      const latest = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
      return !disposed && ctx.canvasCommands.isWritable() && latest?.id === canvas.id
        && latest.document.nodes.some(node => node.id === nodeId && node.type === GAME_FURNACE_NODE_TYPE)
        && JSON.stringify(latest.nodeData[nodeId]) === captured ? latest : null;
    };
    const operations: Woohaa3CanvasJsonObject[] = [];
    for (const file of files) {
      reportGameFurnace(`正在上传素材：${file.name}`);
      const uploaded = await ctx.mediaRemote.upload({ file: furnaceUploadFile(file), onProgress: percent => { if (!disposed) reportGameFurnace(`正在上传 ${file.name}：${percent}%`); } });
      if (!uploaded.ok) throw Error(uploaded.error);
      if (!current()) throw Error("画布、节点或项目已改变，未关联上传素材");
      const media: UploadedFileMedia = uploaded.media;
      const plan = planUploadedResourceCollection({ resourceId: createHighEntropyId("res-upload"), assetId: `asset-upload-${media.checksum}`, file: { name: file.name, type: file.type, size: file.size }, media });
      if (!plan) throw Error("上传结果不完整，未关联素材");
      operations.push(...plan.operations);
    }
    const assetCommands = operations.filter(operation => operation.type === "asset.upsert") as unknown as CanvasCommand[];
    const expectedKey = canvas.nodeData[nodeId]?.projectStorageKey;
    const result = await remote.collectResources({ canvasId: canvas.id, nodeId, operations: operations.filter(operation => operation.type !== "asset.upsert") as never,
      ...(typeof expectedKey === "string" ? { expectedProjectStorageKey: expectedKey } : {}) });
    if (!result.ok) throw Error(remoteFailureMessage(result));
    const latest = current();
    if (!latest) throw Error("画布、节点或项目已改变，未写回素材关联");
    const saved = await ctx.canvasEdit.record([...assetCommands, { type: "nodeData.patch", nodeId, value: { ...latest.nodeData[nodeId], projectStorageKey: result.value.projectStorageKey, inputHash: result.value.inputHash } as never }], "向炼丹炉添加文件");
    if (!saved.ok) throw Error(saved.reason);
    reportGameFurnace(`已添加 ${files.length} 项文件素材`);
  };
  const remove = ctx.slots.register("input.drop", { id: "game-furnace-files", owner: "game-furnace", priority: -10,
    canAccept: event => !!event.dataTransfer?.types.includes("Files") && !!targetAt(event),
    handle: event => {
      const target = targetAt(event); const files = [...(event.dataTransfer?.files ?? [])];
      if (!target || !files.length) return false;
      if (!ctx.canvasCommands.isWritable()) { reportGameFurnace("只读画布不能添加文件素材"); return true; }
      void collect(target.canvas, target.nodeId, files).catch(error => { if (!disposed) reportGameFurnace(`添加文件失败：${error instanceof Error ? error.message : "上传失败"}`); });
      return true;
    } });
  return () => { disposed = true; remove(); };
}
