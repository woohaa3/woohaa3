/**
 * 存储 sequence 冲突的自动重发（从 `canvas-session.test.ts` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`canvas-session.test.ts` 曾越过 800 物理行上限。这一组用例
 * 自带一整套 recording socket 与 ready 会话装配，与前面的 epoch 自愈、只读、投影复用
 * 各组不共享夹具，独立成文件后两边的 setup 反而更短。
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  encodeCommandResultMessage,
  encodeStatusMessage,
  encodeSyncMessage,
  serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import type { SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import { CanvasDatabase } from "./canvas-state/index.js";
import { createCanvasSession } from "./canvas-session.js";
import type { CanvasRemoteService } from "../contracts.js";

const NOW = "2026-09-29T00:00:00.000Z";

describe("存储 sequence 冲突自动重发", () => {
  const CONFLICT_CANVAS = "canvas-seq-conflict";

  function recordingSocket() {
    let messageHandler: ((data: Uint8Array) => void) | null = null;
    let closeHandler: (() => void) | null = null;
    const commandIds: string[] = [];
    const socket = {
      send(data: Uint8Array) {
        const decoded = decodeMessage(data);
        if (decoded.type === MESSAGE_TYPE.COMMAND) commandIds.push((decoded.batch as { commandId: string }).commandId);
      },
      close() {
        closeHandler?.();
      },
      onMessage(handler: (data: Uint8Array) => void) {
        messageHandler = handler;
        return () => {
          messageHandler = null;
        };
      },
      onClose(handler: () => void) {
        closeHandler = handler;
        return () => {
          closeHandler = null;
        };
      }
    };
    return {
      socket: socket as unknown as SyncSocket,
      commandIds,
      receive: (data: Uint8Array) => messageHandler?.(data)
    };
  }

  async function readySession() {
    const entry = recordingSocket();
    const remote = {
      openCanvasSession: () => entry.socket,
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;
    const session = await createCanvasSession({
      canvasId: CONFLICT_CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: new IDBFactory() })
    });
    const serverCanvas = createEmptyWoohaa3ServerCanvas(CONFLICT_CANVAS, NOW);
    serverCanvas.revision = 1;
    const serverDoc = serverCanvasToYDoc(serverCanvas);
    entry.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(serverDoc)));
    entry.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
    entry.receive(
      encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: "epoch-1", revision: 1 })
    );
    expect(session.getStatus().phase).toBe("ready");
    return { session, entry };
  }

  const commands = [{ type: "node.add" as const, node: { id: "n1", type: "image" as const, position: { x: 0, y: 0 } } }];
  const conflict = (commandId: string) =>
    encodeCommandResultMessage({
      commandId,
      status: "failed",
      code: "storage-seq-conflict",
      error: "存储 sequence 已变化，请重试"
    });

  it("用同一 commandId 重发一次，最终 accepted 才结算", async () => {
    const { session, entry } = await readySession();
    try {
      const submitted = session.submitCommands(commands, "cmd-conflict");
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      expect(entry.commandIds).toEqual(["cmd-conflict"]);

      // 第一轮冲突：这一轮回执被吞掉，批次仍 pending，调用方不该看到失败。
      entry.receive(conflict("cmd-conflict"));
      expect(entry.commandIds).toEqual(["cmd-conflict", "cmd-conflict"]);
      expect(session.getStatus().remote.pendingCount).toBe(1);
      expect(session.getStatus().error).toBeNull();

      // 服务端重载后重发成功。
      entry.receive(encodeCommandResultMessage({ commandId: "cmd-conflict", status: "accepted", revision: 1 }));
      const settled = await submitted.handle.settled;
      expect(settled.state).toBe("committed");
    } finally {
      session.shutdown();
    }
  });

  it("重发只做一次：再次冲突按失败结算", async () => {
    const { session, entry } = await readySession();
    try {
      const submitted = session.submitCommands(commands, "cmd-still-conflict");
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;

      entry.receive(conflict("cmd-still-conflict"));
      expect(entry.commandIds).toHaveLength(2);

      entry.receive(conflict("cmd-still-conflict"));
      // 不再重发，把真实失败交给调用方。
      expect(entry.commandIds).toHaveLength(2);
      const settled = await submitted.handle.settled;
      expect(settled.state).toBe("rejected");
      expect(settled.error).toContain("存储 sequence");
    } finally {
      session.shutdown();
    }
  });
});
