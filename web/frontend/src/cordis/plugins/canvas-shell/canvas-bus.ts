/**
 * Canvas 焦点总线的 React 侧接口。
 *
 * 总线实例惰性创建后挂在 `globalThis.__canvasBus` 上：谁先访问谁创建，
 * 后续访问者复用同一实例，因此这里拿到的是**同一个** emitter，而不是
 * 第二份总线。
 */
import mitt, { type Emitter } from "mitt";

/** 节点种类，与运行时节点种类一一对应。 */
export type CanvasNodeKind =
	| "text"
	| "image"
	| "video"
	| "audio"
	| "model3d"
	| "composite-asset"
	| "unknown";

/** 当前聚焦/悬停节点的完整快照。 */
export interface CanvasFocus {
	/** FlowNode.uid —— Web 分配的规范节点 ID（不是运行时本地计数器）。 */
	uid: string;
	kind: CanvasNodeKind;
	/** 节点种类枚举名，例如 "GENERATE_3D"。 */
	kindName: string;
	title: string;
	subtitle: string;
	index: string;
	tag: string;
	agent: string;
	prompt: string;
	jsPath: string;
	hasImage: boolean;
	hasModel: boolean;
	imageEditing: boolean;
}

/** 引擎启动状态。 */
export interface CanvasRuntimeInfo {
	ready: boolean;
	/** 最近一次生成用的场景 id。 */
	scene: string;
	/** 最近一次载荷的 ops 数量。 */
	ops: number;
	/** 发布时刻 Date.now()。 */
	at: number;
}

/**
 * 总线事件表，`mitt<Events>()` 据此推导每个 handler 的参数类型。
 *
 * 用 type alias 而非 interface：mitt 的约束是 `Record<EventType, unknown>`，
 * 而 TS 只对 type alias 推断隐式索引签名，interface 会报 TS2344。
 */
export type CanvasBusEvents = {
	focus: CanvasFocus | null;
	hover: CanvasFocus | null;
	runtime: CanvasRuntimeInfo;
};

export interface CanvasBus {
	all: Emitter<CanvasBusEvents>["all"];
	on: Emitter<CanvasBusEvents>["on"];
	off: Emitter<CanvasBusEvents>["off"];
	emit: Emitter<CanvasBusEvents>["emit"];
	/** 补水位：订阅者可同步拿到最近一次的值，无需等下一次 emit。 */
	snapshot<K extends keyof CanvasBusEvents>(event: K): CanvasBusEvents[K];
}

const SNAPSHOT_KEYS = {
	focus: "__canvasFocus",
	hover: "__canvasHover",
	runtime: "__canvasRuntime",
} as const satisfies Record<keyof CanvasBusEvents, string>;

/**
 * 冻结的默认值。getSnapshot 必须返回稳定引用 —— 每次新建对象会让
 * useSyncExternalStore 认为状态一直在变，从而无限重渲染。
 */
const DEFAULT_RUNTIME: CanvasRuntimeInfo = Object.freeze({
	ready: false,
	scene: "",
	ops: 0,
	at: 0,
});

function createBus(): CanvasBus {
	const emitter = mitt<CanvasBusEvents>();
	const bus: CanvasBus = {
		all: emitter.all,
		on: emitter.on,
		off: emitter.off,
		emit: emitter.emit,
		snapshot<K extends keyof CanvasBusEvents>(event: K): CanvasBusEvents[K] {
			const key = SNAPSHOT_KEYS[event];
			const value = (globalThis as Record<string, unknown>)[key];
			if (event === "runtime") {
				return ((value as CanvasRuntimeInfo | undefined) ??
					DEFAULT_RUNTIME) as CanvasBusEvents[K];
			}
			return ((value as CanvasFocus | null | undefined) ?? null) as CanvasBusEvents[K];
		},
	};
	return bus;
}

/**
 * 取共享总线实例。运行时若已建则复用其 `snapshot`（保持两侧语义一致），
 * 否则用 npm 的 mitt 建一份同形状的。
 */
export function canvasBus(): CanvasBus {
	const g = globalThis as { __canvasBus?: CanvasBus };
	return (g.__canvasBus ??= createBus());
}

/** 订阅事件；返回解除订阅函数（mitt 按引用相等移除，适合 useEffect cleanup）。 */
export function onCanvasFocus(handler: (node: CanvasFocus | null) => void): () => void {
	const bus = canvasBus();
	bus.on("focus", handler);
	return () => bus.off("focus", handler);
}

/** 订阅悬停事件；返回解除订阅函数。 */
export function onCanvasHover(handler: (node: CanvasFocus | null) => void): () => void {
	const bus = canvasBus();
	bus.on("hover", handler);
	return () => bus.off("hover", handler);
}

/** 非 React 场景下读取当前聚焦节点。 */
export function currentFocus(): CanvasFocus | null {
	return canvasBus().snapshot("focus");
}

/** 非 React 场景下读取引擎状态。 */
export function currentRuntime(): CanvasRuntimeInfo {
	return canvasBus().snapshot("runtime");
}
