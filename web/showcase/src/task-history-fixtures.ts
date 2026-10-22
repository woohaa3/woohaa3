/**
 * 任务历史查看页夹具（change: add-showcase-history-model-panels，任务 1.1–1.3；
 *   change: improve-task-history-experience，任务 6.1）。
 *
 * 查看页直接渲染生产 `TaskHistoryPage`，这里只提供一个**实现公开 `TaskHistoryClient`
 * contract** 的内存 client：可控 deferred/乱序响应、cursor 分页、error/retry、筛选候选、
 * 按 revision 合并的订阅事件、连接状态、resync 与复制/导航 recorder。
 *
 * 边界（design D1）：
 * - 不连接真实服务、不修改任务记录、不复制页面 markup；
 * - 所有 task ID、结果时间与媒体引用固定，**不读取当前时钟或运行时 timezone**；
 * - 订阅按公开 contract 交付 `TaskExecutionSummary`，由页面自己按 taskKey/revision 合并。
 */
import { useMemo } from "react";
import type {
  TaskExecutionDetail,
  TaskExecutionSummary,
  TaskHistoryCandidateQuery,
  TaskHistoryCandidateModel,
  TaskHistoryCandidates
} from "@woohaa3/contracts";import type {
  TaskHistoryClient,
  TaskHistoryConnectionStatus,
  TaskHistoryDetailResult,
  TaskHistoryFilter
} from "../../frontend/src/shared/task-history/client.js";
import { TaskHistoryError } from "../../frontend/src/shared/task-history/client.js";

/** 固定的“当前时间”参照；仅用来手写相对顺序，运行时不参与渲染。 */
export const FIXTURE_NOW = "2026-09-27T08:00:00.000Z";

/**
 * 由稳定 storageKey 构造**确定性**同源媒体 URL。
 *
 * 查看页没有 Media Remote；用内联 SVG 数据地址代替真实字节，保证截图可重复、且不产生
 * 任何网络请求（生产用 `mediaRemote.urlFor`）。
 */
export function fixtureMediaUrl(storageKey: string): string {
	const label = storageKey.split("/").pop() ?? storageKey;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#1c2530"/><rect x="8" y="8" width="304" height="184" fill="none" stroke="#3a4a5a" stroke-dasharray="6 4"/><text x="160" y="104" fill="#9fb3c8" font-family="sans-serif" font-size="14" text-anchor="middle">${label}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function event(sequence: number, occurredAt: string, kind: "scheduling" | "execution", stage: string) {
	return { sequence, occurredAt, kind, stage };
}

/** 详情即事实来源；列表读取其脱敏摘要视图（与生产 read model 同构）。 */
export const TASK_HISTORY_FIXTURES: TaskExecutionDetail[] = [
	{
		taskKey: "task-text-succeeded",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		source: "canvas",
		modelType: "language",
		modelKey: "doubao-seed-2-1-pro",
		modelTitle: "豆包 Seed 2.1 Pro",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-text-1",
		nodeTitle: "旁白",
		runId: "run-text-1",
		progress: 1,
		attempt: 1,
		recordRevision: 10,
		createdAt: "2026-09-27T07:40:00.000Z",
		startedAt: "2026-09-27T07:40:01.000Z",
		updatedAt: "2026-09-27T07:40:04.000Z",
		finishedAt: "2026-09-27T07:40:04.000Z",
		durationMs: 3400,
		admission: { catalogRevision: 6, schemaRevision: 2, configVersion: 3 },
		events: [
			event(0, "2026-09-27T07:40:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T07:40:01.000Z", "execution", "provider.started"),
			event(2, "2026-09-27T07:40:04.000Z", "execution", "pptask.succeeded")
		],
		request: { prompt: "用一句话概括薄雾森林的旅行者。", parameters: { temperature: 0.4, maxTokens: 256 } },
		result: { mediaKind: "text", text: "旅行者沿着潮湿的石阶走向林间微光。" }
	},
	{
		taskKey: "task-image-succeeded",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "image",
		modelKey: "doubao-seedream-4-0",
		modelTitle: "豆包 Seedream 4.0",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-image-2",
		nodeTitle: "主视觉",
		runId: "run-image-2",
		progress: 1,
		attempt: 1,
		recordRevision: 12,
		createdAt: "2026-09-27T07:30:00.000Z",
		startedAt: "2026-09-27T07:30:02.000Z",
		updatedAt: "2026-09-27T07:31:00.000Z",
		finishedAt: "2026-09-27T07:31:00.000Z",
		durationMs: 58000,
		events: [
			event(0, "2026-09-27T07:30:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T07:31:00.000Z", "execution", "pptask.succeeded")
		],
		request: { prompt: "薄雾森林中的旅行者，电影感光影", parameters: { size: "1024x1024", quality: "high" } },
		result: {
			mediaKind: "image",
			storageKey: "generation-outputs/a1b2c3d4e5f6.png",
			contentType: "image/png",
			size: 1_482_013,
			checksum: "a".repeat(64)
		}
	},
	{
		taskKey: "task-video-running",
		state: "running",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "video",
		modelKey: "doubao-seedance-1-0-pro",
		modelTitle: "豆包 Seedance 1.0 Pro",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-video-3",
		nodeTitle: "运镜",
		runId: "run-video-3",
		progress: 0.42,
		attempt: 1,
		recordRevision: 14,
		createdAt: "2026-09-27T07:20:00.000Z",
		startedAt: "2026-09-27T07:20:05.000Z",
		updatedAt: "2026-09-27T07:21:10.000Z",
		durationMs: 0,
		events: [
			event(0, "2026-09-27T07:20:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T07:21:10.000Z", "execution", "provider.progress")
		],
		request: {
			prompt: "镜头低角度跟随旅行者前行",
			parameters: { ratio: "16:9", resolution: "720p", durationSeconds: 5 }
		}
	},
	{
		taskKey: "task-audio-succeeded",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "audio",
		modelKey: "doubao-seed-audio-1-0",
		modelTitle: "豆包 Seed Audio 1.0",
		// 缺 nodeId：不可跳转（缺少可访问的节点 identity）。
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		runId: "run-audio-4",
		progress: 1,
		attempt: 1,
		recordRevision: 9,
		createdAt: "2026-09-27T07:10:00.000Z",
		startedAt: "2026-09-27T07:10:01.000Z",
		updatedAt: "2026-09-27T07:10:20.000Z",
		finishedAt: "2026-09-27T07:10:20.000Z",
		durationMs: 19000,
		events: [
			event(0, "2026-09-27T07:10:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T07:10:20.000Z", "execution", "pptask.succeeded")
		],
		request: { prompt: "林间风声与远处鸟鸣", parameters: { format: "mp3", durationSeconds: 12 } },
		result: {
			mediaKind: "audio",
			storageKey: "generation-outputs/f9e8d7c6b5a4.mp3",
			contentType: "audio/mpeg",
			size: 384_512,
			checksum: "b".repeat(64),
			durationSeconds: 12
		}
	},
	{
		taskKey: "task-video-succeeded",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "video",
		modelKey: "doubao-seedance-1-0-pro",
		modelTitle: "豆包 Seedance 1.0 Pro",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-video-5",
		nodeTitle: "成片",
		runId: "run-video-5",
		progress: 1,
		attempt: 1,
		recordRevision: 13,
		createdAt: "2026-09-27T07:00:00.000Z",
		startedAt: "2026-09-27T07:00:04.000Z",
		updatedAt: "2026-09-27T07:03:00.000Z",
		finishedAt: "2026-09-27T07:03:00.000Z",
		durationMs: 176000,
		events: [
			event(0, "2026-09-27T07:00:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T07:03:00.000Z", "execution", "pptask.succeeded")
		],
		request: { prompt: "镜头缓推向远景", parameters: { ratio: "16:9", resolution: "1080p" } },
		result: {
			mediaKind: "video",
			storageKey: "generation-outputs/112233445566.mp4",
			contentType: "video/mp4",
			size: 8_912_345,
			checksum: "c".repeat(64),
			durationSeconds: 8,
			poster: {
				storageKey: "generation-outputs/poster-112233445566.png",
				contentType: "image/png",
				size: 91_200,
				checksum: "d".repeat(64)
			}
		}
	},
	{
		taskKey: "task-image-failed",
		state: "failed",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "image",
		modelKey: "doubao-seedream-4-0",
		modelTitle: "豆包 Seedream 4.0",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-image-6",
		nodeTitle: "雨夜",
		runId: "run-image-6",
		progress: 0.3,
		attempt: 2,
		recordRevision: 11,
		createdAt: "2026-09-27T06:50:00.000Z",
		startedAt: "2026-09-27T06:50:02.000Z",
		updatedAt: "2026-09-27T06:51:00.000Z",
		finishedAt: "2026-09-27T06:51:00.000Z",
		durationMs: 58000,
		error: { name: "ProviderError", message: "上游网关超时（已重试 2 次）" },
		events: [
			event(0, "2026-09-27T06:50:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T06:51:00.000Z", "execution", "pptask.failed")
		],
		request: { prompt: "雨夜霓虹街道", parameters: { size: "1024x1024" } }
	},
	{
		taskKey: "task-text-pending",
		state: "pending",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "language",
		modelKey: "doubao-seed-2-1-pro",
		modelTitle: "豆包 Seed 2.1 Pro",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-text-7",
		nodeTitle: "分镜旁白",
		runId: "run-text-7",
		attempt: 0,
		recordRevision: 7,
		createdAt: "2026-09-27T06:40:00.000Z",
		updatedAt: "2026-09-27T06:40:00.000Z",
		durationMs: 0,
		events: [event(0, "2026-09-27T06:40:00.000Z", "scheduling", "worker.enqueued")],
		request: { prompt: "为分镜写一句旁白", parameters: {} }
	},
	{
		taskKey: "task-image-cancelled",
		state: "cancelled",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "image",
		modelKey: "doubao-seedream-4-0",
		modelTitle: "豆包 Seedream 4.0",
		canvasId: "canvas-main",
		canvasTitle: "主画布",
		nodeId: "node-image-8",
		nodeTitle: "星轨",
		runId: "run-image-8",
		progress: 0.12,
		attempt: 1,
		recordRevision: 8,
		createdAt: "2026-09-27T06:30:00.000Z",
		startedAt: "2026-09-27T06:30:01.000Z",
		updatedAt: "2026-09-27T06:30:30.000Z",
		finishedAt: "2026-09-27T06:30:30.000Z",
		durationMs: 29000,
		events: [
			event(0, "2026-09-27T06:30:00.000Z", "scheduling", "worker.enqueued"),
			event(1, "2026-09-27T06:30:30.000Z", "execution", "pptask.cancelled")
		],
		request: { prompt: "夜空星轨长曝光", parameters: { size: "1024x1024" } }
	},
	{
		taskKey: "task-text-no-canvas",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		modelType: "language",
		modelKey: "doubao-seed-2-1-pro",
		modelTitle: "豆包 Seed 2.1 Pro",
		// 缺 canvasId：不可跳转（缺少可访问的画布 identity）。
		runId: "run-text-9",
		progress: 1,
		attempt: 1,
		recordRevision: 6,
		createdAt: "2026-09-27T06:20:00.000Z",
		startedAt: "2026-09-27T06:20:01.000Z",
		updatedAt: "2026-09-27T06:20:03.000Z",
		finishedAt: "2026-09-27T06:20:03.000Z",
		durationMs: 2100,
		events: [event(0, "2026-09-27T06:20:03.000Z", "execution", "pptask.succeeded")],
		request: { prompt: "独立的文本补全（无画布来源）", parameters: {} },
		result: { mediaKind: "text", text: "独立任务结果。" }
	},
	{
		// 受信任插件受理的非画布任务（阶段二 D1）：无 canvasId，来源为 extension。
		taskKey: "task-plugin-succeeded",
		state: "succeeded",
		providerId: "litellm",
		providerName: "LiteLLM",
		source: "extension",
		extensionId: "sample-site",
		modelType: "language",
		modelKey: "doubao-seed-2-1-pro",
		modelTitle: "豆包 Seed 2.1 Pro",
		runId: "run-plugin-10",
		progress: 1,
		attempt: 1,
		recordRevision: 5,
		admission: { catalogRevision: 6, extensionConfigVersion: 4 },
		createdAt: "2026-09-27T06:10:00.000Z",
		startedAt: "2026-09-27T06:10:01.000Z",
		updatedAt: "2026-09-27T06:10:03.000Z",
		finishedAt: "2026-09-27T06:10:03.000Z",
		durationMs: 2200,
		events: [event(0, "2026-09-27T06:10:03.000Z", "execution", "pptask.succeeded")],
		request: { prompt: "站点插件发起的摘要任务", parameters: {} },
		result: { mediaKind: "text", text: "插件任务结果。" }
	}
];

/** 列表摘要视图：与生产一样，列表不含事件时间线与请求参数。 */
export function summaryOf(detail: TaskExecutionDetail): TaskExecutionSummary {
	const { events: _events, request: _request, ...summary } = detail;
	return summary;
}

/** 列表的正式排序：创建时间倒序，taskKey 兜底，保证 fixture 顺序稳定。 */
export function compareHistory(a: TaskExecutionSummary, b: TaskExecutionSummary): number {
	if (a.createdAt === b.createdAt) return a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0;
	return a.createdAt < b.createdAt ? 1 : -1;
}

function matchesFilter(task: TaskExecutionSummary, filter: TaskHistoryFilter): boolean {
	const states = filter.states && filter.states.length > 0 ? filter.states : filter.state ? [filter.state] : null;
	if (states && !states.includes(task.state)) return false;
	if (filter.providerId && task.providerId !== filter.providerId) return false;
	if (filter.modelType && task.modelType !== filter.modelType) return false;
	if (filter.modelKey && task.modelKey !== filter.modelKey) return false;
	if (filter.canvasId && task.canvasId !== filter.canvasId) return false;
	if (filter.nodeId && task.nodeId !== filter.nodeId) return false;
	if (filter.taskKey && task.taskKey !== filter.taskKey) return false;
	if (filter.source) {
		const recordSource = task.source ?? "unknown";
		if (recordSource !== filter.source) return false;
	}
	if (filter.extensionId && task.extensionId !== filter.extensionId) return false;
	if (filter.from && task.createdAt < filter.from) return false;
	if (filter.to && task.createdAt > filter.to) return false;
	return true;
}

export type TaskHistoryListCall = TaskHistoryFilter & { cursor?: string; limit?: number };

export type MemoryTaskHistoryClient = {
	client: TaskHistoryClient;
	/** 让下一次（或正在等待的）list 挂起，直到 `flushList`；用于 initial loading story。 */
	deferList(): void;
	/** 放行所有挂起的 list 请求。 */
	flushList(): void;
	/** 让下一次 list 请求失败；页面应显示错误并可重试。 */
	failNextList(message: string): void;
	/** 让下一次 detail 请求失败。 */
	failNextDetail(code: string, message: string): void;
	/** 让下一次 list 逆序交付旧响应（竞态验收）。 */
	raceNextListOrder(): void;
	/** 发出实时新增/更新事件（生产订阅 contract）。 */
	emit(detail: TaskExecutionDetail): void;
	/** 发出订阅错误 / 连接状态 / resync。 */
	emitError(error: unknown): void;
	emitStatus(status: TaskHistoryConnectionStatus): void;
	emitResync(): void;
	/** 已收到的 list 请求。 */
	listCalls: TaskHistoryListCall[];
	/** 已收到的 detail 请求（taskKey 顺序）。 */
	detailCalls: string[];
	/** 当前订阅者数量（用于断言卸载会退订）。 */
	subscriberCount(): number;
};

/**
 * 构造一个实现 `TaskHistoryClient` 的内存 client。
 *
 * - `records` 是唯一事实来源；`list` 返回脱敏摘要，`detail` 返回完整详情；
 * - cursor 是稳定 offset 字符串（生产是不透明 cursor，页面只负责回传）；
 * - 实时 `emit` 会**先更新事实来源**再通知订阅者，因此后续 list 也能看到新状态；
 * - 候选来自固定集合，包含已下线模型样本。
 */
export function useShowcaseTaskHistoryClient(
	options: { seed?: TaskExecutionDetail[]; deferList?: boolean; failInitialList?: string } = {}
): MemoryTaskHistoryClient {
	const key = JSON.stringify({ d: options.deferList ?? false, f: options.failInitialList ?? null, s: options.seed?.length ?? -1 });
	return useMemo(() => createMemoryTaskHistoryClient(options), [key]);
}

export function createMemoryTaskHistoryClient(
	options: { seed?: TaskExecutionDetail[]; deferList?: boolean; failInitialList?: string } = {}
): MemoryTaskHistoryClient {
	const records = new Map<string, TaskExecutionDetail>();
	for (const detail of options.seed ?? TASK_HISTORY_FIXTURES) records.set(detail.taskKey, detail);

	const listeners = new Set<{
		onRecord: (record: TaskExecutionSummary, cursor: number) => void;
		onStatus?: (status: TaskHistoryConnectionStatus) => void;
		onResync?: () => void;
		onError?: (error: unknown) => void;
	}>();
	const pendingList: Array<() => void> = [];
	let deferred = options.deferList ?? false;
	let failure: string | null = options.failInitialList ?? null;
	let detailFailure: { code: string; message: string } | null = null;
	let raceOrder = false;

	const client: TaskHistoryClient = {
		async list(filter = {}) {
			controls.listCalls.push({ ...filter });
			if (deferred) {
				await new Promise<void>((resolve) => {
					pendingList.push(resolve);
				});
			}
			if (failure) {
				const message = failure;
				failure = null;
				throw new Error(message);
			}
			if (raceOrder) {
				raceOrder = false;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const all = [...records.values()].map(summaryOf).filter((task) => matchesFilter(task, filter)).sort(compareHistory);
			const offset = filter.cursor ? Number(filter.cursor) : 0;
			const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
			const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
			const items = all.slice(start, start + limit);
			const next = start + items.length;
			return {
				items,
				watermark: Math.max(0, ...all.map((task) => task.recordRevision)),
				...(next < all.length ? { nextCursor: String(next) } : {})
			};
		},
		async detail(taskKey: string): Promise<TaskHistoryDetailResult> {
			controls.detailCalls.push(taskKey);
			if (detailFailure) {
				const value = detailFailure;
				detailFailure = null;
				return { ok: false, code: value.code, message: value.message };
			}
			const found = records.get(taskKey);
			if (!found) return { ok: false, code: "task-not-found", message: `未找到任务 ${taskKey}` };
			return { ok: true, detail: found };
		},
		async candidates(query: TaskHistoryCandidateQuery = {}): Promise<TaskHistoryCandidates> {
			const providers = new Map<string, string>();
			const models = new Map<string, TaskHistoryCandidateModel>();
			const plugins = new Set<string>();
			for (const detail of records.values()) {
				providers.set(detail.providerId, detail.providerName ?? detail.providerId);
				if (detail.extensionId) plugins.add(detail.extensionId);
				if (!detail.modelKey || !detail.modelType) continue;
				models.set(`${detail.providerId}/${detail.modelKey}`, {
					providerId: detail.providerId,
					modelType: detail.modelType,
					modelKey: detail.modelKey,
					...(detail.modelTitle ? { modelTitle: detail.modelTitle } : {})
				});
			}
			void query;
			return {
				providers: [...providers].map(([providerId, providerName]) => ({ providerId, providerName })),
				models: [...models.values()],
				plugins: [...plugins].map((extensionId) => ({ extensionId }))
			};
		},
		subscribe(input) {
			const listener = {
				onRecord: input.onRecord,
				onStatus: input.onStatus,
				onResync: input.onResync,
				onError: input.onError
			};
			listeners.add(listener);
			input.onStatus?.({ state: "live", lastSyncedAt: FIXTURE_NOW });
			return () => {
				listeners.delete(listener);
			};
		}
	};

	const controls: MemoryTaskHistoryClient = {
		client,
		deferList() {
			deferred = true;
		},
		flushList() {
			deferred = false;
			for (const resolve of pendingList.splice(0)) resolve();
		},
		failNextList(message: string) {
			failure = message;
		},
		failNextDetail(code: string, message: string) {
			detailFailure = { code, message };
		},
		raceNextListOrder() {
			raceOrder = true;
		},
		emit(detail) {
			records.set(detail.taskKey, detail);
			const record = summaryOf(detail);
			for (const listener of listeners) listener.onRecord(record, detail.recordRevision);
		},
		emitError(error) {
			for (const listener of listeners) listener.onError?.(error);
		},
		emitStatus(status) {
			for (const listener of listeners) listener.onStatus?.(status);
		},
		emitResync() {
			for (const listener of listeners) listener.onResync?.();
		},
		listCalls: [],
		detailCalls: [],
		subscriberCount() {
			return listeners.size;
		}
	};

	return controls;
}

/** 实时**插入**样本：不在 `TASK_HISTORY_FIXTURES` 里、创建时间最新，emit 后应进入新任务缓冲。 */
export const INSERTED_RUNNING_TASK: TaskExecutionDetail = {
	taskKey: "task-live-inserted",
	state: "running",
	providerId: "litellm",
	providerName: "LiteLLM",
	modelType: "image",
	modelKey: "doubao-seedream-4-0",
	modelTitle: "豆包 Seedream 4.0",
	canvasId: "canvas-main",
	canvasTitle: "主画布",
	nodeId: "node-live-1",
	nodeTitle: "实时插入",
	runId: "run-live-1",
	progress: 0.15,
	attempt: 1,
	recordRevision: 99,
	createdAt: "2026-09-27T07:55:00.000Z",
	startedAt: "2026-09-27T07:55:01.000Z",
	updatedAt: "2026-09-27T07:55:03.000Z",
	durationMs: 0,
	events: [event(0, "2026-09-27T07:55:00.000Z", "scheduling", "worker.enqueued")],
	request: { prompt: "实时插入的图片任务", parameters: { size: "1024x1024" } }
};

/** running → succeeded 的实时更新样本（保留 taskKey 与画布来源）。 */
export function completeRunningTask(detail: TaskExecutionDetail, occurredAt: string): TaskExecutionDetail {
	return {
		...detail,
		state: "succeeded",
		progress: 1,
		updatedAt: occurredAt,
		finishedAt: occurredAt,
		durationMs: 42000,
		recordRevision: detail.recordRevision + 1,
		events: [...detail.events, event(detail.events.length, occurredAt, "execution", "pptask.succeeded")],
		result: { mediaKind: "text", text: "实时完成后写入的结果摘要。" }
	};
}

export { TaskHistoryError };
