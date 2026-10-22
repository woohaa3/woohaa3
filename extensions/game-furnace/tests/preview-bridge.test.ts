import { describe, expect, it } from "vitest";
import { createPreviewNonce, previewEntryWithBridge, validatePreviewBridgeMessage } from "../src/frontend/preview-bridge.js";

const frameWindow = {};
const context = { frameWindow, nonce: "nonce-1", generation: 7, maxSize: 4096 };

describe("试玩消息桥校验（任务 8.5）", () => {
  it("只接受来自当前 iframe 且 nonce/generation 匹配的白名单消息", () => {
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "ready", nonce: "nonce-1", generation: 7 } }, context)).toEqual({ kind: "ready" });
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "error", message: "boom", nonce: "nonce-1", generation: 7 } }, context)).toEqual({ kind: "error", message: "boom" });
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "size", width: 320, height: 240, nonce: "nonce-1", generation: 7 } }, context)).toEqual({ kind: "size", width: 320, height: 240 });
  });

  it("拒绝其它 iframe/窗口伪造的 ready/error（source 不符）", () => {
    const foreign = {};
    expect(validatePreviewBridgeMessage({ source: foreign, data: { kind: "ready", nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: null, data: { kind: "ready", nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    // 未挂载 iframe 时不接受任何消息。
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "ready", nonce: "nonce-1", generation: 7 } }, { ...context, frameWindow: null })).toBeNull();
  });

  it("拒绝 nonce/generation 不符（旧版本或伪造）", () => {
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "ready", nonce: "stale", generation: 7 } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "ready", nonce: "nonce-1", generation: 6 } }, context)).toBeNull();
  });

  it("无任意应用命令通道：未知 kind 与畸形消息一律忽略", () => {
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "run", command: "rm -rf", nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "ready" } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: "ready" }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: null }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: [1, 2] }, context)).toBeNull();
  });

  it("size 受控：非整数/负数/超上限被拒绝，error 文案被截断", () => {
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "size", width: 1.5, height: 10, nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "size", width: -1, height: 10, nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "size", width: 99999, height: 10, nonce: "nonce-1", generation: 7 } }, context)).toBeNull();
    const long = "x".repeat(1000);
    expect(validatePreviewBridgeMessage({ source: frameWindow, data: { kind: "error", message: long, nonce: "nonce-1", generation: 7 } }, context)).toEqual({ kind: "error", message: "x".repeat(300) });
  });

  it("nonce 形状稳定、入口片段不含服务端路径信息", () => {
    expect(createPreviewNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(previewEntryWithBridge("/api/extensions/game-furnace/site/" + "a".repeat(64) + "/index.html", "nonce-1", 3))
      .toBe("/api/extensions/game-furnace/site/" + "a".repeat(64) + "/index.html#gfn=nonce-1.3");
  });
});
