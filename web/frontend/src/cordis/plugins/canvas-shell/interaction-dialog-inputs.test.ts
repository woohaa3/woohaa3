/**
 * 交互控制器测试：对话框入口、视频 hover/截帧、坐标换算与缩放
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing
} from "./test-support/controller-harness.js";

installSharedSession();

describe("双击请求 media-preview（change: add-frontend-dialog-system，任务 4.1 / 4.2）", () => {
  function canvasWithImageAsset(options: {
    nodeType?: string;
    status?: "ready" | "generating" | "needs-review" | "missing" | "failed";
    mediaKind?: "image" | "video" | "audio" | "text" | "storyboard";
    url?: string;
    outputAssetId?: string;
  }) {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    return {
      ...base,
      revision: 1,
      document: {
        ...base.document,
        nodes: [{ id: "img1", type: options.nodeType ?? "image", position: { x: 0, y: 0 } }]
      },
      assets: [
        {
          id: "a1",
          title: "结果图",
          mediaKind: options.mediaKind ?? "image",
          source: "generated" as const,
          status: options.status ?? "ready",
          url: options.url ?? "/api/media/abc",
          createdAt: "2026-09-26T00:00:00.000Z"
        }
      ],
      nodeData: {
        img1: {
          title: "我的图",
          ...(options.outputAssetId === undefined ? { outputAssetId: "a1" } : { outputAssetId: options.outputAssetId })
        }
      }
    } satisfies ServerCanvas;
  }

  function previewHarness(canvas: ServerCanvas) {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const requests: Array<{ assetId: string; nodeId: string; title: string }> = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onImagePreview: (request) => requests.push(request)
    });
    return { dom, controller, requests };
  }

  it("双击 ready image 节点请求 preview 且只带资产身份", () => {
    const { dom, controller, requests } = previewHarness(canvasWithImageAsset({}));
    dom.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(requests).toEqual([{ assetId: "a1", nodeId: "img1", title: "我的图" }]);
    controller.dispose();
  });

  it("资产未 ready 或 URL 不合规时不打开", () => {
    for (const canvas of [
      canvasWithImageAsset({ status: "generating" }),
      canvasWithImageAsset({ url: "https://evil.example/x.png" }),
      canvasWithImageAsset({ url: "blob:http://localhost/1" }),
      canvasWithImageAsset({ outputAssetId: "" })
    ]) {
      const { dom, controller, requests } = previewHarness(canvas);
      dom.fire("dblclick", { clientX: 5, clientY: 5 });
      expect(requests).toHaveLength(0);
      controller.dispose();
    }
  });

  it("非图片节点不触发", () => {
    const { dom, controller, requests } = previewHarness(canvasWithImageAsset({ nodeType: "text", mediaKind: "image" }));
    dom.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(requests).toHaveLength(0);
    controller.dispose();
  });
});

describe("视频节点 hover 与双击截帧（change: enable-video-node-live-preview）", () => {
  const VIDEO_STORAGE = `sha256-${"c".repeat(64)}`;

  function videoCanvasShell(options: {
    nodeType?: string;
    status?: "ready" | "generating" | "missing";
    mediaKind?: "image" | "video";
    url?: string;
    outputAssetId?: string;
    storageKey?: string | null;
  }) {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const storageKey = options.storageKey === undefined ? VIDEO_STORAGE : options.storageKey;
    const nodeData: Record<string, unknown> = {
      vid1: {
        ...(options.outputAssetId === undefined ? { outputAssetId: "v1" } : { outputAssetId: options.outputAssetId })
      }
    };
    return {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "vid1", type: options.nodeType ?? "video", position: { x: 0, y: 0 } }] },
      assets: [
        {
          id: "v1",
          title: "视频",
          mediaKind: options.mediaKind ?? "video",
          source: "generated" as const,
          status: options.status ?? "ready",
          url: options.url ?? `/api/media/${VIDEO_STORAGE}`,
          createdAt: "2026-09-26T00:00:00.000Z",
          ...(storageKey === null ? {} : { metadata: { storageKey, checksum: "c".repeat(64), contentType: "video/mp4", size: 4 } })
        }
      ],
      nodeData
    } as unknown as ServerCanvas;
  }

  function videoHarness(canvas: ServerCanvas) {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const captures: Array<{ nodeId: string }> = [];
    const hovered: Array<string | null> = [];
    const paused: number[] = [];
    let playing: string | null = null;
    const videoSessions = {
      sync: () => undefined,
      setHovered: (nodeId: string | null) => { hovered.push(nodeId); playing = nodeId; },
      playingNodeId: () => playing,
      pauseAll: () => { paused.push(1); playing = null; },
      hasRealFrame: () => false,
      dispose: () => undefined
    };
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onVideoFrameCapture: (request) => captures.push(request),
      videoSessions: videoSessions as never
    });
    return { dom, controller, captures, hovered, paused, videoSessions };
  }

  it("聚焦暂停会话后，指针仍在同一视频节点也能重新建立 hover 播放", () => {
    const { dom, controller, hovered, videoSessions } = videoHarness(videoCanvasShell({}));
    dom.fire("pointermove", { clientX: 5, clientY: 5 });
    expect(videoSessions.playingNodeId()).toBe("vid1");
    videoSessions.pauseAll();
    dom.fire("pointermove", { clientX: 6, clientY: 6 });
    expect(videoSessions.playingNodeId()).toBe("vid1");
    expect(hovered).toEqual(["vid1", "vid1"]);
    controller.dispose();
  });

  it("双击 ready video 节点只发 { nodeId } 并先暂停 hover 播放", () => {
    const { dom, controller, captures, paused } = videoHarness(videoCanvasShell({}));
    dom.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(captures).toEqual([{ nodeId: "vid1" }]);
    expect(paused).toHaveLength(1);
    controller.dispose();
  });

  it("video 未 ready / 类型不符 / 缺 storageKey / 非受控 URL 时不触发截帧", () => {
    for (const canvas of [
      videoCanvasShell({ status: "generating" }),
      videoCanvasShell({ mediaKind: "image" }),
      videoCanvasShell({ storageKey: null }),
      videoCanvasShell({ url: "https://cos.example.com/v.mp4?sign=1" }),
      videoCanvasShell({ outputAssetId: "" })
    ]) {
      const { dom, controller, captures, paused } = videoHarness(canvas);
      dom.fire("dblclick", { clientX: 5, clientY: 5 });
      expect(captures).toHaveLength(0);
      expect(paused).toHaveLength(0);
      controller.dispose();
    }
  });

  it("图片节点双击不走截帧入口", () => {
    const { dom, controller, captures } = videoHarness(videoCanvasShell({ nodeType: "image", mediaKind: "image" }));
    dom.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(captures).toHaveLength(0);
    controller.dispose();
  });

  it("指针进入视频节点驱动 hover，离开时清除", () => {
    const { dom, controller, hovered } = videoHarness(videoCanvasShell({}));
    // 节点默认位于世界原点，canvas 坐标左上角即命中。
    dom.fire("pointermove", { clientX: 5, clientY: 5 });
    expect(hovered.at(-1)).toBe("vid1");
    dom.fire("pointerleave", {});
    expect(hovered.at(-1)).toBeNull();
    controller.dispose();
  });

  it("开始画布手势 / modal 门禁 / 页面隐藏时暂停 hover 播放（任务 4.3/4.4）", () => {
    // 手势开始（pointerdown）即暂停。
    {
      const { dom, controller, hovered } = videoHarness(videoCanvasShell({}));
      dom.fire("pointermove", { clientX: 5, clientY: 5 });
      expect(hovered.at(-1)).toBe("vid1");
      dom.fire("pointerdown", { clientX: 5, clientY: 5, button: 1 });
      expect(hovered.at(-1)).toBeNull();
      controller.dispose();
    }
    // modal 激活：即便指针在节点上也清除 hover。
    {
      woohaa3CanvasStore.getState().applyRemoteCanvas(videoCanvasShell({}) as never);
      const dom = harness();
      const { runtime } = runtimeCapturing();
      const hovered: Array<string | null> = [];
      let modal = false;
      const controller = installInteractionController({
        canvas: dom.canvas,
        getRuntime: () => runtime,
        getSession: () => getSession() as never,
        target: dom.target as never,
        isModalActive: () => modal,
        videoSessions: {
          sync: () => undefined,
          setHovered: (id: string | null) => hovered.push(id),
          playingNodeId: () => null,
          pauseAll: () => undefined,
          hasRealFrame: () => false,
          activeNodeIds: () => [],
          dispose: () => undefined
        } as never
      });
      dom.fire("pointermove", { clientX: 5, clientY: 5 });
      expect(hovered.at(-1)).toBe("vid1");
      modal = true;
      dom.fire("pointermove", { clientX: 6, clientY: 6 });
      expect(hovered.at(-1)).toBeNull();
      controller.dispose();
    }
  });

  it("双击视频节点前先暂停画布 hover 播放（design D7）", () => {
    const { dom, controller, captures, paused } = videoHarness(videoCanvasShell({}));
    dom.fire("pointermove", { clientX: 5, clientY: 5 });
    dom.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(paused).toHaveLength(1);
    expect(captures).toEqual([{ nodeId: "vid1" }]);
    controller.dispose();
  });
});

describe("pointer/client 坐标与 Mod+V 不抢占（change: add-paste-import-workflows）", () => {
  it("lastPointerWorld 记录最近指针，clientToWorld 按视口换算", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    expect(controller.lastPointerWorld()).toBeNull();
    dom.fire("pointermove", { clientX: 100, clientY: 50 });
    expect(controller.lastPointerWorld()).toEqual({ x: 100, y: 50 });
    // zoom=1, viewport=(0,0) → client 即世界坐标。
    expect(controller.clientToWorld({ x: 300, y: 200 })).toEqual({ x: 300, y: 200 });
    controller.dispose();
  });

  it("Ctrl+V 不再 preventDefault，让原生 paste event 抵达 Input Scope Host", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    nodeSelectionStore.setKeyboardActive(true);
    const prevented: boolean[] = [];
    dom.fire("keydown", {
      key: "v",
      ctrlKey: true,
      preventDefault: () => prevented.push(true)
    });
    // paste 不消费事件；controller 不调用 preventDefault。
    expect(prevented).toHaveLength(0);
    controller.dispose();
    nodeSelectionStore.reset();
  });

  it("worldToClient 与 clientToWorld 互逆（含 canvas 外框偏移）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // harness 的 canvas 外框 left/top 为 0；zoom=1、viewport=(0,0) → 世界坐标 == client 坐标。
    const client = controller.worldToClient({ x: 300, y: 200 });
    expect(client).toEqual({ x: 300, y: 200 });
    expect(controller.clientToWorld(client)).toEqual({ x: 300, y: 200 });
    controller.dispose();
  });
});

