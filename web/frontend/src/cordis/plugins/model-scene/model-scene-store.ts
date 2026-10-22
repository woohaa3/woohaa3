/**
 * 浏览器执行 modelScript 得到的 prepared model resource 存储
 * （change: replace-godot-canvas-runtime-with-bevy；
 *  change: enhance-model-scene-authoring-api 增加 V2；
 *  change: optimize-model-scene-snapshot-hot-path 改为不可变 prepared resource）。
 *
 * 运行时在 `set_scene` 里按节点的 `model` 字段接收轻量引用 `{ sceneVersion, resourceKey,
 * signature, placement }`；完整 Scene IR 经独立 `prepare_and_register_model_resource` 通道注册。
 * 浏览器执行 `modelScript` 成功后一次性派生 signature/AABB/extent/payload 并缓存在这里，
 * 画布帧只读取同一不可变资源。执行状态仍经 Canvas Service 权威写回。
 *
 * change: 2026-10-07-remove-residual-compatibility —— V2-only，删除 V1 snapshot 视图。
 */
import { prepareModelResource, type PreparedModelResource, type SceneV2Op } from "@woohaa3/contracts";
import { sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";

export class ModelSceneStore {
  private readonly scenes = new Map<string, PreparedModelResource>();
  private readonly listeners = new Set<() => void>();

  get(nodeId: string): PreparedModelResource | undefined {
    return this.scenes.get(nodeId);
  }

  /**
   * 存入已 prepared 的资源。仅当内容 identity（resourceKey）变化时才替换并通知；
   * 相同内容回流不触发订阅者（设计 D1：复用同一不可变资源）。
   */
  set(nodeId: string, resource: PreparedModelResource): void {
    const existing = this.scenes.get(nodeId);
    this.scenes.set(nodeId, resource);
    if (existing?.resourceKey === resource.resourceKey) return;
    this.emit();
  }

  /** 由原始 ops 一次性 prepare 并存表（executor 成功结果接入点）。 */
  put(nodeId: string, sceneVersion: string, ops: readonly SceneV2Op[]): PreparedModelResource {
    const resource = prepareModelResource({ sceneVersion, ops });
    sceneDiagnostics.derivedMetadata += 1;
    this.set(nodeId, resource);
    return resource;
  }

  delete(nodeId: string): void {
    if (this.scenes.delete(nodeId)) this.emit();
  }

  /** 所有 prepared resource（供 controller 合成轻量引用）。 */
  snapshot(): ReadonlyMap<string, PreparedModelResource> {
    return this.scenes;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 页面级单例。 */
export const modelSceneStore = new ModelSceneStore();
