import {
  applyCanvasCommands,
  decodeModelContentVersion,
  isFilmSetNode,
  isModelAuthoringNodeType,
  MODEL_SCRIPT_LANGUAGE,
  readModelCameras,
  v2SceneAabb,
  type CanvasCommand,
  type CanvasNodeData,
  type GetModelNodesInput,
  type ModelBatchFailure,
  type ModelBatchIssue,
  type ModelBatchNodeSummary,
  type ModelNodesOutcome,
  type ModelScriptBatchMeta,
  type ModelScriptBatchOutcome,
  type ModelScriptBatchRequest,
  type ServerCanvas,
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { ModelMcpServiceDependencies } from "./service-types.js";
import { executeSceneIr } from "./script-executor.js";
import { projectModelNode } from "./model-reader.js";
import { decodeModelBatch, digest, failure } from "./batch-input.js";
import { registerModelHistorySafely } from "./script-submission.js";

export type ModelBatchContext = {
  principalId: string;
  authorize?: () => Promise<boolean>;
};
const camerasHash = (data: CanvasNodeData | undefined) =>
  digest(readModelCameras(data));
const authorized = async (context: ModelBatchContext) =>
  Boolean(context.principalId.trim()) &&
  (!context.authorize || (await context.authorize().catch(() => false)));

export async function getModelNodes(
  deps: ModelMcpServiceDependencies,
  input: GetModelNodesInput,
): Promise<ModelNodesOutcome> {
  if (
    !input.canvasId?.trim() ||
    !Array.isArray(input.nodeIds) ||
    input.nodeIds.length < 1 ||
    input.nodeIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(input.nodeIds).size !== input.nodeIds.length ||
    (input.includeSource !== undefined &&
      typeof input.includeSource !== "boolean")
  )
    return failure(
      "malformed-request",
      "nodeIds 必须为有界且无重复的非空节点列表",
    );
  const room = await deps.resolveRoom(input.canvasId);
  if (!room) return failure("canvas-not-found", "画布不存在");
  return room.inspectPublished((snapshot) => {
    if (!snapshot.ok) return failure("canvas-unavailable", snapshot.message);
    const nodes: Extract<ModelNodesOutcome, { ok: true }>["nodes"] = [];
    for (const nodeId of input.nodeIds) {
      const node = projectModelNode(snapshot.canvas, nodeId);
      if (!node.ok) return node;
      const { ok: _ok, canvasId: _canvasId, source, ...fields } = node;
      nodes.push({
        ...fields,
        nodeType: node.nodeType!,
        camerasHash: digest(node.cameras),
        ...(input.includeSource ? { source } : {}),
      });
    }
    const result = {
      ok: true as const,
      canvasId: input.canvasId,
      revision: snapshot.canvas.revision,
      nodes,
    };
    // 任务 5.3：不再按响应字节总量拒绝；大响应可继续分页读取同一快照。
    return result;
  });
}

function checkTargets(
  canvas: ServerCanvas,
  request: ModelScriptBatchRequest,
): ModelBatchFailure | null {
  const errors: ModelBatchIssue[] = [];
  const nodes = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  for (const [index, item] of request.items.entries()) {
    const node = nodes.get(item.nodeId),
      data = canvas.nodeData[item.nodeId] as CanvasNodeData | undefined;
    let code = "",
      message = "";
    if (!node) {
      code = "unknown-node";
      message = "节点不存在";
    } else if (!isModelAuthoringNodeType(node.type)) {
      code = "invalid-node-type";
      message = "目标不是模型节点";
    } else if (isFilmSetNode(node.type, data)) {
      code = "film-set-top-level-model";
      message = "片场模型请使用 item 作者接口";
    } else if (
      item.expectedModelContentHash !== undefined &&
      item.expectedModelContentHash !==
        (data?.modelContentVersion as { contentHash?: string } | undefined)
          ?.contentHash
    ) {
      code = "stale-source";
      message = "模型内容已被并发修改";
    } else if (
      item.cameras !== undefined &&
      item.expectedCamerasHash !== camerasHash(data)
    ) {
      code = "stale-cameras";
      message = "镜头集合已被并发修改";
    }
    if (code) errors.push({ index, nodeId: item.nodeId, code, message });
  }
  return errors.length
    ? { ...failure(errors[0].code, errors[0].message), errors }
    : null;
}

export async function authorModelBatch(
  deps: ModelMcpServiceDependencies,
  input: ModelScriptBatchRequest,
  context: ModelBatchContext,
  validateOnly: boolean,
): Promise<ModelScriptBatchOutcome> {
  const decoded = decodeModelBatch(input);
  if (!decoded.ok) return decoded;
  const { request, sources } = decoded;
  if (!(await authorized(context)))
    return failure("forbidden", "无权创作该画布的模型");
  const room = await deps.resolveRoom(request.canvasId);
  if (!room) return failure("canvas-not-found", "画布不存在");
  const submissionHash = digest(request);
  const commandId =
    "model-batch:" +
    digest([context.principalId, request.canvasId, request.requestId]);
  const receipt = (
    meta: ModelScriptBatchMeta,
    revision: number,
    duplicate: boolean,
    noop: boolean,
  ): ModelScriptBatchOutcome => ({
    ok: true,
    canvasId: request.canvasId,
    requestId: request.requestId,
    commandId,
    revision,
    duplicate,
    noop,
    validatedOnly: validateOnly,
    nodes: structuredClone(meta.nodes),
  });
  if (!validateOnly) {
    const prior = await room.lookupCommand(commandId);
    if (prior)
      return prior.modelBatch?.submissionHash === submissionHash
        ? receipt(prior.modelBatch, prior.revision, true, !prior.changed)
        : failure("request-id-reused", "相同 requestId 使用了不同模型批次");
  }
  const initial = await room.inspectPublished((snapshot) =>
    snapshot.ok
      ? checkTargets(snapshot.canvas, request)
      : failure("canvas-unavailable", snapshot.message),
  );
  if (initial) return initial;
  // change: 2026-10-22-remove-agent-execution-limits，任务 5.3 / design D5：删除固定批次并发
  // （原 2 批）与 15 秒总时长拒绝。合法批次按实际资源顺序执行（不一次启动全部 Worker），
  // 可取消；时间只作为用户的显式取消信号，而不是应用额度。
  try {
    const geometry: ModelBatchNodeSummary["geometry"][] = [],
      errors: ModelBatchIssue[] = [];
    // 顺序执行避免一次启动全部 Worker（调度，不是拒绝）。
    for (const [index, source] of sources.entries()) {
      const execution = await executeSceneIr(source, "woohaa-model-js-v2", {
        ...deps.scriptExecutor,
      });
      if (!execution.ok)
        errors.push({
          index,
          nodeId: request.items[index].nodeId,
          code: `model-script-${execution.stage}`,
          message: execution.message,
        });
      else {
        const bounds = v2SceneAabb(execution.ops);
        geometry[index] = {
          min: bounds?.min ?? null,
          max: bounds?.max ?? null,
          operationCount: execution.ops.length,
        };
      }
    }
    if (errors.length)
      return {
        ...failure("model-batch-invalid", "模型校验失败，整批未写入"),
        errors,
      };
    const commands: CanvasCommand[] = request.items.map((item, index) => ({
      type: "nodeData.patch",
      nodeId: item.nodeId,
      value: {
        modelScript: sources[index],
        modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
        modelScriptVersion: "woohaa-model-js-v2",
        ...(item.cameras !== undefined ? { modelCameras: item.cameras } : {}),
      },
    }));
    let targetFailure: ModelBatchFailure | null = null;
    const derive = async (canvas: ServerCanvas) => {
      if (!(await authorized(context)))
        return failure("forbidden", "模型执行期间权限已撤销");
      targetFailure = checkTargets(canvas, request);
      if (targetFailure) return targetFailure;
      const projected = applyCanvasCommands(canvas, commands, {
        now: deps.now?.(),
      });
      if (!projected.ok)
        return failure(projected.rejection.code, projected.rejection.message);
      const nodes: ModelBatchNodeSummary[] = [];
      for (const [index, item] of request.items.entries()) {
        const data = projected.canvas.nodeData[item.nodeId] as CanvasNodeData;
        const version = decodeModelContentVersion(data.modelContentVersion);
        if (!version.ok)
          return failure("invalid-model-version", "模型版本归一化失败");
        nodes.push({
          nodeId: item.nodeId,
          modelContentVersion: version.value,
          validation: "passed",
          geometry: geometry[index],
          cameraCount: readModelCameras(data).length,
          camerasHash: camerasHash(data),
        });
      }
      return {
        ok: true as const,
        modelBatch: { submissionHash, nodes },
        changed: projected.changed,
        batch: {
          protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          canvasId: request.canvasId,
          commandId,
          baseRevision: canvas.revision,
          actorId: context.principalId,
          commands,
        },
      };
    };
    if (validateOnly)
      return room.inspectPublished(async (snapshot) => {
        if (!snapshot.ok)
          return failure("canvas-unavailable", snapshot.message);
        const derived = await derive(snapshot.canvas);
        return derived.ok
          ? receipt(
              derived.modelBatch,
              snapshot.canvas.revision,
              false,
              !derived.changed,
            )
          : derived;
      });
    const outcome = await room.submitDerived(
      { commandId, expectedModelBatchHash: submissionHash, derive },
      { authorize: () => authorized(context) },
    );
    if (!outcome.ok)
      return targetFailure ?? failure(outcome.code, outcome.message);
    if (!outcome.modelBatch)
      return failure("storage-failed", "缺少模型批次首次回执");
    if (outcome.status !== "duplicate") {
      for (const [index, item] of request.items.entries())
        await registerModelHistorySafely(deps, {
          canvasId: request.canvasId,
          nodeId: item.nodeId,
          sourceHash:
            outcome.modelBatch.nodes[index].modelContentVersion.sourceHash,
          modelScript: sources[index],
          language: MODEL_SCRIPT_LANGUAGE,
          version: "woohaa-model-js-v2",
          createdAt: deps.now?.() ?? new Date().toISOString(),
        });
    }
    return receipt(
      outcome.modelBatch,
      outcome.revision,
      outcome.status === "duplicate",
      outcome.noop,
    );
  } finally {
    // 无批次并发额度可释放；保留 try/finally 结构以便后续阶段化清理。
  }
}
