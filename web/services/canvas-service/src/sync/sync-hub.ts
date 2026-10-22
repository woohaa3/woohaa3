/**
 * Canvas Session hub：把 room 的广播与任务活动增量扇出到该 canvas 的所有会话
 * （change: unify-canvas-session-websocket，任务 2.2 / 2.3 / 3.3；原 Yjs 专用 sync hub）。
 *
 * room 只发出**一条** durable update；hub 负责投递给所有已连接会话。这样：
 * - 「本页提交、远端收敛」由同一条 update 驱动（spec 场景）；
 * - 被拒绝的命令不产生 update，因此不广播（spec 场景）。
 *
 * 会话与 room 是 N:1：同一 canvas 可以有多个浏览器连接。任务活动记录同样只由 hub
 * 按 canvasId 扇出到**订阅了 task-activity 通道**的会话（spec「只向同 canvas 订阅 session
 * 扇出」）。
 */
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import type { CanvasRoomRegistry } from "./room-registry.js";

/**
 * hub 能驱动的会话最小形状。
 *
 * `CanvasSyncSession`（纯 Yjs）与 `CanvasSession`（Canvas Session）都满足；这样单元测试
 * 可以直接注册 Yjs 会话，而生产注册完整 session。
 */
export type CanvasSessionBroadcastTarget = {
  broadcastUpdate(update: Uint8Array, revision: number): void;
  receiveActivityRecord?(record: CanvasTaskActivity, cursor: number): void;
  /** 关闭物理传输；Yjs 会话用 `(reason)`，Canvas Session 用 `(code, reason)`。 */
  close(codeOrReason?: number | string, reason?: string): void;
};

export type SessionSessionFactory = (input: {
  room: Awaited<ReturnType<CanvasRoomRegistry["acquire"]>>["room"];
  actorId: string;
  clientProtocolVersion: number;
  clientFormatVersion: string;
  clientRoomEpoch: string | null;
  clientStateVector: Uint8Array;
  correlationId: string;
}) => CanvasSessionBroadcastTarget;

/**
 * 会话注册表。
 *
 * hub 自己不创建 socket：它只知道「哪个 canvas 有哪些会话」，以及如何把 update / 活动记录
 * 投递给它们。具体连接由 transport 层（`ws`）创建后注册进来。
 */
export class CanvasSessionHub {
  private readonly sessionsByCanvas = new Map<string, Set<CanvasSessionBroadcastTarget>>();

  register(canvasId: string, session: CanvasSessionBroadcastTarget): () => void {
    const set = this.sessionsByCanvas.get(canvasId) ?? new Set<CanvasSessionBroadcastTarget>();
    set.add(session);
    this.sessionsByCanvas.set(canvasId, set);
    return () => {
      set.delete(session);
      if (set.size === 0) this.sessionsByCanvas.delete(canvasId);
    };
  }

  /** 某 canvas 的会话数（测试/指标用）。 */
  sessionCount(canvasId: string): number {
    return this.sessionsByCanvas.get(canvasId)?.size ?? 0;
  }

  /**
   * 扇出一条 durable update。
   *
   * 由 room 的 broadcast 回调驱动：只有持久化成功才会到这里。
   */
  broadcast(input: { canvasId: string; update: Uint8Array; revision: number }): void {
    const sessions = this.sessionsByCanvas.get(input.canvasId);
    if (!sessions) return;
    for (const session of sessions) {
      session.broadcastUpdate(input.update, input.revision);
    }
  }

  /**
   * 扇出一条已持久化的画布任务活动记录。
   *
   * 只投递给实现了 `receiveActivityRecord` 的会话（完整 Canvas Session）；未订阅
   * `task-activity` 通道的会话自行忽略。cursor 单调，重复投递幂等。
   */
  publishActivity(input: { canvasId: string; record: CanvasTaskActivity; cursor: number }): void {
    const sessions = this.sessionsByCanvas.get(input.canvasId);
    if (!sessions) return;
    for (const session of sessions) {
      session.receiveActivityRecord?.(input.record, input.cursor);
    }
  }

  /** 关闭某 canvas 的全部会话（切换/回滚时使用）。 */
  closeCanvas(canvasId: string, reason = "canvas-closing"): void {
    const sessions = this.sessionsByCanvas.get(canvasId);
    if (!sessions) return;
    for (const session of sessions) {
      session.close(1000, reason);
    }
    this.sessionsByCanvas.delete(canvasId);
  }

  /** 关闭全部会话（进程退出）。 */
  closeAll(reason = "server-shutdown"): void {
    for (const canvasId of [...this.sessionsByCanvas.keys()]) {
      this.closeCanvas(canvasId, reason);
    }
  }
}

/**
 * 把 room registry 的 broadcast 回调接到 hub 上。
 *
 * 调用一次即可；registry 创建的每个 room 都会通过这里扇出。
 */
export function connectRegistryBroadcast(hub: CanvasSessionHub) {
  return ({ room, update, revision }: {
    room: { canvasId: string };
    update: Uint8Array;
    revision: number;
  }): void => {
    hub.broadcast({ canvasId: room.canvasId, update, revision });
  };
}
