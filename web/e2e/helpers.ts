/**
 * 共享的 E2E 辅助
 * （change: replace-godot-canvas-runtime-with-bevy，任务 8.2）。
 *
 * 只用**真实契约里的全局**与**产品自带的镜像**做断言：
 * - `window.__bevyRuntime`：Bevy 运行时状态（`isReady` / `renderedRevision` / `lastError`）。
 * - `window.__canvasSubmitCommands`：浏览器命令出口（交互控制器完成手势后的提交点）。
 * - `window.__canvasCanonical`：当前规范聚合（由 Y.Doc 派生；frontend 唯一持久化路径）。
 * - `window.__canvasSessionStatus`：会话状态（含 Yjs 同步相位）。
 *
 * Yjs 只有一条持久化路径：规范状态在**服务端**，浏览器 IndexedDB 只是可重建 cache。
 * 因此用例通过 `__canvasCanonical`（派生镜像）观察规范状态，而不是 IndexedDB。
 *
 * 已删除 Godot bridge：不再有 `canvasBridgeCommand`、帧缓冲、`__canvasFrameLog` 或
 * 「已应用帧版本」；Bevy 由 Web 每帧调用 `set_scene`，其 `renderedRevision` 是运行时信号。
 */
import type { Page } from "@playwright/test";
import { defaultSelfContained3DNodeData, type CanvasCommand } from "@woohaa3/contracts";

export type StoredCanvas = {
	id: string;
	revision: number;
	document: {
		schemaVersion: string;
		nodes: Array<{ id: string; type: string; position: { x: number; y: number } }>;
		edges: Array<{ id: string; source: string; target: string }>;
	};
	nodeData: Record<string, Record<string, unknown>>;
	assets: Array<{ id: string; url?: string; metadata?: Record<string, unknown> }>;
};

/** 等待 Bevy 运行时就绪（字体/相机 ready）。 */
export async function waitForBevyReady(page: Page): Promise<void> {
	await page.waitForFunction(
		() => (window as unknown as { __bevyRuntime?: { isReady?: () => boolean } }).__bevyRuntime?.isReady?.() === true,
		undefined,
		{ timeout: 60_000 }
	);
}

/** 等待画布会话就绪：命令出口已装好，且已与服务端 Yjs 同步完成。 */
export async function waitForCanvasSession(page: Page): Promise<void> {
	await waitForBevyReady(page);
	await page.waitForFunction(
		() => typeof (window as unknown as { __canvasSubmitCommands?: unknown }).__canvasSubmitCommands === "function",
		undefined,
		{ timeout: 30_000, polling: 100 }
	);
	// 同步完成前画布只读、命令会被拒。等派生聚合可用且会话进入 ready/synced。
	await page.waitForFunction(
		() => {
			const status = (window as unknown as { __canvasSessionStatus?: { phase?: string; remote?: { phase?: string } } })
				.__canvasSessionStatus;
			const canonical = (window as unknown as { __canvasCanonical?: unknown }).__canvasCanonical;
			return Boolean(canonical) && status?.phase === "ready" && status?.remote?.phase === "synced";
		},
		undefined,
		{ timeout: 30_000, polling: 100 }
	);
}

/** 在页面里注入读取规范聚合的辅助函数。必须在其它 helper 之前调用一次。 */
export async function installPageHelpers(page: Page): Promise<void> {
	await page.addInitScript(() => {
		(window as unknown as { __readCanvas: () => Promise<StoredCanvas | null> }).__readCanvas = async () =>
			((window as unknown as { __canvasCanonical?: StoredCanvas | null }).__canvasCanonical ?? null);
	});
}

// 页面内辅助函数在浏览器里是全局的；这里声明出来让 TS 通过。
declare function __readCanvas(): Promise<StoredCanvas | null>;

/** 读当前规范画布（由服务端 Y.Doc 派生；绕过 UI，断言规范真值）。 */
export async function readStoredCanvas(page: Page): Promise<StoredCanvas | null> {
	return page.evaluate(() => {
		return (window as unknown as { __canvasCanonical?: StoredCanvas | null }).__canvasCanonical ?? null;
	});
}

/** 等派生聚合的 revision 至少达到期望值（服务端投影经 Yjs 到达是异步的）。 */
export async function waitForPersistedRevision(page: Page, revision: number, timeoutMs = 30_000): Promise<void> {
	await page.waitForFunction(
		(expected: number) =>
			(((window as unknown as { __canvasCanonical?: StoredCanvas | null }).__canvasCanonical?.revision) ?? -1) >=
			expected,
		revision,
		// 用 interval 轮询：默认的 rAF 轮询会在软件渲染的大画布（如 200 节点）下被帧循环饿死。
		{ timeout: timeoutMs, polling: 100 }
	);
}

/** 当前派生聚合 revision（服务端投影经 Yjs 回流后的规范值）。 */
export async function canvasRevision(page: Page): Promise<number> {
	return (await readStoredCanvas(page))?.revision ?? 0;
}

/**
 * 等本页所有已提交命令批次落定（确认或拒绝）。
 *
 * 会话把乐观批次的 `pendingCount` 暴露在同步状态里：提交是同步登记、确认/拒绝是异步的，
 * 因此 `pendingCount === 0` 是「本地提交已全部结算」的确定性信号（比固定 sleep 可靠）。
 */
export async function waitForCommandsSettled(page: Page, timeoutMs = 30_000): Promise<void> {
	await page.waitForFunction(
		() =>
			(((window as unknown as {
				__canvasSessionStatus?: { remote?: { pendingCount?: number } };
			}).__canvasSessionStatus?.remote?.pendingCount) ?? 0) === 0,
		undefined,
		{ timeout: timeoutMs, polling: 100 }
	);
}

/** Bevy 已渲染的 2D revision（运行时信号）。 */
export async function readRenderedRevision(page: Page): Promise<number> {
	return page.evaluate(
		() => (window as unknown as { __bevyRuntime?: { renderedRevision?: () => number } }).__bevyRuntime?.renderedRevision?.() ?? 0
	);
}

/** 当前派生聚合 revision。 */
export async function currentFrameRevision(page: Page): Promise<number> {
	const canvas = await readStoredCanvas(page);
	return canvas?.revision ?? 0;
}

/**
 * 重置默认画布并建立权威 Yjs 文档，让每个用例从空画布开始。
 *
 * frontend 只有 Yjs 一条路径，规范状态在服务端；所以这里**不是**清 IndexedDB，
 * 而是通过 E2E server 的 `/__e2e_enable_yjs__` 以 `reset: true` 重建空 Yjs 文档。
 * 随后导航到 `/` 让应用连接同步。
 */
const DEFAULT_CANVAS_ID = "woohaa3-default-canvas";

export async function resetCanvasStorage(page: Page): Promise<void> {
	await seedYjsCanvas(page, DEFAULT_CANVAS_ID, []);
	await page.goto("/");
}

/** 通过 E2E server 清空全部画布（多画布用例从空目录开始）。 */
export async function resetAllCanvases(page: Page): Promise<void> {
	await page.request.post("/__e2e_reset_canvases__");
}

/** 通过 E2E server 为指定 canvasId 建立（或重建）权威 Yjs 文档。 */
export async function seedYjsCanvas(
	page: Page,
	canvasId: string,
	nodes: Array<{ id: string; type: string; position: { x: number; y: number } }> = [],
	options: { reset?: boolean; canvas?: Record<string, unknown> } = {}
): Promise<void> {
	const canvas = options.canvas ?? {
		id: canvasId,
		title: "E2E 画布",
		revision: 0,
		document: {
			schemaVersion: "asset-canvas-v1",
			nodes,
			edges: [],
			updatedAt: "2026-09-24T00:00:00.000Z"
		},
		nodeData: {},
		assets: [],
		jobs: [],
		updatedAt: "2026-09-24T00:00:00.000Z"
	};
	const response = await page.request.post("/__e2e_enable_yjs__", {
		data: { canvasId, canvas, reset: options.reset !== false }
	});
	if (!response.ok()) throw new Error(`seedYjsCanvas failed: ${response.status()}`);
}

/**
 * 通过真实的浏览器命令出口提交一个语义命令批次（等价于交互控制器完成一次手势）。
 *
 * 返回 `{ ok, reason }`：未同步/离线时命令出口返回结构化失败，不进入离线 outbox。
 */
export async function sendCommands(
	page: Page,
	commands: readonly CanvasCommand[],
	commandId?: string
): Promise<{ ok: boolean; reason?: string }> {
	return page.evaluate(
		({ commands: payload, commandId: id }) => {
			const submit = (window as unknown as {
				__canvasSubmitCommands?: (commands: CanvasCommand[], commandId?: string) => { ok: boolean; reason?: string };
			}).__canvasSubmitCommands;
			if (!submit) throw new Error("__canvasSubmitCommands 未安装");
			return submit(payload, id);
		},
		{ commands: [...commands], commandId }
	);
}

/**
 * 构造并提交一条创建节点命令；返回提交结果与提交后的规范 revision。
 *
 * 取代旧的 `sendCommand({ kind: "node.create" })` Godot 意图桥：直接提交当前 `CanvasCommand`。
 */
export async function createNode(
	page: Page,
	input: {
		nodeType: string;
		position?: { x: number; y: number };
		nodeId?: string;
		nodeData?: Record<string, unknown>;
		connect?: { fromNodeId: string; edgeId?: string; label?: string } | undefined;
		commandId?: string;
	}
): Promise<{ ok: boolean; revision: number }> {
	const nodeId = input.nodeId ?? `e2e-${input.nodeType}-${Date.now().toString(36)}`;
	const command: CanvasCommand = {
		type: "node.add",
		node: { id: nodeId, type: input.nodeType, position: input.position ?? { x: 0, y: 0 } },
		nodeData: (input.nodeData ?? defaultSelfContained3DNodeData(input.nodeType) ?? undefined) as never,
		...(input.connect
			? {
					connect: {
						fromNodeId: input.connect.fromNodeId,
						edgeId: input.connect.edgeId ?? `e2e-edge-${Date.now().toString(36)}-${nodeId}`,
						...(input.connect.label ? { label: input.connect.label } : {})
					}
				}
			: {})
	};
	const before = await canvasRevision(page);
	const result = await sendCommands(page, [command], input.commandId);
	if (!result.ok) return { ok: false, revision: before };
	await waitForCommandsSettled(page);
	return { ok: true, revision: (await readStoredCanvas(page))?.revision ?? before };
}

/** 提交一条移动节点命令；返回提交结果与提交后的规范 revision。 */
export async function moveNode(
	page: Page,
	input: { nodeId: string; position: { x: number; y: number }; commandId?: string }
): Promise<{ ok: boolean; revision: number }> {
	const before = await canvasRevision(page);
	const result = await sendCommands(
		page,
		[{ type: "node.update", nodeId: input.nodeId, position: input.position }],
		input.commandId
	);
	if (!result.ok) return { ok: false, revision: before };
	await waitForCommandsSettled(page);
	return { ok: true, revision: (await readStoredCanvas(page))?.revision ?? before };
}

/** 提交一条删除节点命令；返回提交结果与提交后的规范 revision。 */
export async function deleteNodes(
	page: Page,
	input: { nodeIds: readonly string[]; commandId?: string }
): Promise<{ ok: boolean; revision: number }> {
	const before = await canvasRevision(page);
	const result = await sendCommands(
		page,
		[{ type: "node.remove", nodeIds: [...input.nodeIds] }],
		input.commandId
	);
	if (!result.ok) return { ok: false, revision: before };
	await waitForCommandsSettled(page);
	return { ok: true, revision: (await readStoredCanvas(page))?.revision ?? before };
}

/** 提交一条 nodeData 合并补丁命令；返回提交结果与提交后的规范 revision。 */
export async function patchNodeData(
	page: Page,
	input: { nodeId: string; value: Record<string, unknown>; commandId?: string }
): Promise<{ ok: boolean; revision: number }> {
	const before = await canvasRevision(page);
	const result = await sendCommands(
		page,
		[{ type: "nodeData.patch", nodeId: input.nodeId, value: input.value as never }],
		input.commandId
	);
	if (!result.ok) return { ok: false, revision: before };
	await waitForCommandsSettled(page);
	return { ok: true, revision: (await readStoredCanvas(page))?.revision ?? before };
}

/**
 * 通过浏览器命令出口上报瞬时选择（`selection` 由 interaction controller 管理）。
 * 新运行时选中是纯浏览器状态；这里提供一个 E2E 可观察的等价入口。
 */
export async function sendSelection(
	page: Page,
	options: { nodeIds: string | null | readonly string[]; operationId: string; revision?: number }
): Promise<{ rejected?: { code: string; message: string } }> {
	const nodeIds = options.nodeIds === null ? [] : Array.isArray(options.nodeIds) ? [...options.nodeIds] : [options.nodeIds];
	await page.evaluate((ids) => {
		(window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.(ids);
	}, nodeIds);
	return {};
}

/** 通过同源媒体接口上传一份字节（E2E 里由内存存储承接）。 */
export async function uploadMedia(
	page: Page,
	bytes: number[],
	contentType = "image/png"
): Promise<{ status: number; body: Record<string, unknown> }> {
	return page.evaluate(
		async ({ bytes: payload, contentType: type }) => {
			const response = await fetch("/api/media", {
				method: "POST",
				headers: { "content-type": type },
				body: new Blob([new Uint8Array(payload)], { type })
			});
			return {
				status: response.status,
				body: (await response.json().catch(() => ({}))) as Record<string, unknown>
			};
		},
		{ bytes, contentType }
	);
}

