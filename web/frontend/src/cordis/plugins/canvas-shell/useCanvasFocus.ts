/**
 * 订阅画布焦点状态的 React hook。
 *
 * 用 `useSyncExternalStore` 而非 `useState + useEffect`：总线的 emit 是同步的
 * （mitt 的语义），且 `publish()` 会复用未变化的对象引用，所以 getSnapshot
 * 满足「同一状态必须返回同一引用」的约定，不会触发 tearing 警告或无谓重渲染。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type CanvasBusEvents,
	type CanvasFocus,
	type CanvasRuntimeInfo,
	canvasBus, } from "./canvas-bus.js";

/**
 * 当前聚焦的节点；无选中时为 `null`。
 *
 * ```tsx
 * const focus = useCanvasFocus();
 * if (focus?.kind === "image") // …
 * ```
 */
export function useCanvasFocus(): CanvasFocus | null {
	const bus = canvasBus();
	return useSyncExternalStore(
		(notify) => {
			bus.on("focus", notify);
			return () => bus.off("focus", notify);
		},
		() => bus.snapshot("focus"),
		() => null,
	);
}

/** 当前悬停的节点；无悬停时为 `null`。 */
export function useCanvasHover(): CanvasFocus | null {
	const bus = canvasBus();
	return useSyncExternalStore(
		(notify) => {
			bus.on("hover", notify);
			return () => bus.off("hover", notify);
		},
		() => bus.snapshot("hover"),
		() => null,
	);
}

/** 引擎启动状态（是否 ready、最近一次生成场景）。 */
export function useCanvasRuntime(): CanvasRuntimeInfo {
	const bus = canvasBus();
	return useSyncExternalStore(
		(notify) => {
			bus.on("runtime", notify);
			return () => bus.off("runtime", notify);
		},
		() => bus.snapshot("runtime"),
		() => bus.snapshot("runtime"),
	);
}

/** 泛用订阅：需要监听多个事件、或只需回调不需返回值时用它。 */
export function useCanvasEvent<K extends keyof CanvasBusEvents>(
	event: K,
	handler: (payload: CanvasBusEvents[K]) => void,
): void {
	const bus = canvasBus();
	// handler 放进 ref，订阅只在 event 变化时重建 —— 调用方无需 useCallback。
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		const wrapped = (payload: CanvasBusEvents[K]) => latest.current(payload);
		bus.on(event, wrapped);
		return () => bus.off(event, wrapped);
	}, [bus, event]);
}
