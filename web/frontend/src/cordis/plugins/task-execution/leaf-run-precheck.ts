/**
 * 单节点可执行性纯预检（change: 2026-10-16-add-group-selection-toolbar，任务 1.1 / design D4）。
 *
 * 单一共享规则：执行面板提交与分组批量执行/预览都经这里判定「这个成员现在能否提交、用什么
 * 输入」。禁止为分组计数复制一套近似规则。
 *
 * 复用既有单节点规则：
 * - 目录状态/模型能力/参考素材/生成模式约束走 `resolveBlockingReasons`（执行面板同一函数）；
 * - 提示词要求走 catalog `promptRequirement`（required/optional/none，与执行面板同一规则）；
 * - 模型身份按 `{nodeId, modelKey}` 草稿分区读取，草稿覆盖规范值；
 * - 未显式选择模型时回落到当前目录默认值；**明确选择但已下线的模型保留身份并阻止提交**，
 *   不自动替换（change: 2026-10-16-...：`动态目录 SHALL 更新所有提交入口且保留旧模型数据`）。
 *
 * 纯函数：不读 DOM、不发请求、不生成 runId。统一运行状态与本地批量预占由调用方注入谓词。
 */
import type {
  CanvasNodeData,
  CanvasTaskCatalog,
  CanvasTaskModelType,
  ServerCanvas
} from "@woohaa3/contracts";
import { EMPTY_UPSTREAM_TEXT_MESSAGE, upstreamTextIsEmpty } from "./prompt-derivation.js";
import { resolveBlockingReasons } from "./node-panel-helpers.js";
import { panelKindForNodeType, modelTypeForPanelKind, type NodePanelKind } from "./node-panel-registry.js";
import { resolveCatalogModelKey } from "./group-leaf-resolution.js";
import type { CatalogState } from "../../contracts.js";
import type { SubmitInput } from "./submit-coordinator.js";

/** 只读取 `{nodeId, modelKey}` 分区草稿所需的字段。 */
export type LeafRunDraft = {
  prompt?: string;
  parameters?: Record<string, unknown>;
};

export type LeafRunPrecheckInput = {
  canvas: ServerCanvas;
  nodeId: string;
  catalog: CanvasTaskCatalog | null;
  catalogState: CatalogState;
  readDraft?: (nodeId: string, modelKey: string) => LeafRunDraft | undefined;
  /** 统一运行状态：该节点是否已有非终态操作（任一 owner）。 */
  isBusy?: (nodeId: string) => boolean;
  /** 本页批量提交预占：该叶子是否已被本页批次占用（跨分组共享）。 */
  isReserved?: (nodeId: string) => boolean;
};

export type LeafRunPrecheck = {
  /** 当前是否可提交。 */
  eligible: boolean;
  /** 该成员是否处于统一运行态或已被本页批次预占（用于「成员均在运行中」原因）。 */
  running: boolean;
  /** 不可提交原因（`eligible` 为 false 时非空）。 */
  reason?: string;
  /** 解析出的模型身份（显式下线时保留原值）。 */
  modelKey: string;
  nodeType: string;
  panelKind: NodePanelKind | null;
  /** 可提交时的提交输入；否则 undefined。 */
  input?: Omit<SubmitInput, "nodeId">;
};

/** 读取规范 nodeData 的安全字段视图。 */
type CanonicalNodeData = {
  prompt?: unknown;
  parameters?: unknown;
  modelKey?: unknown;
  taskStatus?: unknown;
  status?: unknown;
};

function readCanonical(canvas: ServerCanvas, nodeId: string): CanonicalNodeData {
  return ((canvas.nodeData as Record<string, CanvasNodeData | undefined>)[nodeId] ?? {}) as CanonicalNodeData;
}

/**
 * 提示词要求判定（与执行面板 `handleSubmit` 共用）。
 *
 * `required` 模型保留既有非空提示词与上游文字规则；`optional`/`none` 允许无提示词提交。
 * 返回阻止原因或 null。
 */
export function resolvePromptRequirementReason(input: {
  prompt: string;
  promptRequirement: "required" | "optional" | "none";
  upstreamTextEmpty: boolean;
}): string | null {
  if (input.promptRequirement !== "required") return null;
  if (input.prompt.trim().length > 0) return null;
  return input.upstreamTextEmpty ? EMPTY_UPSTREAM_TEXT_MESSAGE : "请先输入提示词";
}

/**
 * 判定单个 node 当前能否批量提交，并给出提交输入（纯函数）。
 *
 * 顺序：模型可执行类型 → 运行态/预占 → 模型身份解析（显式下线阻止）→ 单节点阻止原因
 * （目录/参考/参数）→ 提示词要求。前一步阻止时不再读后续规则。
 */
export function resolveLeafRunPrecheck(input: LeafRunPrecheckInput): LeafRunPrecheck {
  const { canvas, nodeId, catalog, catalogState } = input;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  const panelKind = panelKindForNodeType(node?.type);
  const base: LeafRunPrecheck = { eligible: false, running: false, modelKey: "", nodeType: node?.type ?? "", panelKind };

  if (!node) return { ...base, reason: "节点已不存在" };
  if (!panelKind) return { ...base, reason: "该节点类型不支持执行任务" };

  const busy = (input.isBusy?.(nodeId) ?? false) || (input.isReserved?.(nodeId) ?? false);
  if (busy) return { ...base, running: true, reason: "成员已在执行中" };

  const data = readCanonical(canvas, nodeId);
  const canonicalParameters = (data.parameters && typeof data.parameters === "object")
    ? (data.parameters as Record<string, unknown>)
    : {};
  const modelType = modelTypeForPanelKind(panelKind);
  const explicitModel = readExplicitModel(canonicalParameters, data.modelKey);
  const catalogAvailable = Boolean(catalog?.available);
  // 明确选择但已下线的模型：保留身份并阻止提交，不自动替换（design D4 / 动态目录要求）。
  if (catalogAvailable && explicitModel !== "") {
    const known = catalog!.models.some(
      (entry) => entry.modelKey === explicitModel && entry.modelType === modelType
    );
    if (!known) {
      return {
        ...base,
        modelKey: explicitModel,
        reason: `模型 ${explicitModel} 当前不可用（可能已下线），不会自动替换`
      };
    }
  }
  const modelKey = catalogAvailable
    ? resolveCatalogModelKey(catalog!, modelType, explicitModel)
    : explicitModel;
  if (catalogAvailable && modelKey === "") {
    return { ...base, modelKey: explicitModel, reason: "该节点没有可用模型" };
  }

  const draft = input.readDraft?.(nodeId, modelKey);
  const draftPrompt = typeof draft?.prompt === "string" ? draft.prompt : undefined;
  const prompt = draftPrompt ?? (typeof data.prompt === "string" ? data.prompt : "");
  const parameters: Record<string, unknown> = {
    ...canonicalParameters,
    ...(draft?.parameters ?? {})
  };

  const blocking = resolveBlockingReasons({
    panelKind,
    nodeId,
    disabledReason: null,
    pendingSelection: false,
    catalog,
    catalogState,
    model: modelKey,
    canvas,
    panelParameters: parameters
  });
  if (blocking.length > 0) return { ...base, modelKey, reason: blocking[0]! };

  const model = catalog?.models.find((entry) => entry.modelKey === modelKey);
  const promptRequirement = model?.promptRequirement ?? "required";
  const promptReason = resolvePromptRequirementReason({
    prompt,
    promptRequirement,
    upstreamTextEmpty: upstreamTextIsEmpty(canvas, nodeId)
  });
  if (promptReason) return { ...base, modelKey, reason: promptReason };

  return {
    eligible: true,
    running: false,
    modelKey,
    nodeType: node.type,
    panelKind,
    input: {
      modelKey,
      prompt,
      // 与单节点提交一致：parameters 始终带上当前 model（= modelKey），避免草稿里的旧 model
      // 值与解析出的身份不一致。
      parameters: { ...parameters, model: modelKey },
      catalog: catalog!,
      expectedModelType: modelType as CanvasTaskModelType
    }
  };
}

/** 显式模型身份：草稿分区用 modelKey，这里只读规范 `parameters.model` / `nodeData.modelKey`。 */
function readExplicitModel(parameters: Record<string, unknown>, canonicalModelKey: unknown): string {
  if (typeof parameters.model === "string" && parameters.model !== "") return parameters.model;
  if (typeof canonicalModelKey === "string" && canonicalModelKey !== "") return canonicalModelKey;
  return "";
}
