/**
 * 片场对象级权威写入服务
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3 / design D6）。
 *
 * 从**最新权威集合**读取对应 item 并原子更新，经共享 `filmSet.itemPatch` 命令提交。不按数组
 * 序号定位，也不用客户端旧完整数组覆盖其他项。稳定 requestId 保证重试幂等；对象存在性、
 * kind、schema、目标内容 precondition 由 reducer 统一校验。
 *
 * 复用既有 `CanvasAuthority.submitDerived`，与 `FilmSetImportService` 同一模式。
 */
import type { CanvasAuthority } from "@woohaa3/contracts";
import type {
  CanvasCommand,
  CanvasNodeData,
  FilmSetItemPatchOp,
  ServerCanvas
} from "@woohaa3/contracts";
import {
  filmSetNodeDataFields,
  decodeFilmSetNodeData,
  filmSetContentHash,
  isFilmSetNode
} from "@woohaa3/contracts";
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
    const animation = decodeFilmSetNodeData(latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined);
    if (!animation.ok) return { ok: false, code: "invalid-animation-node", message: animation.reason };
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

  /** 在最新权威画布上做内容 precondition 并派生一条 `filmSet.itemPatch` 命令。 */
  private deriveItemCommand(
    canvas: ServerCanvas,
    input: FilmSetItemCommandInput
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    const node = canvas.document.nodes.find((entry) => entry.id === input.nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${input.nodeId} 不存在` };
    if (!isFilmSetNode(node.type, canvas.nodeData[input.nodeId])) {
      return { ok: false, code: "invalid-node-type", message: `节点 ${input.nodeId} 不是片场` };
    }
    const animation = decodeFilmSetNodeData(canvas.nodeData[input.nodeId] as CanvasNodeData | undefined);
    if (!animation.ok) return { ok: false, code: "invalid-animation-node", message: animation.reason };
    if (input.expectedContentHash && filmSetContentHash(animation.value.filmSetContent) !== input.expectedContentHash) {
      return { ok: false, code: "stale-content", message: "片场内容已被并发修改" };
    }
    const item = animation.value.filmSetContent.items.find((entry) => entry.id === input.itemId);
    if (!item) return { ok: false, code: "unknown-item", message: `片场对象 ${input.itemId} 不存在` };
    // reducer 会再次原子校验；这里只保证命令结构合法并保留 precondition。
    return {
      ok: true,
      commands: [{ type: "filmSet.itemPatch", nodeId: input.nodeId, itemId: input.itemId, op: input.op }]
    };
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
