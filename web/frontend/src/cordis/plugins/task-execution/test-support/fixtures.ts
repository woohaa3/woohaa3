/**
 * 站点任务层测试夹具（仅被 `*.test.ts` 引用，不进入任何运行时路径）。
 *
 * 直接构造 `ServerCanvas`，而不是走 store 的提交 API：这样测试可以把"上游已产出资产"
 * 这类中间状态摆到任意形态，而不必先跑一遍任务。
 */
import { createEmptyWoohaa3ServerCanvas, createWoohaa3CanvasNode, toWoohaa3CanvasDocument, type CanvasNodeData, type ServerCanvas, type StoredAsset, type Woohaa3CanvasEdge } from "@woohaa3/contracts";
import { DEFAULT_TASK_TIMEOUT_MS,
  type CanvasTaskCatalog,
  type CanvasTaskCatalogModel } from "@woohaa3/contracts";

export const NOW = "2026-09-23T10:00:00.000Z";
export const STORAGE_KEY = `sha256-${"a".repeat(64)}`;
export const GENERATED_KEY = `generation-outputs/${"b".repeat(64)}.png`;

export type NodeSpec = {
  id: string;
  type: string;
  data?: CanvasNodeData;
};

export function canvasFixture(options: {
  nodes: NodeSpec[];
  edges?: Array<{ id: string; source: string; target: string }>;
  assets?: StoredAsset[];
}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-test", NOW);
  const edges: Woohaa3CanvasEdge[] = (options.edges ?? []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: null,
    targetHandle: null,
    data: {}
  }));
  const nodeData: Record<string, CanvasNodeData> = {};
  for (const spec of options.nodes) {
    if (spec.data) nodeData[spec.id] = spec.data;
  }
  return {
    ...base,
    document: toWoohaa3CanvasDocument(
      {
        nodes: options.nodes.map((spec) => createWoohaa3CanvasNode(spec.type, { x: 0, y: 0 }, spec.id)),
        edges
      },
      NOW
    ),
    nodeData,
    assets: options.assets ?? []
  };
}

export function imageAsset(overrides: Partial<StoredAsset> & { id: string }): StoredAsset {
  return {
    title: overrides.id,
    mediaKind: "image",
    source: "generated",
    status: "ready",
    url: `/api/media/${STORAGE_KEY}`,
    metadata: { storageKey: STORAGE_KEY, contentType: "image/png", size: 100, checksum: "a".repeat(64) },
    createdAt: NOW,
    ...overrides
  };
}

export function textAsset(overrides: Partial<StoredAsset> & { id: string }): StoredAsset {
  return {
    title: overrides.id,
    mediaKind: "text",
    source: "generated",
    status: "ready",
    text: "上游文本",
    createdAt: NOW,
    ...overrides
  };
}

export function catalogFixture(
  models: Array<Partial<CanvasTaskCatalogModel> & { modelKey: string }>,
  defaultModels: CanvasTaskCatalog["defaultModels"] = {}
): CanvasTaskCatalog {
  return {
    available: true,
    defaultModels,
    models: models.map((model) => ({
      providerId: "litellm",
      modelKey: model.modelKey,
      providerModelId: model.providerModelId ?? model.modelKey,
      modelType: model.modelType ?? "image",
      title: model.title ?? model.modelKey,
      interaction: model.interaction ?? { id: "generic-model", version: 1 },
      inputSchema: model.inputSchema ?? {
        type: "object",
        properties: {
          prompt: { type: "string", title: "提示词" },
          urls: { type: "array", maxItems: 16, "x-pptask-semantic": "reference-image" }
        }
      },
      defaultInput: model.defaultInput ?? { prompt: "", urls: [] },
      bindings: model.bindings ?? buildFixtureBindings(),
      taskTimeoutMs:
        model.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS[model.modelType ?? "image"],
      ...(model.promptRequirement ? { promptRequirement: model.promptRequirement } : {})
    }))
  };
}

function buildFixtureBindings() {
  // change: 2026-10-07-remove-residual-compatibility —— fixture 只产出 bindings。
  return [
    {
      field: "referenceImages",
      semantic: "reference-image" as const,
      roles: ["reference_image"],
      mediaKinds: ["image" as const],
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
      maxItems: 16,
      valueFormat: "url" as const
    }
  ];
}
