/**
 * 模型声明的参考槽位（ControlNet 一类）在参考区与门禁上的行为。
 *
 * 关键约束：控制图与内容参考图同属图片但语义不同，投影必须保持各自独立；
 * 必填槽位未填充要在提交前拦住，但不得静默丢素材或按顺序改绑。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskInputBinding, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { resolveReferenceItems } from "./reference-items.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";
import { planFillSlot } from "./reference-command-plan.js";

function mediaAsset(
  id: string,
  mediaKind: "image" | "video" | "audio",
  status: StoredAsset["status"] = "ready"
): StoredAsset {
  const contentType = mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "audio/mpeg";
  return {
    id,
    title: id,
    mediaKind,
    source: "generated",
    status,
    createdAt: "2026-11-12T00:00:00.000Z",
    metadata: { storageKey: `canvas/media/${id}`, contentType }
  };
}

function canvasWith(
  sources: Array<{ id: string; type: string; assetId?: string }>,
  target = "gen-1",
  mappings?: Array<{ sourceNodeId: string; role: string; sortKey?: string }>
): ServerCanvas {
  return {
    id: "canvas-1",
    revision: 1,
    document: {
      version: 1,
      nodes: [
        { id: target, type: "image", position: { x: 0, y: 0 } },
        ...sources.map((source, index) => ({
          id: source.id,
          type: source.type,
          position: { x: index * 100, y: 200 }
        }))
      ],
      edges: sources.map((source) => ({ id: `e-${source.id}`, source: source.id, target }))
    },
    nodeData: {
      [target]: { inputMapping: mappings ?? [] },
      ...Object.fromEntries(
        sources.map((source) => [source.id, source.assetId ? { outputAssetId: source.assetId } : {}])
      )
    },
    assets: [],
    updatedAt: new Date(0).toISOString()
  } as unknown as ServerCanvas;
}

const CONTROLNET_BINDINGS: CanvasTaskInputBinding[] = [
  {
    field: "reference_image",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png"],
    maxItems: 10,
    valueFormat: "reference",
    label: "参考图",
    declaredSlot: true
  },
  {
    field: "control_image",
    semantic: "reference-image",
    roles: ["control_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png"],
    maxItems: 1,
    valueFormat: "reference",
    label: "控制图",
    required: true,
    declaredSlot: true
  }
];

describe("声明槽位投影", () => {
  it("未填充的槽位出现在参考区且不带素材", () => {
    const canvas = canvasWith([]);
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: CONTROLNET_BINDINGS });

    const empty = projection.items.filter((item) => item.status === "empty");
    expect(empty.map((item) => item.role)).toEqual(["reference_image", "control_image"]);
    // 空槽位不能伪造素材：没有 assetId，也没有预览地址。
    for (const item of empty) {
      expect(item.assetId).toBeNull();
      expect(item.previewUrl).toBeNull();
      expect(item.slotId).toBe("");
    }
    // 必填项进阻止原因，可选槽位不进。
    expect(projection.blockingReasons).toEqual(["缺少必填参考槽位：控制图"]);
    expect(empty.find((item) => item.role === "control_image")?.required).toBe(true);
  });

  it("已填充的槽位不再重复出现空位", () => {
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "control_image", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));

    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: CONTROLNET_BINDINGS });
    // 控制图已填、参考图仍空：两个槽位各自一条，不合并。
    expect(projection.items.map((item) => [item.role, item.status])).toEqual([
      ["control_image", "ready"],
      ["reference_image", "empty"]
    ]);
    expect(projection.blockingReasons).toEqual([]);
  });

  it("没有绑定声明时不凭空造空槽", () => {
    // authoring 入口不传绑定，它没有"模型声明"这件事。
    const projection = resolveReferenceItems({ canvas: canvasWith([]), nodeId: "gen-1" });
    expect(projection.items).toEqual([]);
  });

  it("按类型兜底的绑定不产生空槽", () => {
    // 视频模型的默认绑定里带 first_frame / last_frame，那表达的是"这类模型可以接"，
    // 不是"这个模型正在等首帧"。给它们都渲染空位会让参考区多出没人用的位置。
    const fallback: CanvasTaskInputBinding[] = [
      {
        field: "urls",
        semantic: "reference-image",
        roles: ["reference_image", "first_frame", "last_frame"],
        mediaKinds: ["image"],
        mediaTypes: ["image/png"],
        maxItems: 4,
        valueFormat: "url"
      }
    ];
    const projection = resolveReferenceItems({ canvas: canvasWith([]), nodeId: "gen-1", bindings: fallback });
    expect(projection.items).toEqual([]);
    expect(projection.blockingReasons).toEqual([]);
  });
});

describe("必填槽位门禁", () => {
  it("未填充时阻止提交，填充后放行", () => {
    const empty = canvasWith([]);
    const blocked = resolveNodeReferenceInputs({ canvas: empty, nodeId: "gen-1", bindings: CONTROLNET_BINDINGS });
    expect(blocked.blockingReasons).toContain("缺少必填参考槽位：控制图");

    const filled = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "control_image", sortKey: "0" }]
    );
    (filled.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const passed = resolveNodeReferenceInputs({ canvas: filled, nodeId: "gen-1", bindings: CONTROLNET_BINDINGS });
    expect(passed.blockingReasons).toEqual([]);
    expect(passed.references.map((reference) => reference.role)).toEqual(["control_image"]);
  });
});

describe("填槽命令", () => {
  it("显式写入槽位角色，并原子加边", () => {
    const canvas = canvasWith([]);
    const commands = planFillSlot(canvas, "gen-1", { role: "control_image", sourceNodeId: "img-9" });
    expect(commands).not.toBeNull();
    const patch = commands!.find((command) => command.type === "nodeData.patch");
    expect(patch).toBeDefined();
    // 角色必须显式落到 mapping 上：推断只会产出内置角色，控制图根本推断不出来。
    const mapping = (patch as { value: { inputMapping: Array<{ role: string; sourceNodeId: string }> } })
      .value.inputMapping[0];
    expect(mapping?.role).toBe("control_image");
    expect(mapping?.sourceNodeId).toBe("img-9");
    expect(commands!.some((command) => command.type === "edge.add")).toBe(true);
  });

  it("槽位已被占用时拒绝覆盖", () => {
    // 覆盖会让已有 mention 悄悄指向另一张素材。
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "control_image" }]
    );
    expect(planFillSlot(canvas, "gen-1", { role: "control_image", sourceNodeId: "img-2" })).toBeNull();
  });

  it("同一来源不能占两个槽位", () => {
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "reference_image" }]
    );
    expect(planFillSlot(canvas, "gen-1", { role: "control_image", sourceNodeId: "img-1" })).toBeNull();
  });
});
