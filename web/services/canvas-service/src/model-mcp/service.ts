import type { GetModelNodesInput, ModelScriptBatchRequest } from "@woohaa3/contracts";
import { authorModelBatch, getModelNodes } from "./batch-service.js";
import type { ModelBatchContext } from "./batch-service.js";
/**
 * 模型脚本权威提交服务公共入口
 * （change: integrate-origin-master-after-web-split；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R03 —— 拆分为
 *  类型、模型读取、脚本提交、镜头、预览与历史上报协作者，本文件保留薄 facade）。
 *
 * Canvas Service 是 `modelScript` 的唯一权威写入方。本服务在权威 room 上以**稳定 commandId**
 * 提交 `nodeData.patch`，durable 成功后才返回；相同请求身份重复提交是幂等的。
 *
 * `ModelMcpService` 仍持有唯一 renderCache、actorId 与依赖；协作者只接受受控 context/deps。
 */
import { createRenderCache, type RenderCache } from "../model-renderer/index.js";
import { getModelNode, listModelNodes } from "./model-reader.js";
import { getModelStatistics } from "./model-statistics-service.js";
import { statisticsForSource } from "./model-statistics.js";
import {
  applyCommands,
  submitScript
} from "./script-submission.js";
import {
  mutateCameras,
  mutateCamerasBatch
} from "./camera-service.js";
import {
  reconcileModelHistory,
  reportScript
} from "./history-reporting.js";
import { renderPreview as renderPreviewImpl } from "./preview-service.js";
import {
  type ApplyCommandsInput,
  type ApplyCommandsOutcome,
  type GetModelNodeInput,
  type GetModelNodeOutcome,
  type ListModelNodesOutcome,
  type ModelMcpServiceDependencies,
  type ModelStatisticsInput,
  type ModelStatisticsOutcome,
  type MutateCamerasBatchInput,
  type MutateCamerasBatchOutcome,
  type MutateCamerasInput,
  type MutateCamerasOutcome,
  type RenderPreviewInput,
  type RenderPreviewOutcome,
  type ReportScriptOutcome,
  type SubmitScriptInput,
  type SubmitScriptOutcome
} from "./service-types.js";

export {
  MODEL_SCRIPT_MAX_CHARS,
  hashText
} from "./service-types.js";
export { defaultCommandId } from "./script-submission.js";
export type {
  SubmitScriptInput,
  SubmitScriptOutcome,
  ReportScriptOutcome,
  GetModelNodeInput,
  GetModelNodeOutcome,
  ModelNodeSummary,
  ListModelNodesOutcome,
  RenderPreviewInput,
  RenderPreviewMetadata,
  RenderPreviewOutcome,
  ApplyCommandsInput,
  ApplyCommandsOutcome,
  MutateCamerasInput,
  MutateCamerasOutcome,
  MutateCamerasBatchInput,
  MutateCamerasBatchOutcome,
  ModelStatisticsInput,
  ModelStatisticsOutcome,
  ModelMcpServiceDependencies
} from "./service-types.js";
export { readAnimationDefinition, readModelContentVersion } from "./model-reader.js";

export class ModelMcpService {
  private readonly deps: ModelMcpServiceDependencies;
  private readonly renderCache: RenderCache;
  private readonly actorId: string;

  constructor(deps: ModelMcpServiceDependencies) {
    this.deps = deps;
    this.renderCache = deps.renderCache ?? createRenderCache();
    this.actorId = deps.actorId ?? "canvas-model-mcp";
  }

  /** 读取 3D 节点当前的权威本地模型定义，供 MCP 在修改前获取上下文。 */
  async getModelNode(input: GetModelNodeInput): Promise<GetModelNodeOutcome> {
    return getModelNode(this.deps.resolveRoom, input, (source, version) =>
      statisticsForSource(this.deps, source, version));
  }

  /** 读取当前或候选脚本的模型规模（与聚焦信息面板同源）。 */
  async getModelStatistics(input: ModelStatisticsInput): Promise<ModelStatisticsOutcome> {
    return getModelStatistics(this.deps, input);
  }

  /** 列出画布上的 3D 作者节点。 */
  async listModelNodes(input: { canvasId?: string }): Promise<ListModelNodesOutcome> {
    return listModelNodes(this.deps.resolveRoom, input);
  }

  /** 校验并提交脚本到权威 room。 */
  async submitScript(input: SubmitScriptInput): Promise<SubmitScriptOutcome> {
    return submitScript(this.deps, this.actorId, input);
  }

  getModelNodes(input: GetModelNodesInput) { return getModelNodes(this.deps, input); }

  validateScripts(input: ModelScriptBatchRequest, context: ModelBatchContext) {
    return authorModelBatch(this.deps, input, context, true);
  }

  submitScripts(input: ModelScriptBatchRequest, context: ModelBatchContext) {
    return authorModelBatch(this.deps, input, context, false);
  }

  /** 通用语义命令提交。 */
  async applyCommands(input: ApplyCommandsInput): Promise<ApplyCommandsOutcome> {
    return applyCommands(this.deps, this.actorId, input);
  }

  /** 单条镜头读改写。 */
  async mutateCameras(input: MutateCamerasInput): Promise<MutateCamerasOutcome> {
    return mutateCameras(this.deps, this.actorId, input);
  }

  /** 批量镜头读改写。 */
  async mutateCamerasBatch(input: MutateCamerasBatchInput): Promise<MutateCamerasBatchOutcome> {
    return mutateCamerasBatch(this.deps, this.actorId, input);
  }

  /** 补齐模型历史登记（reconciliation）。 */
  async reconcileModelHistory(input: { canvasId: string; nodeId: string }): Promise<{ ok: boolean; recorded: boolean }> {
    return reconcileModelHistory(this.deps, input);
  }

  /** 上报运行时应用脚本的结果。 */
  async reportScript(input: {
    canvasId: string;
    nodeId: string;
    status: "ok" | "failed";
    message?: string;
  }): Promise<ReportScriptOutcome> {
    return reportScript(this.deps, this.actorId, input);
  }

  /** 从权威脚本离屏渲染 PNG 预览。 */
  async renderPreview(input: RenderPreviewInput): Promise<RenderPreviewOutcome> {
    return renderPreviewImpl(this.deps, this.renderCache, input);
  }
}
