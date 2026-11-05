import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { SlotRegistry } from "../../slots.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { seedanceVideoInteractionExtension } from "./seedance-plugin.js";

const key = `sha256-${"a".repeat(64)}`;
const cleanups: Array<() => void> = [];

function mount() {
  const base = createEmptyWoohaa3ServerCanvas("video-canvas");
  const canvas = {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "video", type: "video", position: { x: 0, y: 0 } }] },
    nodeData: { video: { outputAssetId: "own", inputMapping: [{ sourceNodeId: "other", sourceAssetIds: ["input"], role: "edit_video" }] } },
    assets: ["own", "input"].map((id) => ({
      id, title: id, mediaKind: "video", source: "uploaded", status: "ready",
      url: `/api/media/${key}`, metadata: { storageKey: key }, createdAt: "2026-11-04T00:00:00Z"
    }))
  } as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const slots = new SlotRegistry();
  const open = vi.fn((request: { dialogId: string; payload?: unknown }) => ({
    ok: true, instance: { instanceId: "edit-1", ...request }
  }));
  let writable = true;
  let pendingCount = 0;
  seedanceVideoInteractionExtension()({
    slots,
    dialogs: { registerDialog: () => () => {}, open, close: vi.fn() },
    mediaRemote: { upload: vi.fn() },
    canvasSession: { isWritable: () => writable, getStatus: () => ({ remote: { pendingCount } }) },
    canvasScope: { canvasId: () => canvas.id },
    modelInteractions: { register: () => () => {} },
    on: () => () => {},
    effect: (effect: () => () => void) => { cleanups.push(effect()); }
  } as never, undefined);
  const action = slots.list("canvas.node-action")[0]!;
  const context = { nodeId: "video", nodeType: "video", writable: true };
  const activate = (allowed = true) => action.activate({ ...context, writable: allowed, menu: false, requestSettings: () => {} });
  return { action, context, open, canvas, activate, slots, setWritable: (value: boolean) => { writable = value; }, setPending: (value: number) => { pendingCount = value; } };
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

describe("普通视频标注入口", () => {
  it("打开正确节点自身视频的生产编辑会话，并在卸载时移除入口", () => {
    const host = mount();
    expect(host.action.describe(host.context)).toMatchObject({ label: "编辑视频标注", enabled: true });
    host.activate();
    expect(host.open).toHaveBeenCalledWith(expect.objectContaining({
      dialogId: "canvas-video-edit",
      payload: expect.objectContaining({ targetNodeId: "video", videoAssetId: "own", videoStorageKey: key })
    }));
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(host.slots.list("canvas.node-action")).toEqual([]);
  });

  it("只读、待保存或生成占用时禁止打开", () => {
    const host = mount();
    host.setWritable(false);
    expect(host.action.describe(host.context)?.enabled).toBe(false);
    host.activate();
    host.setWritable(true);
    host.activate(false);
    host.setPending(1);
    expect(host.action.describe(host.context)?.enabled).toBe(false);
    host.activate();
    host.setPending(0);
    host.canvas.nodeData.video!.taskStatus = "processing";
    expect(host.action.describe(host.context)?.enabled).toBe(false);
    host.activate();
    expect(host.open).not.toHaveBeenCalled();
  });

  it("没有自身ready输出时不显示且不能打开", () => {
    const host = mount();
    host.canvas.assets[0]!.status = "missing";
    expect(host.action.describe(host.context)).toBeNull();
    host.activate();
    expect(host.open).not.toHaveBeenCalled();
  });
});
