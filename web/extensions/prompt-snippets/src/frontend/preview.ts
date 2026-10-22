/**
 * 素材预览 store
 * （change: add-prompt-snippet-library，任务 3.4 / design D4/D9）。
 *
 * Plugin-scoped：按稳定素材身份缓存预览状态（loading/ready/failed/unavailable），
 * 经 `canvasRemote` resolver + `mediaRemote` 解析同源 URL。dispose 时清空，不残留迟到结果。
 * 不保存也不返回 object/data/签名 URL。
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CanvasRemoteService, MediaRemoteService } from "@woohaa3/frontend/extension-api";
import type { PromptSnippetMaterial } from "@woohaa3/contracts";
import { resolveMaterialPreview, type MaterialPreview } from "./materials.js";

export type MaterialPreviewStore = {
  get(material: PromptSnippetMaterial): MaterialPreview;
  request(material: PromptSnippetMaterial): void;
  subscribe(listener: () => void): () => void;
  /** 全局版本号（供 useSyncExternalStore 的 getSnapshot 使用）。 */
  version(): number;
  dispose(): void;
};

export function createMaterialPreviewStore(options: {
  getCanvas: () => ServerCanvas | null;
  remote: CanvasRemoteService;
  mediaRemote: MediaRemoteService;
}): MaterialPreviewStore {
  const cache = new Map<string, MaterialPreview>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let disposed = false;

  const keyOf = (material: PromptSnippetMaterial): string =>
    material.mediaKind === "text" ? `text:${material.key}` : `media:${material.storageKey}`;

  const emit = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const request = (material: PromptSnippetMaterial): void => {
    if (disposed) return;
    const key = keyOf(material);
    if (cache.has(key) && cache.get(key)?.status === "ready") return;
    if (inFlight.has(key)) return;
    if (material.mediaKind === "text") {
      cache.set(key, { status: "ready", url: null });
      emit();
      return;
    }
    inFlight.add(key);
    cache.set(key, { status: "loading", url: null });
    void resolveMaterialPreview({
      material,
      canvas: options.getCanvas(),
      remote: options.remote,
      mediaRemote: options.mediaRemote
    })
      .then((preview) => {
        if (disposed) return;
        cache.set(key, preview);
        emit();
      })
      .finally(() => {
        inFlight.delete(key);
      });
  };

  return {
    get: (material) => cache.get(keyOf(material)) ?? { status: "loading", url: null },
    request,
    version: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      cache.clear();
      inFlight.clear();
      listeners.clear();
    }
  };
}

/**
 * React 绑定：订阅预览 store，并在 effect 中请求给定素材的预览
 * （不在渲染期触发 store 变更，避免 “update during render”）。
 */
export function useMaterialPreviews(
  store: MaterialPreviewStore,
  materials: readonly PromptSnippetMaterial[]
): Map<string, MaterialPreview> {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const keys = materials.map((material) => material.key).join("|");
  useEffect(() => {
    for (const material of materials) store.request(material);
    // materials 以稳定 key 序列参与依赖；引用变化但 key 不变时不重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, keys]);
  return new Map(materials.map((material) => [material.key, store.get(material)]));
}
