/**
 * 模型历史缩略图作业
 * （change: add-canvas-node-generation-history，任务 2.4 / design D5）。
 *
 * 只从**历史条目的权威脚本**执行并校验 Scene IR，再交给原生 renderer。**不接受**任何
 * 浏览器提交的源码或 Scene IR（入口只接受 canvas/node/entry 身份）。
 *
 * 缓存键至少包含 `sourceHash + sceneVersion + renderVersion + captureOptions`；缓存
 * 有独立字节预算（LRU）。失败只影响对应卡片，不阻止列表、详情或恢复。
 */
import { hashModelScript, v2SceneExtent } from "@woohaa3/contracts";
import type { NodeHistoryModelPayload } from "@woohaa3/contracts";
import type { RendererSceneRequest } from "./client.js";
import type { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import { createRenderCache, renderCacheKey, RENDER_VERSION, type RenderCache, type RendererClient } from "./index.js";
import { executeSceneIr, normalizeCaptureOptions, type ScriptExecutorOptions } from "../model-mcp/script-executor.js";

export type NodeHistoryThumbnailOptions = {
  service: NodeHistoryApplicationService;
  rendererClient: RendererClient;
  capture?: { width?: number; height?: number; background?: string; cameraPreset?: string };
  cache?: RenderCache;
  scriptExecutor?: ScriptExecutorOptions;
  prepareCompositeHistory?: (input: { canvasId: string; nodeId: string; payload: NodeHistoryModelPayload }) => Promise<(Omit<RendererSceneRequest, "requestId" | "capture"> & { identity: string })>;
};

export type NodeHistoryThumbnailResult =
  | { ok: true; png: Buffer; cached: boolean }
  | { ok: false; code: string; message: string };

export class NodeHistoryThumbnailJob {
  private readonly prepareCompositeHistory: NodeHistoryThumbnailOptions["prepareCompositeHistory"];
  private readonly service: NodeHistoryApplicationService;
  private readonly renderer: RendererClient;
  private readonly cache: RenderCache;
  private readonly capture: { width: number; height: number; background: string; cameraPreset: string };
  private readonly captureError: { code: string; message: string } | null;
  private readonly scriptExecutor: ScriptExecutorOptions;

  constructor(options: NodeHistoryThumbnailOptions) {
    this.prepareCompositeHistory = options.prepareCompositeHistory;
    this.service = options.service;
    this.renderer = options.rendererClient;
    this.cache = options.cache ?? createRenderCache();
    this.scriptExecutor = options.scriptExecutor ?? {};
    const normalized = normalizeCaptureOptions(options.capture ?? { width: 320, height: 320, background: "transparent", cameraPreset: "dimetric" });
    if (normalized.ok) {
      this.capture = normalized.options;
      this.captureError = null;
    } else {
      this.capture = { width: 320, height: 320, background: "transparent", cameraPreset: "dimetric" };
      this.captureError = { code: normalized.code, message: normalized.message };
    }
  }

  async render(input: { canvasId: string; nodeId: string; entryId: string }): Promise<NodeHistoryThumbnailResult> {
    if (this.captureError) return { ok: false, ...this.captureError };
    const entry = await this.service.getEntry({ canvasId: input.canvasId, nodeId: input.nodeId, entryId: input.entryId });
    if (entry.kind !== "model") return { ok: false, code: "not-a-model-entry", message: "历史条目不是模型版本" };
    const payload = entry.payload as NodeHistoryModelPayload;
    if (payload.animation) {
      if (payload.animation.schemaVersion !== 3) return { ok: false, code: "invalid-history-definition", message: "历史片场尚未完成迁移" };
      if (!this.prepareCompositeHistory) return { ok: false, code: "composite-history-unavailable", message: "复合资产历史渲染不可用" };
      try {
        const prepared = await this.prepareCompositeHistory({ canvasId: input.canvasId, nodeId: input.nodeId, payload });
        const capture = { ...this.capture, cameraPreset: "initial" };
        const cacheKey = renderCacheKey({ sourceHash: prepared.identity, sceneVersion: prepared.sceneVersion, renderVersion: RENDER_VERSION, capture });
        const cached = this.cache.get(cacheKey);
        if (cached) return { ok: true, png: cached.png, cached: true };
        const { identity, ...scene } = prepared;
        const rendered = await this.renderer.render({ ...scene, requestId: `${input.entryId}:${identity}`, capture });
        if (!rendered.ok) return rendered;
        this.cache.set(cacheKey, { png: rendered.png, width: capture.width, height: capture.height, sceneSignature: scene.signature, renderVersion: rendered.renderVersion });
        return { ok: true, png: rendered.png, cached: false };
      } catch (cause) {
        return { ok: false, code: "composite-history-render-failed", message: cause instanceof Error ? cause.message : "历史复合资产渲染失败" };
      }
    }
    if (payload.modelScript.trim() === "") {
      return { ok: false, code: "no-source", message: "历史模型脚本为空" };
    }
    const execution = await executeSceneIr(payload.modelScript, payload.version, this.scriptExecutor);
    if (!execution.ok) {
      return { ok: false, code: `model-script-${execution.stage}`, message: execution.message };
    }
    const cacheKey = renderCacheKey({
      sourceHash: payload.sourceHash,
      sceneVersion: execution.sceneVersion,
      renderVersion: RENDER_VERSION,
      capture: this.capture
    });
    const cached = this.cache.get(cacheKey);
    if (cached) return { ok: true, png: cached.png, cached: true };

    const sceneSignature = hashModelScript(execution.json);
    const rendered = await this.renderer.render({
      requestId: `${input.entryId}:${payload.sourceHash}`,
      sceneVersion: execution.sceneVersion,
      signature: sceneSignature,
      extent: sceneVersionExtent(execution.sceneVersion, execution.ops),
      ops: execution.ops as unknown[],
      capture: this.capture
    });
    if (!rendered.ok) return { ok: false, code: rendered.code, message: rendered.message };
    this.cache.set(cacheKey, {
      png: rendered.png,
      width: this.capture.width,
      height: this.capture.height,
      sceneSignature,
      renderVersion: rendered.renderVersion
    });
    return { ok: true, png: rendered.png, cached: false };
  }

  /** 缓存统计（诊断/测试）。 */
  cacheSize(): { entries: number; bytes: number } {
    return this.cache.size();
  }
}

function sceneVersionExtent(_sceneVersion: string, ops: readonly unknown[]): number {
  return v2SceneExtent(ops as never);
}
