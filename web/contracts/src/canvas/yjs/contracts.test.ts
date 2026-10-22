/**
 * 共享契约测试（任务 1.4 / 1.5）。
 *
 * 覆盖：格式/版本常量、稳定排序、命令批次解码（含协议版本与 commandId）、
 * payload 哈希规范化，以及协议编解码的 round-trip / 未知类型 / 畸形输入。
 */
import { describe, expect, it } from "vitest";
import * as encoding from "lib0/encoding";
import { MESSAGE_TYPE,
  ProtocolError,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SHARED_TYPES,
  YJS_SYNC_PROTOCOL_VERSION,
  compareById,
  compareByKey,
  compareByZIndexThenId,
  computeCommandPayloadHash,
  createRoomEpoch,
  decodeMessage,
  decodeYjsCommandBatch,
  encodeCommandMessage,
  encodeCommandResultMessage,
  encodeStatusMessage,
  encodeSyncMessage,
  isForbiddenClientSyncType,
  stableStringify } from "./index.js";

const VALID_BATCH = {
  protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
  canvasId: "canvas-a",
  commandId: "cmd-1",
  baseRevision: 3,
  actorId: "actor",
  commands: [{ type: "canvas.setTitle", title: "x" }]
};

describe("格式与版本契约（任务 1.4）", () => {
  it("固定格式/协议版本与顶层 shared type 名", () => {
    expect(YJS_CANVAS_FORMAT_VERSION).toBe("woohaa3-ycanvas-v2");
    expect(YJS_SYNC_PROTOCOL_VERSION).toBe(4);
    expect(Object.values(YJS_SHARED_TYPES).sort()).toEqual(
      ["assets", "edges", "jobs", "meta", "nodeData", "nodes"].sort()
    );
  });

  it("room epoch 由注入的生成器决定（可确定性测试）", () => {
    expect(createRoomEpoch(() => "epoch-1")).toBe("epoch-1");
    expect(createRoomEpoch(() => "epoch-2")).not.toBe("epoch-1");
  });

  it("节点按 zIndex 再按 id 稳定排序，不依赖 Y.Map 迭代顺序", () => {
    const nodes = [
      { id: "b", zIndex: 2 },
      { id: "a", zIndex: 1 },
      { id: "c", zIndex: 1 },
      { id: "d" }
    ];
    const sorted = [...nodes].sort(compareByZIndexThenId).map((node) => node.id);
    // 缺省 zIndex 视为 0，因此 d 排最前；其后 zIndex=1 的 a/c 按 id 升序，最后 zIndex=2 的 b。
    expect(sorted).toEqual(["d", "a", "c", "b"]);
    // 输入顺序翻转后结果相同。
    expect([...nodes].reverse().sort(compareByZIndexThenId).map((node) => node.id)).toEqual(sorted);
  });

  it("边/资产/任务按 id，nodeData key 按字符串升序", () => {
    expect([{ id: "z" }, { id: "a" }].sort(compareById).map((entry) => entry.id)).toEqual(["a", "z"]);
    const entries: Array<[string, unknown]> = [["n2", 1], ["n1", 2], ["n10", 3]];
    expect(entries.sort(compareByKey).map(([key]) => key)).toEqual(["n1", "n10", "n2"]);
  });
});

describe("命令批次解码（任务 1.5）", () => {
  it("接受合法批次并映射为 protocolVersion/commandId/baseRevision", () => {
    const result = decodeYjsCommandBatch(VALID_BATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.protocolVersion).toBe(YJS_SYNC_PROTOCOL_VERSION);
    expect(result.batch.commandId).toBe("cmd-1");
    expect(result.batch.baseRevision).toBe(3);
  });

  it("协议版本不兼容时拒绝", () => {
    const result = decodeYjsCommandBatch({ ...VALID_BATCH, protocolVersion: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/协议版本/);
  });

  it("缺少 commandId 时拒绝", () => {
    const result = decodeYjsCommandBatch({ ...VALID_BATCH, commandId: "" });
    expect(result.ok).toBe(false);
  });

  it("命令结构非法时沿用前置 change 的判定", () => {
    const result = decodeYjsCommandBatch({ ...VALID_BATCH, commands: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/commands/);
  });

  it("payload 哈希对键顺序不敏感，对内容敏感", async () => {
    const a = await computeCommandPayloadHash({
      canvasId: "canvas-a",
      commands: [{ type: "canvas.setTitle", title: "x" }]
    });
    const b = await computeCommandPayloadHash({
      canvasId: "canvas-a",
      commands: [{ title: "x", type: "canvas.setTitle" } as never]
    });
    const c = await computeCommandPayloadHash({
      canvasId: "canvas-a",
      commands: [{ type: "canvas.setTitle", title: "y" }]
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stableStringify 排序对象键但保留数组顺序", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([2, 1])).toBe("[2,1]");
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("协议编解码（任务 1.5）", () => {
  it("COMMAND round-trip", () => {
    const encoded = encodeCommandMessage({ ...VALID_BATCH, commands: VALID_BATCH.commands as never });
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MESSAGE_TYPE.COMMAND);
    if (decoded.type !== MESSAGE_TYPE.COMMAND) return;
    expect(decoded.batch).toMatchObject({ commandId: "cmd-1", canvasId: "canvas-a" });
  });

  it("COMMAND_RESULT round-trip", () => {
    const encoded = encodeCommandResultMessage({ commandId: "cmd-1", status: "accepted", revision: 4 });
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MESSAGE_TYPE.COMMAND_RESULT);
    if (decoded.type !== MESSAGE_TYPE.COMMAND_RESULT) return;
    expect(decoded.result).toEqual({ commandId: "cmd-1", status: "accepted", revision: 4 });
  });

  it("STATUS round-trip", () => {
    const encoded = encodeStatusMessage({
      status: "synced",
      protocolVersion: 1,
      yDocFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "epoch-1",
      revision: 7
    });
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MESSAGE_TYPE.STATUS);
    if (decoded.type !== MESSAGE_TYPE.STATUS) return;
    expect(decoded.status.status).toBe("synced");
    expect(decoded.status.roomEpoch).toBe("epoch-1");
  });

  it("SYNC round-trip 保留 subtype 与 payload 字节", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, payload);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MESSAGE_TYPE.SYNC);
    if (decoded.type !== MESSAGE_TYPE.SYNC) return;
    expect(decoded.syncType).toBe(SYNC_MESSAGE_TYPE.STEP1);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it("SYNC 空 payload 也可解码（step1 可省略 state vector）", () => {
    const encoded = encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP2, new Uint8Array(0));
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MESSAGE_TYPE.SYNC);
    if (decoded.type !== MESSAGE_TYPE.SYNC) return;
    expect(decoded.syncType).toBe(SYNC_MESSAGE_TYPE.STEP2);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("未知消息类型抛 ProtocolError(unknown-message-type)", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 99);
    expect(() => decodeMessage(encoding.toUint8Array(encoder))).toThrow(ProtocolError);
    try {
      decodeMessage(encoding.toUint8Array(encoder));
    } catch (error) {
      expect((error as ProtocolError).code).toBe("unknown-message-type");
    }
  });

  it("JSON 载荷畸形抛 invalid-json", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.COMMAND);
    encoding.writeVarString(encoder, "{not json");
    try {
      decodeMessage(encoding.toUint8Array(encoder));
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as ProtocolError).code).toBe("invalid-json");
    }
  });

  it("空/截断字节抛稳定错误（不崩溃）", () => {
    expect(() => decodeMessage(new Uint8Array(0))).toThrow(ProtocolError);
    try {
      decodeMessage(new Uint8Array(0));
    } catch (error) {
      expect((error as ProtocolError).code).toBe("malformed-message");
    }
  });

  it("判定客户端 sync update / step 2 为协议违规", () => {
    expect(isForbiddenClientSyncType(SYNC_MESSAGE_TYPE.STEP1)).toBe(false);
    expect(isForbiddenClientSyncType(SYNC_MESSAGE_TYPE.STEP2)).toBe(true);
    expect(isForbiddenClientSyncType(SYNC_MESSAGE_TYPE.UPDATE)).toBe(true);
  });
});
