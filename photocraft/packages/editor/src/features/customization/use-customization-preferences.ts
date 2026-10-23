/**
 * 偏好订阅 hook（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D3）。
 *
 * 共享外壳渲染菜单/工具栏时需要的不是「读一次偏好」，而是**偏好变化后重新渲染**。若外壳只是
 * `customizationState().preferences`，面板里改完设置后菜单与工具栏不会刷新（面板改的是本域仓库，
 * 不经过工作区控制器快照）。这个 hook 把订阅收在本域，外壳仍然只加一行：
 *
 * ```ts
 * const preferences = useCustomizationPreferences();
 * ```
 *
 * 用 `useSyncExternalStore` 保证并发渲染下的快照一致性；`getSnapshot` 返回仓库里同一个对象引用，
 * 因此不会出现「每次渲染都变」的无限重渲染。
 */
import { useSyncExternalStore } from "react";
import { defaultCustomizationStore, type CustomizationPreferences, type CustomizationState, type CustomizationStore } from "./preferences.js";

/** 订阅偏好仓库；传 `store` 便于测试或宿主注入，缺省使用进程内共享仓库。 */
export function useCustomizationState(store?: CustomizationStore): CustomizationState {
  const target = store ?? defaultCustomizationStore();
  return useSyncExternalStore(target.subscribe, target.snapshot);
}

/** 外壳渲染用：菜单隐藏、工具栏顺序/隐藏、快捷键提示都从这里取。 */
export function useCustomizationPreferences(store?: CustomizationStore): CustomizationPreferences {
  return useCustomizationState(store).preferences;
}
