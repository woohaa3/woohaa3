/**
 * 片场对象级权威写入服务
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3 / design D6）。
 *
 * 从**最新权威集合**读取对应 item 并原子更新，经 group marker / binding 命令提交。不按数组
 * 序号定位，也不用客户端旧完整数组覆盖其他项。稳定 requestId 保证重试幂等；对象存在性、
 * kind、schema、目标内容 precondition 由 reducer 统一校验。
 *
 * 复用既有 `CanvasAuthority.submitDerived`，与 `FilmSetImportService` 同一模式。
 */
import type { CanvasAuthority } from "@woohaa3/contracts";
import type { CanvasCommand, FilmSetItemPatchOp, ServerCanvas } from "@woohaa3/contracts";
import { filmSetGroupBindingPatchCommand, filmSetNodeDataFields, readFilmSetAnimationProjection, readFilmSetGroupMarker, filmSetContentHash } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

export type FilmSetItemCommandInput = {
  canvasId: string;
  requestId: string;
  nodeId: string;
  itemId: string;
  op: FilmSetItemPatchOp;
  /** 只读/历史等上层门禁已判定；此处只做权威内容 precondition。 */
  expectedContentHash?: string;
};

export type FilmSetItemCommandOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      itemId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      contentHash: string;
      itemCount: number;
    }
  | { ok: false; code: string; message: string };

export type FilmSetItemServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  now?: () => string;
  actorId?: string;
};

export class FilmSetItemService {
  private readonly deps: FilmSetItemServiceDependencies;
  private readonly actorId: string;

  constructor(deps: FilmSetItemServiceDependencies) {
    this.deps = deps;
    this.actorId = deps.actorId ?? "canvas-model-mcp";
  }

  /** 原子更新单个片场对象。 */
  async mutate(input: FilmSetItemCommandInput): Promise<FilmSetItemCommandOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    const nodeId = input.nodeId?.trim() ?? "";
    const itemId = input.itemId?.trim() ?? "";
    const requestId = input.requestId?.trim() ?? "";
    if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
    if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
    if (itemId === "") return { ok: false, code: "malformed-request", message: "itemId 不能为空" };
    if (requestId === "") return { ok: false, code: "malformed-request", message: "requestId 不能为空" };

    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    const commandId = `film-set-item:${canvasId}:${nodeId}:${itemId}:${requestId}`;
    const result = await room.submitDerived({
      commandId,
      derive: (canvas) => {
        const derived = this.deriveItemCommand(canvas, input);
        if (!derived.ok) return derived;
        return {
          ok: true,
          batch: buildBatch(canvasId, commandId, this.actorId, canvas.revision, derived.commands)
        };
      }
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const latest = room.exportCanvas();
    if (!latest.ok) return { ok: false, code: "canvas-unavailable", message: latest.message };
    const projection = readFilmSetAnimationProjection(latest.canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场资源无法解析" };
    const animation = { value: projection };
    return {
      ok: true,
      canvasId,
      nodeId,
      itemId,
      commandId,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      contentHash: filmSetContentHash(animation.value.filmSetContent),
      itemCount: animation.value.filmSetContent.items.length
    };
  }

  /** 在最新权威画布上做内容 precondition 并派生 group marker / binding 命令。 */
  private deriveItemCommand(
    canvas: ServerCanvas,
    input: FilmSetItemCommandInput
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    const node = canvas.document.nodes.find((entry) => entry.id === input.nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${input.nodeId} 不存在` };
    const marker = node.type === "group" ? readFilmSetGroupMarker(canvas.nodeData[input.nodeId]) : null;
    if (!marker) {
      return { ok: false, code: "invalid-node-type", message: `节点 ${input.nodeId} 不是片场` };
    }
    const projection = readFilmSetAnimationProjection(canvas, input.nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场资源无法解析" };
    const animation = { value: projection };
    if (input.expectedContentHash && filmSetContentHash(animation.value.filmSetContent) !== input.expectedContentHash) {
      return { ok: false, code: "stale-content", message: "片场内容已被并发修改" };
    }
    const item = animation.value.filmSetContent.items.find((entry) => entry.id === input.itemId);
    if (!item) return { ok: false, code: "unknown-item", message: `片场对象 ${input.itemId} 不存在` };
    if (input.itemId === "film-set-ground" && marker.ground) {
      if (input.op.kind === "replace-model") return { ok: false, code: "invalid-item-kind", message: "地面不支持模型替换" };
      const next = { ...marker };
      if (input.op.kind === "delete") delete next.ground;
      else {
        const expected = input.op.expectedLocalTransform;
        if (expected && JSON.stringify(item.localTransform) !== JSON.stringify(expected)) return { ok: false, code: "stale-transform", message: "地面变换已被修改" };
        const t = input.op.localTransform;
        next.ground = { ...marker.ground, transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale } };
      }
      return { ok: true, commands: [{ type: "nodeData.patch", nodeId: input.nodeId, value: { filmSetGroup: next } }] };
    }
    const binding = marker.sceneBindings.find(binding => binding.bindingId === input.itemId);
    if (!binding) return { ok: false, code: "unknown-item", message: "对象绑定不存在" };
    if (input.op.kind === "replace-model") return { ok: false, code: "edit-source-required", message: "请编辑来源资源卡片" };
    if (input.op.kind === "delete") return { ok: true, commands: [{ type: "nodeData.patch", nodeId: input.nodeId, value: { filmSetGroup: { ...marker, sceneBindings: marker.sceneBindings.filter(entry => entry.bindingId !== input.itemId), clips: marker.clips?.map(clip => ({ ...clip, bindings: clip.bindings?.filter(entry => entry.itemId !== input.itemId) })) } } as import("@woohaa3/contracts").CanvasNodeData }] };
    const t = input.op.localTransform;
    const expected = input.op.expectedLocalTransform;
    if (expected && JSON.stringify(item.localTransform) !== JSON.stringify(expected)) return { ok: false, code: "stale-transform", message: "对象变换已被修改" };
    return { ok: true, commands: [filmSetGroupBindingPatchCommand({ groupId: input.nodeId, bindingId: input.itemId, patch: { transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale } } })] };
  }
}

function buildBatch(
  canvasId: string,
  commandId: string,
  actorId: string,
  baseRevision: number,
  commands: CanvasCommand[]
): CanvasCommandBatch {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, baseRevision, actorId, commands };
}

/** 便捷构造：对象摆放更新命令。 */
export function filmSetItemTransformOp(input: {
  op: Extract<FilmSetItemPatchOp, { kind: "transform" }>;
}): FilmSetItemPatchOp {
  return input.op;
}

export { filmSetNodeDataFields };
