/**
 * group 批量运行协调器（change: add-canvas-node-grouping，任务 3.3/3.4 / design D4）。
 *
 * 用户对选中 group 执行「运行」时：递归展开其非 group 后代，过滤为**具备有效任务配置且
 * 非 pending** 的叶子节点，再逐个复用既有单节点提交路径（`SubmitCoordinator`）。
 *
 * 不变式：
 * - group 本身 MUST NOT 作为 run 请求的 nodeId；
 * - 逐个提交：某一成员失败不撤销其它已受理成员（不提供事务回滚）；
 * - 不伪造成功、不写回任务状态——终态仍只由服务端 projector 写入 canonical。
 *
 * 纯逻辑 + 注入依赖，便于单测（不依赖 DOM / fetch）。
 */
import type { CanvasTaskCatalog, CanvasTaskModelType } from "@woohaa3/contracts";
import type { SubmitCoordinator, SubmitInput } from "./submit-coordinator.js";

/** 批量运行的叶子节点描述：由调用方从 canonical nodeData 解析。 */
export type BatchRunLeaf = {
  nodeId: string;
  /** 该节点是否有可用任务配置（模型 + prompt）；false 视为不可运行，跳过。 */
  runnable: boolean;
  /** 已解析的提交输入；`runnable` 为 true 时必填。 */
  input?: Omit<SubmitInput, "nodeId">;
  /** 该节点是否已经在执行/待执行（pending），跳过不重发。 */
  pending?: boolean;
};

export type BatchRunSummary = {
  accepted: string[];
  skipped: Array<{ nodeId: string; reason: string }>;
  failed: Array<{ nodeId: string; error: string }>;
};

export type BatchRunOptions = {
  coordinator: Pick<SubmitCoordinator, "submit">;
  /** 递归展开 group 的可运行叶子（调用方负责 parentId 遍历与 nodeData 解析）。 */
  resolveLeaves: (groupNodeId: string) => readonly BatchRunLeaf[];
  onResult?: (summary: BatchRunSummary) => void;
};

export type BatchRunner = {
  /** 运行一个 group 的全部可运行叶子；返回汇总，不抛异常。 */
  runGroup(groupNodeId: string): Promise<BatchRunSummary>;
};

/**
 * 递归展开 group 的非 group 后代（change: add-canvas-node-grouping，任务 3.3）。
 *
 * `parentId` 是成员关系的唯一事实源；本函数不读 nodeData。
 */
export function collectGroupLeafDescendants(
  nodes: readonly { id: string; type: string; parentId?: string }[],
  groupNodeId: string
): string[] {
  const childrenByParent = new Map<string, Array<{ id: string; type: string }>>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push({ id: node.id, type: node.type });
    childrenByParent.set(node.parentId, list);
  }
  const leaves: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of childrenByParent.get(id) ?? []) {
      if (child.type === "group") visit(child.id);
      else leaves.push(child.id);
    }
  };
  visit(groupNodeId);
  return leaves;
}

export function createBatchRunner(options: BatchRunOptions): BatchRunner {
  return {
    async runGroup(groupNodeId) {
      const summary: BatchRunSummary = { accepted: [], skipped: [], failed: [] };
      for (const leaf of options.resolveLeaves(groupNodeId)) {
        // group 自身永远不作为 run 目标：展开结果只应包含非 group 叶子。
        if (leaf.pending) {
          summary.skipped.push({ nodeId: leaf.nodeId, reason: "已在执行中" });
          continue;
        }
        if (!leaf.runnable || !leaf.input) {
          summary.skipped.push({ nodeId: leaf.nodeId, reason: "缺少可执行的任务配置" });
          continue;
        }
        // 逐个提交：单项失败不中断、不回滚已受理项。
        const outcome = await options.coordinator.submit({ nodeId: leaf.nodeId, ...leaf.input });
        if (outcome.ok) summary.accepted.push(leaf.nodeId);
        else summary.failed.push({ nodeId: leaf.nodeId, error: outcome.error });
      }
      options.onResult?.(summary);
      return summary;
    }
  };
}

/** 供调用方构造 `BatchRunLeaf.input` 的最小字段（类型别名，避免重复）。 */
export type BatchRunLeafInput = {
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  catalog: CanvasTaskCatalog;
  expectedModelType: CanvasTaskModelType;
};

/** 单节点未提交草稿（与 `nodeDraftStore` 的 `NodeExecutionDraft` 同形，避免反向依赖）。 */
export type GroupRunDraft = {
  prompt?: string;
  parameters?: Record<string, unknown>;
};

/** catalog 模型的稳定身份（opaque modelKey）。 */
export function catalogModelIdentity(model: { modelKey: string }): string {
  return model.modelKey;
}

/**
 * 解析某面板 kind 最终使用的模型身份。
 *
 * 与 `ExecutionPanel` 的语义一致：显式选择只有在目录里是合法选项时才生效，否则回落到
 * `catalog.defaultModels[kind]`（合法时）或该 kind 的第一个模型。目录不可用时原样退回显式值。
 */
export function resolveCatalogModelKey(
  catalog: CanvasTaskCatalog,
  modelType: CanvasTaskModelType,
  candidate: string
): string {
  if (!catalog.available) return candidate;
  const options = catalog.models.filter((model) => model.modelType === modelType);
  if (options.some((model) => catalogModelIdentity(model) === candidate)) return candidate;
  const configured = catalog.defaultModels?.[modelType];
  if (configured && options.some((model) => catalogModelIdentity(model) === configured)) {
    return configured;
  }
  return options[0] ? catalogModelIdentity(options[0]) : "";
}

/**
 * 从画布解析 group 的可运行叶子（change: add-canvas-node-grouping，任务 3.4；
 * change: fix-group-and-marquee-preview）。
 *
 * 复用单节点的既有语义：
 * - 递归展开非 group 后代（`parentId` 是唯一事实源）；
 * - 叶子必须有 `panelKind`（即节点类型可执行）、非空 prompt、有效 modelKey；
 * - 已在执行/待执行（`taskStatus` 属于 pending/queued/processing/running）的叶子标记为
 *   pending，由协调器跳过而不重发；
 * - group 本身不会出现在返回结果里。
 *
 * **数据来源必须与单节点面板一致**：单节点运行合并「未提交草稿 + 规范 nodeData」，并在模型
 * 未显式选择时回落到目录默认模型。只读规范 `nodeData` 会让「刚写好 prompt、还没单独运行过」
 * 的成员全部被判为不可运行，表现为点「运行」毫无反应。因此这里同样做合并与默认回落。
 *
 * 纯函数：不读 DOM、不发请求；草稿、目录与默认模型都由调用方注入。
 */
export function resolveGroupRunLeaves(
  canvas: { document: { nodes: readonly { id: string; type: string; parentId?: string }[] }; nodeData: Record<string, unknown> },
  groupNodeId: string,
  deps: {
    panelKindForNodeType: (nodeType: string) => string | null;
    modelTypeForPanelKind: (panelKind: string) => CanvasTaskModelType;
    catalog: CanvasTaskCatalog;
    /**
     * 读取节点的未提交草稿（可选；缺省视为无草稿）。
     *
     * `modelKey` 是按 `{nodeId, modelKey}` 分区后的草稿键（强制要求）。
     */
    readDraft?: (nodeId: string, modelKey: string) => GroupRunDraft | undefined;
    /**
     * 解析叶子最终使用的模型（可选）。与执行面板一致：显式选择只有在目录里是合法选项时
     * 才生效，否则回落到该面板 kind 的默认模型。缺省时直接用规范节点里的值。
     */
    resolveModel?: (panelKind: string, candidate: string) => string;
  }
): BatchRunLeaf[] {
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const leafIds = collectGroupLeafDescendants(canvas.document.nodes, groupNodeId);
  return leafIds.map((nodeId) => {
    const node = nodeById.get(nodeId);
    const panelKind = deps.panelKindForNodeType(node?.type ?? "");
    const data = (canvas.nodeData[nodeId] ?? {}) as {
      prompt?: unknown;
      parameters?: unknown;
      modelKey?: unknown;
      taskStatus?: unknown;
      status?: unknown;
    };
    // 模型身份只来自规范 `parameters.model` / `nodeData.modelKey`（change:
    // 2026-10-07-remove-residual-compatibility：删除旧「无模型分区」草稿回退）。
    const canonicalParameters = (data.parameters && typeof data.parameters === "object")
      ? (data.parameters as Record<string, unknown>)
      : {};
    const canonicalModel = typeof canonicalParameters.model === "string" && canonicalParameters.model !== ""
      ? canonicalParameters.model
      : (typeof data.modelKey === "string" ? data.modelKey : "");
    const modelKey = panelKind
      ? (deps.resolveModel ? deps.resolveModel(panelKind, canonicalModel) : canonicalModel)
      : "";
    // 草稿严格按 `{nodeId, modelKey}` 分区读取。
    const draft = modelKey !== "" ? deps.readDraft?.(nodeId, modelKey) : undefined;
    // 与单节点面板相同的合并顺序：草稿覆盖规范值。
    const draftPrompt = typeof draft?.prompt === "string" ? draft.prompt : undefined;
    const prompt = draftPrompt ?? (typeof data.prompt === "string" ? data.prompt : "");
    const parameters: Record<string, unknown> = {
      ...canonicalParameters,
      ...(draft?.parameters ?? {})
    };
    const status = typeof data.taskStatus === "string" ? data.taskStatus : typeof data.status === "string" ? data.status : "";
    const pending = ["pending", "queued", "processing", "running"].includes(status);
    const runnable = !!panelKind && prompt.trim().length > 0 && modelKey.length > 0;
    if (!runnable) return { nodeId, runnable: false, pending };
    return {
      nodeId,
      runnable: true,
      pending,
      input: {
        modelKey,
        prompt,
        // 与单节点提交一致：parameters 始终带上当前 model（= modelKey），避免草稿里的旧
        // model 值与解析出的身份不一致。
        parameters: { ...parameters, model: modelKey },
        catalog: deps.catalog,
        expectedModelType: deps.modelTypeForPanelKind(panelKind!)
      }
    };
  });
}
