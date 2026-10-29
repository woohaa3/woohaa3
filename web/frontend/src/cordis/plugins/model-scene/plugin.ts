/** Page-owned model preparation. Providers stage results; only current identities publish. */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  compositeAssetSceneOps, executeModelScriptVersioned, isSupportedModelScriptVersion,
  sceneIrVersionFor,
  type CanvasNodeData, type SceneV2Op, type NodePreparationResult, type ServerCanvas,
} from "@woohaa3/contracts";
import { modelSceneStore, ModelSceneStore } from "./model-scene-store.js";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { NodeResourceLoading } from "../../services/node-resource-loading.js";
import { createModelScriptReports } from "./model-script-reports.js";
export const MODEL_SCENE_PLUGIN_ID = "model-scene";
export type ModelSceneExtensionOptions = {
  canvasId?: string;
  applyModelScript?: (nodeId: string, source: string, version: unknown) => Promise<string>;
  schedule?: (run: () => void) => void;
  yieldToBrowser?: () => Promise<void>;
};
export function modelSceneExtension(options: ModelSceneExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const registry = ctx.nodeImplementations;
    const scenes = new ModelSceneStore();
    const applied = new Map<string, string>();
    const releases = new Map<string, () => void>();
    const loading = new NodeResourceLoading();
    const reports = createModelScriptReports(report => ctx.canvasRemote.reportModelScript(report));
    const schedule = options.schedule ?? queueMicrotask;
    let stopped = false, scheduled = false, running = false, rerun = false;
    const readCanvas = () => ctx.compositeAssets.projectCanvas(ctx.canvasState.getCanvas());
    const identity = (canvas: ServerCanvas | null | undefined, node: ServerCanvas["document"]["nodes"][number] | undefined) => {
      if (!canvas || !node) return null;
      const context = { canvas, node, data: canvas.nodeData[node.id] };
      const capabilities = registry.resolve(context);
      const provider = capabilities.modelPreparation;
      const key = provider?.executionKey(context);
      return provider && key !== undefined
        ? { context, provider, key: JSON.stringify([canvas.id, capabilities.generation, key]) }
        : null;
    };
    const discard = (nodeId: string) => {
      releases.get(nodeId)?.(); releases.delete(nodeId);
      applied.delete(nodeId); scenes.delete(nodeId);
      ctx.compositeAssets.setProjection(nodeId, null);
    };
    const drain = async () => {
      let started = performance.now();
      const canvas = readCanvas();
      // This index belongs to one drain. Refresh on canonical snapshot replacement,
      // including after a browser yield or asynchronous preparation.
      let indexedCanvas = canvas;
      let nodes = new Map(canvas?.document.nodes.map(node => [node.id, node]) ?? []);
      const currentIdentity = (nodeId: string) => {
        const latest = readCanvas();
        if (latest !== indexedCanvas) {
          indexedCanvas = latest;
          nodes = new Map(latest?.document.nodes.map(node => [node.id, node]) ?? []);
        }
        return identity(latest, nodes.get(nodeId));
      };
      const ids = new Set(nodes.keys());
      ctx.compositeAssets.retain(ids);
      for (const id of applied.keys()) if (!ids.has(id) || applied.get(id) !== currentIdentity(id)?.key) discard(id);
      for (const nodeId of ids) {
        if (stopped) return;
        if (performance.now() - started >= 8) {
          await (options.yieldToBrowser?.() ?? new Promise(resolve => setTimeout(resolve, 0)));
          if (stopped) return;
          started = performance.now();
        }
        const current = currentIdentity(nodeId);
        if (!current || applied.get(nodeId) === current.key) continue;
        const load = loading.track(nodeId, current.key);
        let result: NodePreparationResult;
        try {
          result = options.applyModelScript
            ? { status: await options.applyModelScript(nodeId, String(current.context.data?.modelScript ?? ""), current.context.data?.modelScriptVersion) }
            : await current.provider.prepare(current.context);
        } catch (error) {
          result = { status: `fail:execute:${error instanceof Error ? error.message : String(error)}` };
        }
        if (stopped || currentIdentity(nodeId)?.key !== current.key) {
          result.release?.(); loading.remove(load); continue;
        }
        releases.get(nodeId)?.(); releases.delete(nodeId);
        if (result.release) releases.set(nodeId, result.release);
        if (result.resource) scenes.set(nodeId, result.resource); else scenes.delete(nodeId);
        // Composite metadata is published only by an accepted, strictly owned adapter result.
        const adapter = ctx.compositeAssets.resolveNode(current.context.canvas, current.context.node);
        ctx.compositeAssets.setProjection(nodeId, adapter ? { ...(result.resource ? { resource: result.resource } : {}), ...(result.composition ? { composition: result.composition } : {}), ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) } : null, adapter?.extensionId);
        applied.set(nodeId, current.key);
        loading.setLoading(load, false);
        const status = result.status.startsWith("ok") ? "ok" : "failed";
        // Presentation-only resources (a group's own appearance) never own canonical model status.
        if (current.provider.reportsStatus === false) continue;
        const data = ctx.canvasState.getCanvas()?.nodeData[nodeId];
        if (!reports.hasPending(nodeId) && data?.modelScriptStatus === status &&
          (status === "ok" ? !data.modelScriptError : data.modelScriptError === result.status)) continue;
        reports.enqueue({ canvasId: options.canvasId ?? DEFAULT_CANVAS_ID, nodeId, status,
          ...(status === "failed" ? { message: result.status } : {}) },
          () => !stopped && applied.get(nodeId) === current.key && currentIdentity(nodeId)?.key === current.key);
      }
    };
    const trigger = () => {
      if (stopped) return;
      const sources = new Map<string, string>();
      const canvas = readCanvas();
      for (const node of canvas?.document.nodes ?? []) {
        const current = identity(canvas, node);
        if (current) sources.set(node.id, current.key);
      }
      // Remove obsolete published resources immediately, even while an old prepare awaits.
      for (const [id, key] of applied) if (sources.get(id) !== key) discard(id);
      loading.retain(sources);
      for (const [id, key] of sources) {
        const load = loading.track(id, key);
        if (applied.get(id) === key) loading.setLoading(load, false);
      }
      if (running) { rerun = true; return; }
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        if (stopped) return;
        running = true;
        void drain().finally(() => { running = false; if (rerun) { rerun = false; trigger(); } });
      });
    };
    const stopCanvas = ctx.canvasState.subscribe(trigger);
    const stopAdapters = ctx.compositeAssets.subscribe(trigger);
    const stopRegistry = registry.subscribe(trigger);
    const provider: ModelScenesProvider = {
      getResources: () => scenes.snapshot(), isLoading: loading.isLoading,
      subscribe: listener => { const a = scenes.subscribe(listener), b = loading.subscribe(listener); return () => { a(); b(); }; }
    };
    ctx.provide(MODEL_SCENES_SERVICE as never, provider as never);
    trigger();
    return () => {
      stopped = true; reports.dispose(); stopCanvas(); stopAdapters(); stopRegistry(); loading.clear();
      for (const id of applied.keys()) discard(id);
    };
  }, { name: MODEL_SCENE_PLUGIN_ID, inject: ["canvasRemote", "canvasState", "compositeAssets", "nodeImplementations"] });
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
