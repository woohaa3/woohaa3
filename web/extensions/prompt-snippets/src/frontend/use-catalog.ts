/**
 * 片段目录 React 绑定
 * （change: add-prompt-snippet-library，任务 2.3）。
 *
 * 用 `useSyncExternalStore` 订阅 feature-owned `snippetCatalog`；组件只是订阅者，
 * 目录状态生命周期长于任何组件。
 */
import { useSyncExternalStore } from "react";
import type { SnippetCatalog } from "./catalog.js";

export function useCatalogState(catalog: SnippetCatalog) {
  return useSyncExternalStore(catalog.subscribe, catalog.getState, catalog.getState);
}

export function useTagState(catalog: SnippetCatalog) {
  return useSyncExternalStore(catalog.subscribe, catalog.getTagState, catalog.getTagState);
}
