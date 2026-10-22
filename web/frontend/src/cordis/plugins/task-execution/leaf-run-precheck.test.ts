/**
 * 单节点可执行性纯预检测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 1.1 / design D4）。
 *
 * 非渲染回归：校验目录/模型/提示词/运行态与草稿分区规则——分组预览与提交都复用同一结果。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskCatalog, ServerCanvas } from "@woohaa3/contracts";
import { catalogFixture } from "./test-support/fixtures.js";
import { resolveLeafRunPrecheck, resolvePromptRequirementReason } from "./leaf-run-precheck.js";
import type { CatalogState } from "../../contracts.js";

const IMAGE_MODEL = "img-default";

function canvas(nodes: Array<{ id: string; type: string; parentId?: string }>, nodeData: Record<string, unknown> = {}): ServerCanvas {
  return {
    id: "c1",
    title: "测试",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: 0, y: 0 },
        ...(node.parentId ? { parentId: node.parentId } : {})
      })),
      edges: [],
      updatedAt: "2026-10-16T00:00:00.000Z"
    },
    nodeData: nodeData as never,
    assets: [],
    jobs: [],
    updatedAt: "2026-10-16T00:00:00.000Z"
  };
}

const READY_CATALOG = catalogFixture(
  [{ modelKey: IMAGE_MODEL, modelType: "image" }],
  { image: IMAGE_MODEL }
);

function precheck(input: {
  canvas?: ServerCanvas;
  nodeId?: string;
  catalog?: CanvasTaskCatalog | null;
  catalogState?: CatalogState;
  readDraft?: (nodeId: string, modelKey: string) => { prompt?: string; parameters?: Record<string, unknown> } | undefined;
  isBusy?: (nodeId: string) => boolean;
  isReserved?: (nodeId: string) => boolean;
}) {
  const catalog = input.catalog === undefined ? READY_CATALOG : input.catalog;
  return resolveLeafRunPrecheck({
    canvas: input.canvas ?? canvas([{ id: "a", type: "image" }], { a: { prompt: "画一只猫" } }),
    nodeId: input.nodeId ?? "a",
    catalog,
    catalogState: input.catalogState ?? { status: "ready", catalog: READY_CATALOG },
    ...(input.readDraft ? { readDraft: input.readDraft } : {}),
    ...(input.isBusy ? { isBusy: input.isBusy } : {}),
    ...(input.isReserved ? { isReserved: input.isReserved } : {})
  });
}

describe("resolvePromptRequirementReason（任务 1.1）", () => {
  it("required 需要非空提示词，optional/none 不需要", () => {
    expect(resolvePromptRequirementReason({ prompt: "x", promptRequirement: "required", upstreamTextEmpty: false })).toBeNull();
    expect(resolvePromptRequirementReason({ prompt: "", promptRequirement: "required", upstreamTextEmpty: false })).toBe("请先输入提示词");
    expect(resolvePromptRequirementReason({ prompt: "", promptRequirement: "optional", upstreamTextEmpty: false })).toBeNull();
    expect(resolvePromptRequirementReason({ prompt: "", promptRequirement: "none", upstreamTextEmpty: false })).toBeNull();
  });
});

describe("resolveLeafRunPrecheck（任务 1.1）", () => {
  it("合法成员返回可提交输入（参数带上 model）", () => {
    const result = precheck({});
    expect(result.eligible).toBe(true);
    expect(result.input).toMatchObject({ modelKey: IMAGE_MODEL, prompt: "画一只猫", expectedModelType: "image" });
    expect(result.input!.parameters).toMatchObject({ model: IMAGE_MODEL });
  });

  it("节点不存在或不支持执行时给出原因", () => {
    expect(precheck({ nodeId: "missing" })).toMatchObject({ eligible: false, reason: "节点已不存在" });
    expect(precheck({ canvas: canvas([{ id: "t", type: "text" }]), nodeId: "t" }).reason).toBeDefined();
  });

  it("运行态或本地预占时判为 running", () => {
    expect(precheck({ isBusy: () => true })).toMatchObject({ eligible: false, running: true, reason: "成员已在执行中" });
    expect(precheck({ isReserved: () => true })).toMatchObject({ eligible: false, running: true });
  });

  it("明确下线的模型保留身份并阻止提交，不自动替换", () => {
    const result = precheck({ canvas: canvas([{ id: "a", type: "image" }], { a: { prompt: "x", parameters: { model: "retired" } } }) });
    expect(result.eligible).toBe(false);
    expect(result.modelKey).toBe("retired");
    expect(result.reason).toContain("retired");
    expect(result.reason).toContain("不会自动替换");
  });

  it("未显式选模型时回落到目录默认", () => {
    expect(precheck({}).modelKey).toBe(IMAGE_MODEL);
  });

  it("目录无可用模型时阻止", () => {
    const emptyCatalog = catalogFixture([], {});
    const result = precheck({ catalog: emptyCatalog, catalogState: { status: "ready", catalog: emptyCatalog } });
    expect(result.eligible).toBe(false);
  });

  it("草稿按 {nodeId, modelKey} 分区覆盖规范值", () => {
    const withDraft = precheck({ readDraft: (nodeId, modelKey) => (nodeId === "a" && modelKey === IMAGE_MODEL ? { prompt: "草稿" } : undefined) });
    expect(withDraft.input?.prompt).toBe("草稿");
    // 无该分区草稿（modelKey 为空）不读取。
    const noPartition = precheck({ readDraft: (_nodeId, modelKey) => (modelKey === "" ? { prompt: "旧分区" } : undefined) });
    expect(noPartition.input?.prompt).toBe("画一只猫");
  });

  it("目录不可用（catalog=null）时由目录状态给出阻止原因", () => {
    expect(precheck({ catalog: null, catalogState: { status: "loading" } }).reason).toContain("任务目录尚未加载");
  });
});
