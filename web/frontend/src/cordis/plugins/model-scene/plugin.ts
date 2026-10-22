/**
 * Model Scene Sync Plugin（change: adopt-frontend-cordis-plugin-runtime，design D5/D4；
 *  change: 2026-10-09-add-film-set-object-motion-and-editing —— 片场组合内容同步）。
 *
 * 观察权威画布派生的 `nodeData.modelScript`，用浏览器 SceneBuilder 执行成 Scene IR 交给
 * Bevy，并把结果经 `canvasRemote.reportModelScript` 上报回 Canvas Service。**不写权威状态**。
 *
 * 复合资产通过 scope 注册的业务 adapter 生成资源，宿主不解释扩展内容。
 *
 * 提供 `modelScenes` feature service：canvas runtime 据此合成快照；订阅与执行由 Plugin
 * scope 回收。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import {
  compositeAssetSceneOps,
  executeModelScriptVersioned,
  isSupportedModelScriptVersion,
  sceneIrVersionFor,
  type CanvasNodeData,
  type SceneV2Op,
} from "@woohaa3/contracts";
import type { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import { modelSceneStore, ModelSceneStore } from "./model-scene-store.js";
import {
  MODEL_SCENES_SERVICE,
  type ModelScenesProvider,
} from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { NodeResourceLoading } from "../../services/node-resource-loading.js";
import { createModelScriptReports } from "./model-script-reports.js";

export const MODEL_SCENE_PLUGIN_ID = "model-scene";

export type ModelSceneExtensionOptions = {
  canvasId?: string;
  /** 执行入口（测试可注入）。返回 `ok` 或 `fail:<code>`。 */
  applyModelScript?: (
    nodeId: string,
    source: string,
    version: unknown,
  ) => Promise<string>;
  schedule?: (run: () => void) => void;
  /** Yield between preparation batches so ready resources can be painted. */
  yieldToBrowser?: () => Promise<void>;
};

export function modelSceneExtension(options: ModelSceneExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      const injected = options.applyModelScript;
      const schedule = options.schedule ?? createMicScheduler();
      const scopedScenes = new ModelSceneStore();
      const applied = new Map<string, string>();
      const loading = new NodeResourceLoading(undefined, "model-prepare");
      const reports = createModelScriptReports(report => ctx.canvasRemote.reportModelScript(report));
      let scheduled = false;
      let running = false;
      let rerun = false;
      let stopped = false;

      const apply = async (
        nodeId: string,
        source: string,
        version: unknown,
        data: CanvasNodeData | undefined,
        nodeType: string,
      ): Promise<string> => {
        if (injected) return injected(nodeId, source, version);
        if (nodeType === "composite-asset") {
          const adapter = ctx.compositeAssets.resolve(ctx.canvasState.getCanvas(), nodeId);
          const projection = adapter && data ? adapter.prepare(nodeId, data) : null;
          ctx.compositeAssets.setProjection(nodeId, projection, adapter?.extensionId);
          if (!projection) {
            // A saved generic model remains visible even if its business UI is unavailable.
            // This grants no extension commands or workspace ownership.
            if (!adapter && source.trim()) return applyWithBevy(nodeId, source, version, data, nodeType, scopedScenes);
            scopedScenes.delete(nodeId);
            return "fail:compile:unavailable-composite-asset";
          }
          scopedScenes.set(nodeId, projection.resource);
          return projection.diagnostic ? `ok:partial:${projection.diagnostic}` : "ok";
        }
        return applyWithBevy(nodeId, source, version, data, nodeType, scopedScenes);
      };

      const run = () => {
        scheduled = false;
        if (stopped) return;
        running = true;
        void applyCommitted({
          canvasId,
          scenes: scopedScenes,
          getCanvas: ctx.canvasState.getCanvas,
          compositeAssets: ctx.compositeAssets,
          applied,
          loading,
          apply,
          active: () => !stopped,
          reports,
          yieldToBrowser: options.yieldToBrowser ?? (() => new Promise(resolve => setTimeout(resolve, 0))),
        }).finally(() => {
          running = false;
          if (rerun) {
            rerun = false;
            trigger();
          }
        });
      };
      const trigger = () => {
        if (stopped) return;
        const canvas = ctx.canvasState.getCanvas();
        const sources = new Map<string, string>();
        for (const node of canvas?.document.nodes ?? []) {
          const data = canvas?.nodeData[node.id];
          if (node.type === "model3d" && typeof data?.modelScript === "string" && data.modelScript) {
            sources.set(node.id, `${String(data.modelScriptVersion)}:${data.modelScript}`);
          }
        }
        loading.retain(sources);
        for (const [nodeId, source] of sources) {
          const load = loading.track(nodeId, source);
          if (applied.get(nodeId) === source) loading.setLoading(load, false);
        }
        if (scheduled) return;
        // One drain owns the derived resources. Changes during awaits are coalesced.
        if (running) {
          rerun = true;
          return;
        }
        scheduled = true;
        schedule(run);
      };

      const unsubscribe = ctx.canvasState.subscribe(trigger);
      const unsubscribeAdapters = ctx.compositeAssets.subscribe(trigger);
      trigger();

      const provider: ModelScenesProvider = {
        getResources: () => scopedScenes.snapshot(),
        isLoading: loading.isLoading,
        subscribe: listener => {
          const stopResources = scopedScenes.subscribe(listener);
          const stopLoading = loading.subscribe(listener);
          return () => { stopResources(); stopLoading(); };
        }
      };
      ctx.provide(MODEL_SCENES_SERVICE as never, provider as never);

      return () => {
        stopped = true;
        reports.dispose();
        unsubscribe();
        unsubscribeAdapters();
        loading.clear();
        for (const nodeId of applied.keys()) scopedScenes.delete(nodeId);
        applied.clear();
      };
    },
    { name: MODEL_SCENE_PLUGIN_ID, inject: ["canvasRemote", "canvasState", "compositeAssets"] },
  );
}

function createMicScheduler(): (run: () => void) => void {
  return (run) => {
    const enqueue =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (task: () => void) => void Promise.resolve().then(task);
    enqueue(run);
  };
}

async function applyCommitted(input: {
  canvasId: string;
  scenes: ModelSceneStore;
  getCanvas: () => ServerCanvas | null;
  compositeAssets: CompositeAssetRegistry;
  applied: Map<string, string>;
  loading: NodeResourceLoading;
  apply: (
    nodeId: string,
    source: string,
    version: unknown,
    data: CanvasNodeData | undefined,
    nodeType: string,
  ) => Promise<string>;
  active: () => boolean;
  reports: ReturnType<typeof createModelScriptReports>;
  yieldToBrowser: () => Promise<void>;
}): Promise<void> {
  const canvas = input.getCanvas();
  if (!canvas) return;
  const currentIds = new Set(canvas.document.nodes.map(node => node.id));
  input.compositeAssets.retain(currentIds);
  for (const nodeId of input.applied.keys()) if (!currentIds.has(nodeId)) { input.applied.delete(nodeId); input.scenes.delete(nodeId); }
  let batchStarted = performance.now();
  for (const node of canvas.document.nodes) {
    if (!input.active()) return;
    // Awaiting an already resolved apply only yields to microtasks, not painting.
    // Bound each batch between nodes without changing the serial resource ownership.
    if (performance.now() - batchStarted >= 8) {
      await input.yieldToBrowser();
      if (!input.active()) return;
      batchStarted = performance.now();
    }
    // Source or deletion can change during preparation/yield. Re-read committed data.
    const latest = input.getCanvas();
    if (!latest?.document.nodes.some((candidate) => candidate.id === node.id))
      continue;
    const latestNode = latest.document.nodes.find(candidate => candidate.id === node.id)!;
    if (latestNode.type !== "model3d" && latestNode.type !== "composite-asset") {
      input.applied.delete(node.id);
      input.scenes.delete(node.id);
      input.compositeAssets.setProjection(node.id, null);
      continue;
    }
    const data = latest.nodeData[node.id] as CanvasNodeData | undefined;
    const composite = latestNode.type === "composite-asset";
    const source =
      typeof data?.modelScript === "string" ? data.modelScript : "";
    // 普通模型空源码无内容；片场 items-only 不再有顶层源码，空 items 也是合法内容。
    if (!composite && source === "") {
      input.applied.delete(node.id);
      input.scenes.delete(node.id);
      continue;
    }
    // 版本作为执行键的一部分：同一 source 但版本变化也要重新执行。
    // 片场执行键覆盖独立根 + 完整内部集合身份，使集合变化触发正确资源失效。
    const executionKey = modelExecutionKey(input.compositeAssets, latest, node.id);
    if (executionKey === undefined) continue;
    if (input.applied.get(node.id) === executionKey) continue;
    const load = node.type === "model3d" ? input.loading.track(node.id, executionKey) : null;
    if (load) input.loading.setLoading(load, true);
    // 单节点失败隔离：一个节点执行失败不阻止其它节点，也不停止 2D 画布。
    let status: string;
    try {
      status = await input.apply(node.id, source, data?.modelScriptVersion, data, latestNode.type);
    } catch (error) {
      status = `fail:execute:${error instanceof Error ? error.message : String(error)}`;
    }
    if (!input.active()) return;
    const after = input.getCanvas();
    const afterNode = after?.document.nodes.find(candidate => candidate.id === node.id);
    const afterKey = modelExecutionKey(input.compositeAssets, after, node.id);
    if (afterNode?.type !== latestNode.type || afterKey !== executionKey) {
      if (load) input.loading.setLoading(load, false, "cancelled");
      input.scenes.delete(node.id);
      input.compositeAssets.setProjection(node.id, null);
      continue;
    }
    if (load) input.loading.setLoading(load, false, status.startsWith("fail:") ? "error" : "ok");
    // Failed identities are terminal until source or adapter generation changes.
    input.applied.set(node.id, executionKey);
    const reportStatus = status.startsWith("ok") ? "ok" : "failed";
    // Reloading a saved canvas should not write back outcomes already acknowledged.
    if (!input.reports.hasPending(node.id) &&
        after?.nodeData[node.id]?.modelScriptStatus === reportStatus &&
        (reportStatus === "ok"
          ? !after.nodeData[node.id]?.modelScriptError
          : after.nodeData[node.id]?.modelScriptError === status)) continue;
    input.reports.enqueue({
      canvasId: input.canvasId,
      nodeId: node.id,
      status: reportStatus,
      ...(reportStatus === "ok" ? {} : { message: status }),
    }, () => input.active() &&
      input.applied.get(node.id) === executionKey &&
      modelExecutionKey(input.compositeAssets, input.getCanvas(), node.id) === executionKey);
  }
}

function modelExecutionKey(registry: CompositeAssetRegistry, canvas: ServerCanvas | null, nodeId: string): string | undefined {
  const node = canvas?.document.nodes.find(candidate => candidate.id === nodeId);
  if (!node || (node.type !== "model3d" && node.type !== "composite-asset")) return undefined;
  const data = canvas?.nodeData[nodeId];
  const source = typeof data?.modelScript === "string" ? data.modelScript : "";
  if (node.type !== "composite-asset") return `${String(data?.modelScriptVersion)}:${source}`;
  const adapter = registry.resolve(canvas, nodeId);
  return adapter && data
    ? `${registry.generation(adapter.extensionId)}:${adapter.executionKey(data)}`
    : `unavailable:${String(data?.extensionId)}:${JSON.stringify(data?.scenePlacement)}:${String(data?.modelScriptVersion)}:${source}`;
}

export async function applyWithBevy(
  nodeId: string,
  source: string,
  version: unknown,
  data?: CanvasNodeData,
  nodeType?: string,
  scenes: ModelSceneStore = modelSceneStore,
): Promise<string> {
  // 按节点声明的版本 dispatch；未知版本稳定失败，不回退 V1。
  const execution = executeModelScriptVersioned(source, version);
  if (!execution.ok) {
    scenes.delete(nodeId);
    return `fail:${execution.stage}:${execution.code}`;
  }
  if (!isSupportedModelScriptVersion(version)) {
    scenes.delete(nodeId);
    return "fail:compile:version-mismatch";
  }
  // 成功结果一次性派生 prepared resource（signature/AABB/extent/payload 同批）。
  const sceneIrVersion = sceneIrVersionFor(version);
  scenes.put(nodeId, sceneIrVersion, nodeType === "composite-asset" ? compositeAssetSceneOps(execution.scene.ops as SceneV2Op[], data?.scenePlacement) : execution.scene.ops as SceneV2Op[]);
  return "ok";
}
