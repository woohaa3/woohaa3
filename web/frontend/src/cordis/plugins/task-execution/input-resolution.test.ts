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
      { assetId: "asset-a", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png", mediaKind: "image", field: "referenceImages" }
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

  it("镜头参考尚未冻结时说明等待录制，不报「上游没有输出」", () => {
    // 镜头参考的资产由「录制完成 → 冻结登记」写入 sourceAssetIds，预览节点本身不承载
    // outputAssetId；等待期间必须给出等待说法（任务 8.6，与服务端/参考 chips 一致）。
    const canvas = canvasFixture({
      nodes: [
        { id: "shot-preview:x", type: "film-set-shot-preview" },
        {
          id: "target",
          type: "video",
          data: {
            inputMapping: [
              { slotId: "slot-shot-ref", sourceNodeId: "shot-preview:x", role: "shot_reference", sortKey: "0" }
            ] as never
          }
        }
      ],
      edges: [{ id: "e1", source: "shot-preview:x", target: "target" }],
      assets: []
    });
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "target", bindings: [] });
    expect(resolution.blockingReasons).toEqual(["等待镜头参考录制完成"]);
    expect(resolution.inputs).toEqual([]);
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

describe("镜头参考按 provider 的 reference_video 角色校验", () => {
  const VIDEO_REFERENCE_CAPABILITY: CanvasTaskInputBinding[] = [
    {
      field: "referenceVideos",
      semantic: "reference-video",
      roles: ["reference_video"],
      mediaKinds: ["video"],
      mediaTypes: ["video/mp4", "video/webm"],
      maxItems: 3,
      valueFormat: "url"
    }
  ];

  function shotReferenceCanvas() {
    return canvasFixture({
      nodes: [
        { id: "shot-preview:x", type: "film-set-shot-preview" },
        {
          id: "target",
          type: "video",
          data: {
            inputMapping: [
              {
                slotId: "slot-shot-ref",
                sourceNodeId: "shot-preview:x",
                role: "shot_reference",
                sortKey: "0",
                sourceAssetIds: ["asset-shot"]
              }
            ] as never
          }
        }
      ],
      edges: [{ id: "e1", source: "shot-preview:x", target: "target" }],
      assets: [
        imageAsset({
          id: "asset-shot",
          mediaKind: "video",
          metadata: { storageKey: "media/shot-ref.mp4", contentType: "video/mp4", size: 10, checksum: "e".repeat(64) }
        })
      ]
    });
  }

  it("模型有 reference_video 绑定时不阻止，并以 reference_video 提交", () => {
    const resolution = resolveNodeReferenceInputs({
      canvas: shotReferenceCanvas(),
      nodeId: "target",
      bindings: VIDEO_REFERENCE_CAPABILITY
    });
    expect(resolution.blockingReasons).toEqual([]);
    expect(resolution.references[0].role).toBe("reference_video");
    expect(resolution.inputs).toEqual([
      {
        assetId: "asset-shot",
        role: "reference_video",
        storageKey: "media/shot-ref.mp4",
        mediaType: "video/mp4",
        mediaKind: "video",
        field: "referenceVideos"
      }
    ]);
  });

  it("模型没有视频参考绑定时给出 reference_video 原因，不回显画布内部角色", () => {
    const resolution = resolveNodeReferenceInputs({
      canvas: shotReferenceCanvas(),
      nodeId: "target",
      bindings: IMAGE_CAPABILITY
    });
    expect(resolution.inputs).toEqual([]);
    expect(resolution.blockingReasons).toEqual([
      "所选模型不接受参考角色「reference_video」或媒体类型「video」"
    ]);
    expect(resolution.blockingReasons.join(" ")).not.toContain("shot_reference");
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
    expect(Object.keys(resolution.inputs[0]).sort()).toEqual(["assetId", "field", "mediaKind", "mediaType", "role", "storageKey"]);
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
