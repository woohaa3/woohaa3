/**
 * 上游参考资产解析测试（任务 4.1–4.5）。
 *
 * 覆盖 spec `canvas-reference-inputs`：
 * - 从 incoming edges + inputMapping 解析，显式 sourceAssetIds 优先；
 * - 只接受 ready 图片资产并保留 role / 顺序；
 * - 缺失、非图片、未 ready、跨画布资产、模型不支持都形成 blocking reason；
 * - 提交形态只含稳定媒体引用；
 * - 画布变化后重算（不沿用旧快照）。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskInputBinding } from "@woohaa3/contracts";
import { createDefaultWorldCameraData, createWorldAnimationScript } from "@woohaa3/contracts";
import { GENERATED_KEY,
  STORAGE_KEY,
  canvasFixture,
  imageAsset,
  textAsset } from "./test-support/fixtures.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";

const IMAGE_CAPABILITY: CanvasTaskInputBinding[] = [
  {
    field: "referenceImages",
    semantic: "reference-image",
    roles: ["reference_image", "first_frame"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    maxItems: 4,
    valueFormat: "url"
  }
];

const TEXT_ONLY_CAPABILITY: CanvasTaskInputBinding[] = [];

function upstreamCanvas(options: {
  outputAssetId?: string;
  assets?: ReturnType<typeof imageAsset>[];
  inputMapping?: unknown;
  extraNodes?: Array<{ id: string; type: string }>;
  extraEdges?: Array<{ id: string; source: string; target: string }>;
}) {
  return canvasFixture({
    nodes: [
      {
        id: "up-1",
        type: "image",
        data: options.outputAssetId ? { outputAssetId: options.outputAssetId } : {}
      },
      {
        id: "target",
        type: "image",
        data: options.inputMapping ? { inputMapping: options.inputMapping as never } : {}
      },
      ...(options.extraNodes ?? [])
    ],
    edges: [{ id: "e1", source: "up-1", target: "target" }, ...(options.extraEdges ?? [])],
    assets: options.assets
  });
}

describe("解析上游图片输出", () => {
  it("defers camera pixels to the host while checking reference type and item limits", () => {
    const canvas = upstreamCanvas({});
    canvas.document.nodes.find(node => node.id === "up-1")!.type = "world-camera";
    canvas.nodeData["up-1"] = { worldCamera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }) } as never;
    const result = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(result.blockingReasons).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(result.deferredReferences).toEqual([{ role: "reference_image", mediaKind: "image" }]);
    expect(resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: [] }).blockingReasons).toHaveLength(1);
    expect(resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: [{ ...IMAGE_CAPABILITY[0], maxItems: 0 }] }).blockingReasons).toHaveLength(1);
  });
  it("上游 outputAssetId 指向 ready 图片资产时进入任务输入", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a" })]
    });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "target",
      bindings: IMAGE_CAPABILITY
    });
    expect(resolution.blockingReasons).toEqual([]);
    expect(resolution.inputs).toEqual([
      { assetId: "asset-a", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png", mediaKind: "image" }
    ]);
  });

  it("显式 sourceAssetIds 优先于 source node 的 outputAssetId", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-old",
      inputMapping: [
        { slotId: "slot-up-1-0", sourceNodeId: "up-1", role: "reference_image", sortKey: "0", sourceAssetIds: ["asset-explicit"] }
      ],
      assets: [
        imageAsset({ id: "asset-old" }),
        imageAsset({ id: "asset-explicit", metadata: { storageKey: GENERATED_KEY, contentType: "image/webp", size: 5, checksum: "b".repeat(64) } })
      ]
    });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "target",
      bindings: IMAGE_CAPABILITY
    });
    expect(resolution.blockingReasons).toEqual([]);
    expect(resolution.inputs.map((input) => input.assetId)).toEqual(["asset-explicit"]);
    expect(resolution.inputs[0].storageKey).toBe(GENERATED_KEY);
    expect(resolution.inputs[0].mediaType).toBe("image/webp");
    // 显式映射的 slotId / role / sortKey 都被保留下来（便于诊断）。
    expect(resolution.references[0].slotId).not.toBe("");
    expect(resolution.references[0].role).toBe("reference_image");
    expect(resolution.references[0].sortKey).toBe("0");
  });

  it("多条入边按连线顺序解析，且顺序稳定", () => {
    const canvas = canvasFixture({
      nodes: [
        { id: "up-a", type: "image", data: { outputAssetId: "asset-a" } },
        { id: "up-b", type: "image", data: { outputAssetId: "asset-b" } },
        { id: "target", type: "image" }
      ],
      edges: [
        { id: "e1", source: "up-a", target: "target" },
        { id: "e2", source: "up-b", target: "target" }
      ],
      assets: [imageAsset({ id: "asset-a" }), imageAsset({ id: "asset-b" })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.inputs.map((input) => input.assetId)).toEqual(["asset-a", "asset-b"]);
  });

  it("没有上游连线时不产生输入也不产生阻止原因", () => {
    const canvas = canvasFixture({ nodes: [{ id: "target", type: "image" }] });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.inputs).toEqual([]);
    expect(resolution.blockingReasons).toEqual([]);
  });
});

describe("失效参考输入形成阻止原因", () => {
  it("上游还没有输出", () => {
    const canvas = upstreamCanvas({});
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("还没有可用输出");
  });

  it("引用的资产不在当前画布中", () => {
    const canvas = upstreamCanvas({ outputAssetId: "asset-missing" });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("不在当前画布中");
  });

  it("资产未 ready", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a", status: "generating" })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("尚未就绪");
  });

  it("连入的文字节点不当作图片参考", () => {
    const canvas = canvasFixture({
      nodes: [
        { id: "up-1", type: "text", data: { outputAssetId: "asset-t" } },
        { id: "target", type: "image" }
      ],
      edges: [{ id: "e1", source: "up-1", target: "target" }],
      assets: [textAsset({ id: "asset-t", title: "文本结果", text: "一只猫" })]
    });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "target",
      bindings: IMAGE_CAPABILITY
    });
    expect(resolution.blockingReasons).toEqual([]);
    expect(resolution.inputs).toEqual([]);
  });

  it("资产不是可引用的媒体类型", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-t",
      assets: [textAsset({ id: "asset-t" })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("不是可引用的媒体");
  });

  it("图片资产缺少稳定 storageKey", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a", metadata: { contentType: "image/png" } })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("缺少稳定 storageKey");
  });

  it("模型不接受参考图时明确阻止，而不是静默丢弃上游输入", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a" })]
    });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "target",
      bindings: TEXT_ONLY_CAPABILITY
    });
    expect(resolution.inputs).toEqual([]);
    expect(resolution.blockingReasons).toEqual(["所选模型不接受参考角色「reference_image」或媒体类型「image」"]);
  });

  it("参考图数量超过模型上限", () => {
    const canvas = canvasFixture({
      nodes: [
        { id: "up-a", type: "image", data: { outputAssetId: "asset-a" } },
        { id: "up-b", type: "image", data: { outputAssetId: "asset-b" } },
        { id: "target", type: "image" }
      ],
      edges: [
        { id: "e1", source: "up-a", target: "target" },
        { id: "e2", source: "up-b", target: "target" }
      ],
      assets: [imageAsset({ id: "asset-a" }), imageAsset({ id: "asset-b" })]
    });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "target",
      bindings: [{ ...IMAGE_CAPABILITY[0]!, maxItems: 1 }]
    });
    expect(resolution.blockingReasons[0]).toContain("超过模型对 referenceImages 的上限");
  });

  it("role 不被模型接受时阻止", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      inputMapping: [{ sourceNodeId: "up-1", role: "style_reference", sortKey: "0" }],
      assets: [imageAsset({ id: "asset-a" })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("不接受参考角色");
  });

  it("参考图 media type 不被模型接受时阻止", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a", metadata: { storageKey: STORAGE_KEY, contentType: "image/gif", size: 1, checksum: "c".repeat(64) } })]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons[0]).toContain("不接受参考类型");
  });
});

describe("提交形态只含稳定媒体引用", () => {
  it("不含 bytes / url / 签名参数", () => {
    const canvas = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [
        imageAsset({
          id: "asset-a",
          url: "/api/media/" + STORAGE_KEY,
          metadata: { storageKey: STORAGE_KEY, contentType: "image/png", size: 1, checksum: "d".repeat(64) }
        })
      ]
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    const serialized = JSON.stringify(resolution.inputs);
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("blob:");
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain("base64");
    expect(Object.keys(resolution.inputs[0]).sort()).toEqual(["assetId", "mediaKind", "mediaType", "role", "storageKey"]);
  });
});

describe("画布变化后重算（不沿用旧快照）", () => {
  it("上游 outputAssetId 更新后解析结果随之变化", () => {
    const before = upstreamCanvas({
      outputAssetId: "asset-a",
      assets: [imageAsset({ id: "asset-a" }), imageAsset({ id: "asset-b" })]
    });
    const after = upstreamCanvas({
      outputAssetId: "asset-b",
      assets: [imageAsset({ id: "asset-a" }), imageAsset({ id: "asset-b" })]
    });
    const options = { nodeId: "target", bindings: IMAGE_CAPABILITY };
    expect(resolveNodeReferenceInputs({ canvas: before, ...options }).inputs[0].assetId).toBe("asset-a");
    expect(resolveNodeReferenceInputs({ canvas: after, ...options }).inputs[0].assetId).toBe("asset-b");
  });

  it("上游连线被删除后不再产生输入", () => {
    const withEdge = canvasFixture({
      nodes: [
        { id: "up-1", type: "image", data: { outputAssetId: "asset-a" } },
        { id: "target", type: "image" }
      ],
      edges: [{ id: "e1", source: "up-1", target: "target" }],
      assets: [imageAsset({ id: "asset-a" })]
    });
    const withoutEdge = canvasFixture({
      nodes: [
        { id: "up-1", type: "image", data: { outputAssetId: "asset-a" } },
        { id: "target", type: "image" }
      ],
      assets: [imageAsset({ id: "asset-a" })]
    });
    const options = { nodeId: "target", bindings: IMAGE_CAPABILITY };
    expect(resolveNodeReferenceInputs({ canvas: withEdge, ...options }).inputs).toHaveLength(1);
    expect(resolveNodeReferenceInputs({ canvas: withoutEdge, ...options }).inputs).toHaveLength(0);
  });

  it("资产被移除后立刻变为阻止状态", () => {
    const withAsset = upstreamCanvas({ outputAssetId: "asset-a", assets: [imageAsset({ id: "asset-a" })] });
    const withoutAsset = upstreamCanvas({ outputAssetId: "asset-a" });
    const options = { nodeId: "target", bindings: IMAGE_CAPABILITY };
    expect(resolveNodeReferenceInputs({ canvas: withAsset, ...options }).blockingReasons).toEqual([]);
    expect(
      resolveNodeReferenceInputs({ canvas: withoutAsset, ...options }).blockingReasons[0]
    ).toContain("不在当前画布中");
  });

  it("目标节点不存在时返回明确原因", () => {
    const canvas = canvasFixture({ nodes: [{ id: "other", type: "image" }] });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(resolution.blockingReasons).toEqual(["节点 target 不存在"]);
  });
});

describe("镜头参考按派生类型分流", () => {
  const VIDEO_CAPABILITY: CanvasTaskInputBinding[] = [
    {
      field: "referenceVideos",
      semantic: "reference-video",
      roles: ["reference_video"],
      mediaKinds: ["video"],
      mediaTypes: ["video/mp4"],
      maxItems: 1,
      valueFormat: "url"
    }
  ];

  function animatedCameraCanvas() {
    const canvas = upstreamCanvas({});
    canvas.document.nodes.find(node => node.id === "up-1")!.type = "world-camera";
    canvas.nodeData["up-1"] = { worldCamera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }) } as never;
    canvas.document.nodes.push({ id: "area", type: "scene-area" });
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
    return canvas;
  }

  it("动态镜头解析为 reference_video，不降级成图片", () => {
    const canvas = animatedCameraCanvas();
    const video = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: VIDEO_CAPABILITY });
    expect(video.blockingReasons).toEqual([]);
    expect(video.deferredReferences).toEqual([{ role: "reference_video", mediaKind: "video" }]);

    // 只有图片能力的模型明确拒绝，而不是把视频当图片。
    const imageOnly = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(imageOnly.deferredReferences).toEqual([]);
    expect(imageOnly.blockingReasons.join("")).toContain("视频参考");
  });

  it("静态镜头仍按 reference_image 解析", () => {
    const canvas = upstreamCanvas({});
    canvas.document.nodes.find(node => node.id === "up-1")!.type = "world-camera";
    canvas.nodeData["up-1"] = { worldCamera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }) } as never;
    const result = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: IMAGE_CAPABILITY });
    expect(result.deferredReferences).toEqual([{ role: "reference_image", mediaKind: "image" }]);
  });
});
