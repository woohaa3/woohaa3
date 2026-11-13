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

describe("连线推断角色对齐模型声明的槽位", () => {
  /** 只声明 control_image 的模型（真实工作流的样子）。 */
  const ONLY_CONTROL: CanvasTaskInputBinding[] = [{
    field: "control_image", semantic: "reference-image", roles: ["control_image"],
    mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 1,
    valueFormat: "reference", label: "控制图", required: true, declaredSlot: true
  }];

  it("模型只声明控制图时，连进来的图片自动归到控制图", () => {
    // 实测踩过：图片源连线默认推断 reference_image，而工作流只声明 control_image，
    // 于是界面报「所选模型不接受参考角色 reference_image」+「缺少必填参考槽位」——
    // 功能明明支持，用户却看到一个自相矛盾的死局，而且没有任何入口能改。
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "reference_image", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: ONLY_CONTROL });

    expect(projection.items.map((item) => [item.role, item.status])).toEqual([["control_image", "ready"]]);
    expect(projection.blockingReasons).toEqual([]);
  });

  it("对齐到控制图后 tile 文案也换成槽位名，不再显示「图片 1」", () => {
    // 连线角色被对齐，但 tile 仍按 mention 类型编号 → 用户看到「图片 1」占着控制位置，
    // 会以为连错了。文案必须跟着对齐后的槽位走。
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "reference_image", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: ONLY_CONTROL });

    expect(projection.items[0]!.role).toBe("control_image");
    expect(projection.items[0]!.label).toBe("控制图");
  });

  it("模型有多个同类槽位时不猜，保持原角色并给出原因", () => {
    const twoImageSlots: CanvasTaskInputBinding[] = [
      { ...CONTROLNET_BINDINGS[0]!, field: "reference_image", roles: ["reference_image"], label: "参考图", required: false, declaredSlot: true },
      { ...CONTROLNET_BINDINGS[1]! }
    ];
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "style_reference", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: twoImageSlots });

    // 两个候选，不能替用户选；保留原角色让面板如实报"不接受"。
    expect(projection.items[0]!.role).toBe("style_reference");
    expect(projection.items[0]!.status).toBe("invalid");
  });

  it("模型本来接受该角色时不动它", () => {
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "reference_image", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: [CONTROLNET_BINDINGS[0]!] });
    expect(projection.items[0]!.role).toBe("reference_image");
    expect(projection.items[0]!.status).toBe("ready");
  });

  it("提交前的门禁也按对齐后的槽位校验，不再报不接受参考角色", () => {
    // 面板与门禁是两条路径：只修面板会出现「面板显示控制图就绪，提交却拦住」。
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "reference_image", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "gen-1", bindings: ONLY_CONTROL });

    expect(resolution.blockingReasons).toEqual([]);
    expect(resolution.references.map((reference) => reference.role)).toEqual(["control_image"]);
    expect(resolution.inputs.map((input) => input.role)).toEqual(["control_image"]);
  });

  it("模型有多个同类槽位时门禁不猜，如实报告不接受", () => {
    const twoImageSlots: CanvasTaskInputBinding[] = [
      { ...CONTROLNET_BINDINGS[0]!, required: false, declaredSlot: true },
      { ...CONTROLNET_BINDINGS[1]! }
    ];
    const canvas = canvasWith(
      [{ id: "img-1", type: "image", assetId: "a1" }],
      "gen-1",
      [{ sourceNodeId: "img-1", role: "style_reference", sortKey: "0" }]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"));
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "gen-1", bindings: twoImageSlots });

    expect(resolution.blockingReasons.some((reason) => reason.includes("不接受参考角色"))).toBe(true);
  });

  it("两条图片连线不会抢同一个控制图槽位", () => {
    const canvas = canvasWith(
      [
        { id: "img-1", type: "image", assetId: "a1" },
        { id: "img-2", type: "image", assetId: "a2" }
      ],
      "gen-1",
      [
        { sourceNodeId: "img-1", role: "style_reference", sortKey: "0" },
        { sourceNodeId: "img-2", role: "reference_image", sortKey: "1" }
      ]
    );
    (canvas.assets as unknown as StoredAsset[]).push(mediaAsset("a1", "image"), mediaAsset("a2", "image"));
    const projection = resolveReferenceItems({ canvas, nodeId: "gen-1", bindings: CONTROLNET_BINDINGS });

    // 第一个拿到唯一可用的 control_image，第二个保持原角色并报不接受。
    const roles = projection.items.map((item) => item.role);
    expect(roles.filter((role) => role === "control_image")).toHaveLength(1);
  });
});
