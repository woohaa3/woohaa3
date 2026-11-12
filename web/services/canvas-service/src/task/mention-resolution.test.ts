/**
 * Canvas 权威 mention 解析与 prompt 编译
 * （change: add-reference-inputs-and-mentions，任务 5.1–5.4）。
 */
import { describe, expect, it } from "vitest";
import {
  createDefaultWorldCameraData,
  createWorldAnimationScript,
  createEmptyWoohaa3ServerCanvas,
  serializeWoohaa3CanvasMention,
  type CanvasTaskInputBinding,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import {
  collectCarriedInputs,
  collectDirectMentionCandidates,
  mergeInputs,
  resolveMentionsAndCompile
} from "./mention-resolution.js";

const NOW = "2026-09-26T00:00:00.000Z";
const STORAGE = "sha256-" + "a".repeat(64);

function mediaAsset(id: string, mediaKind: "image" | "video" | "audio", status: StoredAsset["status"] = "ready"): StoredAsset {
  const contentType = mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "audio/mpeg";
  const extension = mediaKind === "image" ? "png" : mediaKind === "video" ? "mp4" : "mp3";
  return {
    id,
    title: id,
    mediaKind,
    source: "generated",
    status,
    createdAt: NOW,
    metadata: { storageKey: `${STORAGE}.${extension}`, checksum: "a".repeat(64), contentType, size: 4 }
  };
}


const IMAGE_BINDING: CanvasTaskInputBinding[] = [
  {
    field: "imageUrls",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png"],
    maxItems: 4,
    valueFormat: "url"
  }
];

/** 目标 image 节点 + 图片 source（已连接）的最小画布。 */
function canvasWithImageSource(options: { assetStatus?: StoredAsset["status"] } = {}): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push(
    { id: "src", type: "image", position: { x: 0, y: 0 } },
    { id: "target", type: "image", position: { x: 300, y: 0 } }
  );
  canvas.document.edges.push({ id: "e1", source: "src", target: "target", data: {} });
  canvas.assets.push(mediaAsset("a1", "image", options.assetStatus));
  canvas.nodeData.src = { outputAssetId: "a1" };
  canvas.nodeData.target = {
    inputMapping: [{ slotId: "slot-a1", sourceNodeId: "src", role: "reference_image", sortKey: "0" }]
  };
  return canvas;
}

describe("collectDirectMentionCandidates", () => {
  it("只来自直接 mapping 并给出稳定 slot", () => {
    const candidates = collectDirectMentionCandidates(canvasWithImageSource(), "target");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ slotId: "slot-a1", type: "input_image", sourceNodeId: "src" });
    expect(candidates[0]!.input?.assetId).toBe("a1");
  });

  it("未 ready 资产候选标记为 null input", () => {
    const candidates = collectDirectMentionCandidates(canvasWithImageSource({ assetStatus: "generating" }), "target");
    expect(candidates[0]!.input).toBeNull();
  });
});

describe("resolveMentionsAndCompile", () => {
  it("合法图片 mention：provider 文本可读且保留媒体输入", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "slot-a1", label: "图片 1" })!;
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: `参考 ${token} 生成`,
      bindings: IMAGE_BINDING,
      directInputs: [{ assetId: "a1", role: "reference_image", storageKey: `${STORAGE}.png`, mediaType: "image/png", mediaKind: "image" }]
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.providerText).toBe("参考 图片 1 生成");
    expect(result.providerText).not.toContain("{{");
    expect(result.inputs).toHaveLength(1);
  });

  it("token 引用不存在的 slot → run begin 前失败", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "ghost", label: "图片 X" })!;
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: token,
      bindings: IMAGE_BINDING,
      directInputs: []
    });
    expect(result.kind).toBe("invalid-mention");
  });

  it("token 类型与 slot 不匹配 → 失败", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_video", slotId: "slot-a1", label: "视频 1" })!;
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: token,
      bindings: IMAGE_BINDING,
      directInputs: []
    });
    expect(result.kind).toBe("invalid-mention");
  });

  it("未 mention 的直接输入仍提交", () => {
    const direct = [{ assetId: "a1", role: "reference_image", storageKey: `${STORAGE}.png`, mediaType: "image/png", mediaKind: "image" as const }];
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: "纯文字提示",
      bindings: IMAGE_BINDING,
      directInputs: direct
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.inputs).toEqual(direct);
  });

  it("直接输入与 mention 指向同一资产只提交一次", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "slot-a1", label: "图片 1" })!;
    const direct = [{ assetId: "a1", role: "reference_image", storageKey: `${STORAGE}.png`, mediaType: "image/png", mediaKind: "image" as const }];
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: token,
      bindings: IMAGE_BINDING,
      directInputs: direct
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.inputs).toHaveLength(1);
  });

  it("超出 binding 上限 → 失败且不截断", () => {
    const strict: CanvasTaskInputBinding[] = [{ ...IMAGE_BINDING[0]!, maxItems: 0 }];
    const result = resolveMentionsAndCompile({
      canvas: canvasWithImageSource(),
      nodeId: "target",
      authored: "x",
      bindings: strict,
      directInputs: [{ assetId: "a1", role: "reference_image", storageKey: `${STORAGE}.png`, mediaType: "image/png", mediaKind: "image" }]
    });
    expect(result.kind).toBe("invalid-mention");
  });
});



describe("carried inputs（一层文字）", () => {
  function canvasWithTextCarrier(options: { mention: boolean; nested?: boolean }): ServerCanvas {
    const canvas = createEmptyWoohaa3ServerCanvas("c2", NOW);
    canvas.document.nodes.push(
      { id: "img", type: "image", position: { x: 0, y: 0 } },
      { id: "text", type: "text", position: { x: 300, y: 0 } },
      { id: "target", type: "image", position: { x: 600, y: 0 } }
    );
    canvas.document.edges.push(
      { id: "e1", source: "img", target: "text", data: {} },
      { id: "e2", source: "text", target: "target", data: {} }
    );
    canvas.assets.push(mediaAsset("a1", "image"));
    canvas.nodeData.img = { outputAssetId: "a1" };
    canvas.nodeData.text = {
      inputMapping: [{ slotId: "slot-a1", sourceNodeId: "img", role: "reference_image", sortKey: "0" }],
      prompt: options.mention
        ? `携带 ${serializeWoohaa3CanvasMention({ type: "input_image", slotId: "slot-a1", label: "图片 1" })}`
        : "没有引用素材"
    };
    canvas.nodeData.target = {
      inputMapping: [{ slotId: "slot-text", sourceNodeId: "text", role: "text_prompt", sortKey: "0" }]
    };
    return canvas;
  }

  it("文字节点明确 mention 的媒体成为 carried input", () => {
    const carried = collectCarriedInputs(canvasWithTextCarrier({ mention: true }), "target");
    expect(carried).toHaveLength(1);
    expect(carried[0]!.assetId).toBe("a1");
  });

  it("文字节点未 mention 则不携带", () => {
    const carried = collectCarriedInputs(canvasWithTextCarrier({ mention: false }), "target");
    expect(carried).toEqual([]);
  });
});

describe("mergeInputs 去重", () => {
  it("保留直接输入位置并去重 carried", () => {
    const direct = [{ assetId: "a1", role: "reference_image", storageKey: "s", mediaType: "image/png" }];
    const carried = [
      { assetId: "a1", role: "reference_image", storageKey: "s", mediaType: "image/png" },
      { assetId: "a2", role: "reference_image", storageKey: "s2", mediaType: "image/png" }
    ];
    expect(mergeInputs(direct, carried).map((input) => input.assetId)).toEqual(["a1", "a2"]);
  });
});

describe("动态镜头 mention 槽类型", () => {
  it("动画区镜头是视频槽，插入“视频 1”不会再报类型不匹配", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    canvas.document.nodes.push(
      { id: "cam", type: "world-camera", position: { x: 0, y: 0 } },
      { id: "target", type: "video", position: { x: 300, y: 0 } },
      { id: "area", type: "scene-area" }
    );
    canvas.document.edges.push({ id: "e1", source: "cam", target: "target", data: {} });
    canvas.nodeData.cam = { worldCamera: { ...createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }), captureMode: { kind: "static" } } } as never;
    canvas.nodeData.area = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "scope-1",
        bounds: { min: { u: -30, v: -30 }, max: { u: 30, v: 30 } },
        animationScript: createWorldAnimationScript({ script: "function build(motion) {}", duration: 4, loop: false })
      }
    } as never;
    canvas.nodeData.target = {
      inputMapping: [{ slotId: "slot-cam", sourceNodeId: "cam", role: "reference_image", sortKey: "0" }]
    };

    const cameraInput = { assetId: "media", role: "reference_video", storageKey: "k", mediaType: "video/mp4", mediaKind: "video" } as const;
    const candidates = collectDirectMentionCandidates(canvas, "target", new Map([["cam", cameraInput as never]]));
    expect(candidates).toEqual([
      expect.objectContaining({ slotId: "slot-cam", type: "input_video", role: "reference_video", label: "视频 1" })
    ]);

    const authored = serializeWoohaa3CanvasMention({ type: "input_video", slotId: "slot-cam", label: "视频 1" })!;
    const resolution = resolveMentionsAndCompile({
      canvas,
      nodeId: "target",
      authored,
      bindings: [{ field: "videoUrls", semantic: "reference-video", roles: ["reference_video"], mediaKinds: ["video"], mediaTypes: ["video/mp4"], maxItems: 1, valueFormat: "url" }],
      directInputs: [{ assetId: "media", role: "reference_video", storageKey: "k", mediaType: "video/mp4", mediaKind: "video" }],
      cameraInputs: new Map([["cam", cameraInput as never]])
    });
    expect(resolution.kind).toBe("ok");
  });
});

describe("控制图槽位的 mention 标签", () => {
  const CONTROL_ONLY: CanvasTaskInputBinding[] = [{
    field: "control_image", semantic: "reference-image", roles: ["control_image"],
    mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 1,
    valueFormat: "reference", label: "控制图", required: true, declaredSlot: true
  }];

  it("连线推断的 reference_image 对齐成控制图，token 标签也跟着换", () => {
    // 面板显示「控制图」而 prompt token 写「图片 1」时，用户 @ 出来的位置和实际落点对不上。
    const candidates = collectDirectMentionCandidates(canvasWithImageSource(), "target", undefined, CONTROL_ONLY);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ role: "control_image", label: "控制图" });
    // 提交形态的角色也必须是对齐后的槽位，否则服务端按原角色找不到落点。
    expect(candidates[0]!.input?.role).toBe("control_image");
  });

  it("没传 bindings 时保持推断角色与编号标签", () => {
    const candidates = collectDirectMentionCandidates(canvasWithImageSource(), "target");
    expect(candidates[0]).toMatchObject({ role: "reference_image", label: "图片 1" });
  });
});
