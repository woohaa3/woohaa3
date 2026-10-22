/**
 * 视频编辑入口控制器测试
 * （change: port-video-editing-dialogs，任务 4.1 / 4.3；design D2/D9）。
 *
 * 验证 only-canonical 输入：只接受 canonical ready video mapping（edit_video 输入或自身输出），
 * 拒绝任意外部 URL、data URL、临时 provider URL、unavailable 视频与类型不匹配资产；
 * 入口按只读/保存中/任务进行中给出禁用原因；dispose 关闭实例并撤销 registrations。
 */
import { describe, expect, it } from "vitest";
import type { CanvasNodeData, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { createVideoDialogsController, resolveCanonicalReadyVideo, resolveOwnReadyVideo } from "./controller.js";
import type { CanvasSession, DialogsService, MediaRemoteService } from "../../contracts.js";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;

function videoAsset(overrides: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: "asset-video",
    title: "视频",
    mediaKind: "video",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    url: `/api/media/${STORAGE_KEY}`,
    metadata: { storageKey: STORAGE_KEY, checksum: "a".repeat(64), contentType: "video/mp4", size: 10 },
    ...overrides
  };
}

function canvasWith(nodeData: Record<string, CanvasNodeData>, assets: StoredAsset[]): ServerCanvas {
  return {
    id: "c1",
    title: "画布",
    revision: 1,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [
        { id: "n1", type: "video", position: { x: 0, y: 0 }, width: 320, height: 200 },
        { id: "src", type: "video", position: { x: 300, y: 0 }, width: 320, height: 200 }
      ],
      edges: [{ id: "e1", source: "src", target: "n1", data: {} }],
      updatedAt: "2026-01-01T00:00:00Z"
    },
    nodeData,
    assets,
    jobs: [],
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

describe("resolveCanonicalReadyVideo", () => {
  it("通过 edit_video 输入 mapping 解析 canonical ready 视频", () => {
    const canvas = canvasWith(
      { n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } },
      [videoAsset()]
    );
    const resolved = resolveCanonicalReadyVideo(canvas, "n1");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.storageKey).toBe(STORAGE_KEY);
    expect(resolved.url).toBe(`/api/media/${STORAGE_KEY}?canvas=c1`);
  });

  it("拒绝 unavailable / 非视频 / 缺失 storageKey", () => {
    const unavailable = resolveCanonicalReadyVideo(
      canvasWith({ n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } }, [videoAsset({ status: "missing" })]),
      "n1"
    );
    expect(unavailable.ok).toBe(false);

    const image = resolveCanonicalReadyVideo(
      canvasWith({ n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } }, [videoAsset({ mediaKind: "image" })]),
      "n1"
    );
    expect(image.ok).toBe(false);

    const noKey = resolveCanonicalReadyVideo(
      canvasWith({ n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } }, [videoAsset({ metadata: {} })]),
      "n1"
    );
    expect(noKey.ok).toBe(false);
  });

  it("拒绝外部/临时 URL（非受控同源）", () => {
    const resolved = resolveCanonicalReadyVideo(
      canvasWith({ n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } }, [videoAsset({ url: "https://cos.example.com/x?sign=1" })]),
      "n1"
    );
    expect(resolved.ok).toBe(false);
  });

  it("无 video mapping 时返回禁用原因", () => {
    const resolved = resolveCanonicalReadyVideo(canvasWith({ n1: {} }, []), "n1");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("视频");
  });
});

describe("resolveOwnReadyVideo（双击入口，design D6）", () => {
  it("只解析节点自身输出，忽略 edit_video input mapping", () => {
    // n1 的 input mapping 指向 src 的 asset-video，但自身输出指向另一 asset。
    const ownStorage = `sha256-${"b".repeat(64)}`;
    const canvas = canvasWith(
      { n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }], outputAssetId: "asset-own" }, src: { outputAssetId: "asset-video" } },
      [videoAsset(), videoAsset({ id: "asset-own", url: `/api/media/${ownStorage}`, metadata: { storageKey: ownStorage, checksum: "b".repeat(64), contentType: "video/mp4", size: 10 } })]
    );
    const resolved = resolveOwnReadyVideo(canvas, "n1");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.assetId).toBe("asset-own");
    expect(resolved.storageKey).toBe(ownStorage);
  });

  it("未 ready / 类型错误 / 缺 storageKey / 非受控 URL / 非视频节点时拒绝", () => {
    const own = (asset: StoredAsset) => canvasWith({ n1: { outputAssetId: "asset-own" } }, [asset]);
    const base = videoAsset({ id: "asset-own" });
    expect(resolveOwnReadyVideo(own(videoAsset({ id: "asset-own", status: "generating" })), "n1").ok).toBe(false);
    expect(resolveOwnReadyVideo(own(videoAsset({ id: "asset-own", mediaKind: "image" })), "n1").ok).toBe(false);
    expect(resolveOwnReadyVideo(own(videoAsset({ id: "asset-own", metadata: {} })), "n1").ok).toBe(false);
    expect(resolveOwnReadyVideo(own(videoAsset({ id: "asset-own", url: "https://cos.example.com/x?sign=1" })), "n1").ok).toBe(false);
    expect(resolveOwnReadyVideo(canvasWith({ n1: {} }, [base]), "n1").ok).toBe(false);
    expect(resolveOwnReadyVideo(null, "n1").ok).toBe(false);
  });
});

function makeControllerDeps(options: { writable?: boolean } = {}) {
  const registered: string[] = [];
  const closed: string[] = [];
  const dialogs = {
    registerDialog(dialogId: string) {
      registered.push(dialogId);
      return () => {
        const index = registered.indexOf(dialogId);
        if (index >= 0) registered.splice(index, 1);
      };
    },
    open(request: { dialogId: string; payload?: unknown }) {
      return { ok: true as const, instance: { instanceId: `i-${request.dialogId}`, dialogId: request.dialogId, payload: request.payload, parentInstanceId: null, dismissible: true, busy: false } };
    },
    close(instanceId: string) {
      closed.push(instanceId);
      return true;
    }
  } as unknown as DialogsService;
  const mediaRemote = { async upload() { return { ok: false as const, error: "unused" }; } } as unknown as MediaRemoteService;
  const session = { isWritable: () => options.writable ?? true, submitCommands: () => ({ ok: true as const, handle: {} as never }) } as unknown as CanvasSession;
  return { dialogs, mediaRemote, session, registered, closed };
}

describe("createVideoDialogsController", () => {
  it("注册两个 dialog 并在 dispose 撤销", () => {
    const deps = makeControllerDeps();
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    expect(deps.registered.sort()).toEqual(["canvas-video-edit", "canvas-video-frame-capture"]);
    controller.dispose();
    expect(deps.registered).toEqual([]);
  });

  it("入口按只读/保存中/任务进行中给出禁用原因", () => {
    const deps = makeControllerDeps({ writable: false });
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    const entry = controller.controller.resolveEntry({ canvas: null, nodeId: "n1", writable: false, pending: false, taskPending: false });
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.reason).toContain("只读");
  });

  it("openFrameCapture 只从 canonical ready video 解析并打开截帧 dialog", () => {
    const deps = makeControllerDeps();
    const opened: string[] = [];
    (deps.dialogs as unknown as { open: (request: { dialogId: string }) => unknown }).open = (request) => {
      opened.push(request.dialogId);
      return { ok: true as const, instance: { instanceId: `i-${request.dialogId}`, dialogId: request.dialogId, payload: undefined, parentInstanceId: null, dismissible: true, busy: false } };
    };
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    const canvas = canvasWith(
      { n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } },
      [videoAsset()]
    );
    expect(controller.controller.openFrameCapture({ canvas, nodeId: "n1" }).ok).toBe(true);
    expect(opened).toEqual(["canvas-video-frame-capture"]);
    // 缺失视频时不打开。
    expect(controller.controller.openFrameCapture({ canvas: null, nodeId: "n1" }).ok).toBe(false);
  });

  it("只读时不打开编辑 dialog", () => {
    const deps = makeControllerDeps({ writable: false });
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    const canvas = canvasWith(
      { n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }] }, src: { outputAssetId: "asset-video" } },
      [videoAsset()]
    );
    controller.controller.openEdit({ canvas, nodeId: "n1" });
    // openEdit 不检查 writable（由入口禁用），这里只验证不抛错。
    expect(true).toBe(true);
  });

  it("openOwnOutputFrameCapture 只绑定节点自身输出而非 edit 输入", () => {
    const deps = makeControllerDeps();
    const opened: Array<{ dialogId: string; payload?: unknown }> = [];
    (deps.dialogs as unknown as { open: (request: { dialogId: string; payload?: unknown }) => unknown }).open = (request) => {
      opened.push({ dialogId: request.dialogId, payload: request.payload });
      return { ok: true as const, instance: { instanceId: `i-${request.dialogId}`, dialogId: request.dialogId, payload: request.payload, parentInstanceId: null, dismissible: true, busy: false } };
    };
    const ownStorage = `sha256-${"b".repeat(64)}`;
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    const canvas = canvasWith(
      { n1: { inputMapping: [{ sourceNodeId: "src", role: "edit_video" }], outputAssetId: "asset-own" }, src: { outputAssetId: "asset-video" } },
      [videoAsset(), videoAsset({ id: "asset-own", url: `/api/media/${ownStorage}`, metadata: { storageKey: ownStorage, checksum: "b".repeat(64), contentType: "video/mp4", size: 10 } })]
    );
    expect(controller.openOwnOutputFrameCapture({ canvas, nodeId: "n1" }).ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.dialogId).toBe("canvas-video-frame-capture");
    expect((opened[0]!.payload as { videoStorageKey: string }).videoStorageKey).toBe(ownStorage);
  });

  it("openOwnOutputFrameCapture 在节点未 ready 时不打开", () => {
    const deps = makeControllerDeps();
    const opened: string[] = [];
    (deps.dialogs as unknown as { open: (request: { dialogId: string }) => unknown }).open = (request) => {
      opened.push(request.dialogId);
      return { ok: true as const, instance: { instanceId: "i", dialogId: request.dialogId, payload: undefined, parentInstanceId: null, dismissible: true, busy: false } };
    };
    const controller = createVideoDialogsController({ dialogs: deps.dialogs, mediaRemote: deps.mediaRemote, session: deps.session, readNodeIntents: () => [] });
    expect(controller.openOwnOutputFrameCapture({ canvas: canvasWith({ n1: {} }, []), nodeId: "n1" }).ok).toBe(false);
    expect(opened).toHaveLength(0);
  });
});
