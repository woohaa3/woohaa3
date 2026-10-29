/**
 * 画布「全部生成历史」弹窗夹具
 * （change: add-canvas-generation-history-dialog）。
 *
 * 直接渲染生产 `CanvasHistoryBrowser` + `CanvasHistoryController`；这里只替换 IO（实现
 * `CanvasHistoryClient` contract 的内存 client）。
 *
 * 边界：
 * - 不连接真实服务、不修改任何规范状态；
 * - 预览引用是确定性 data URL（不产生网络请求），时间固定，截图可重复；
 * - client 只实现只读 list，与生产一致（无恢复/写入）。
 */
import { useMemo } from "react";
import type { CanvasGenerationHistoryListItem, NodeHistoryKindCounts } from "@woohaa3/contracts";
import { CanvasHistoryController, type CanvasHistoryClient } from "../../../frontend/src/cordis/plugins/node-history/canvas-history-controller.js";

/** 确定性同源预览（内联 SVG），避免真实字节与网络请求。 */
export function historyPreviewUrl(label: string): string {
	const safe = label.replace(/[<>&]/g, "");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#1c2530"/><rect x="8" y="8" width="304" height="184" fill="none" stroke="#3a4a5a" stroke-dasharray="6 4"/><text x="160" y="106" fill="#9fb3c8" font-family="sans-serif" font-size="15" text-anchor="middle">${safe}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 固定时间戳（不读取当前时钟，截图可重复）。 */
const T = (day: number, hour: number) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

export const CANVAS_HISTORY_FIXTURES: CanvasGenerationHistoryListItem[] = [	{
		entryId: "ngh-text-1",
		nodeId: "node-text-1",
		nodeTitle: "脚本节点",
		kind: "text",
		createdAt: T(27, 8),
		current: true,
		recoverable: true,
		previewable: true,
		source: { label: "文本生成" },
		preview: { kind: "text", excerpt: "旅行者沿着潮湿的石阶走向林间微光，薄雾在脚边散开。" }
	},
	{
		entryId: "ngh-image-1",
		nodeId: "node-image-2",
		nodeTitle: "主视觉",
		kind: "image",
		createdAt: T(27, 7),
		current: false,
		recoverable: true,
		previewable: true,
		source: { label: "图片生成" },
		preview: { kind: "image", href: historyPreviewUrl("image-01") }
	},
	{
		entryId: "ngh-video-1",
		nodeId: "node-video-3",
		nodeTitle: "分镜动画",
		kind: "video",
		createdAt: T(26, 20),
		current: false,
		recoverable: true,
		previewable: true,
		source: { label: "视频生成", durationSeconds: 8 },
		preview: { kind: "video", href: historyPreviewUrl("video-01"), posterHref: historyPreviewUrl("poster-01"), durationSeconds: 8 }
	},
	{
		entryId: "ngh-audio-1",
		nodeId: "node-audio-4",
		nodeTitle: "环境音",
		kind: "audio",
		createdAt: T(26, 12),
		current: false,
		recoverable: true,
		previewable: true,
		source: { label: "音频生成", durationSeconds: 12 },
		preview: { kind: "audio", href: historyPreviewUrl("audio-01"), durationSeconds: 12 }
	},
	{
		entryId: "ngh-model-1",
		nodeId: "node-gen-5",
		nodeTitle: "模型节点",
		kind: "model",
		createdAt: T(25, 18),
		current: false,
		recoverable: true,
		previewable: true,
		source: { label: "模型脚本" },
		preview: { kind: "model", thumbnailHref: historyPreviewUrl("model-01"), entry: { canvasId: "canvas-showcase", nodeId: "node-gen-5", entryId: "ngh-model-1" } }
	},
	{
		entryId: "ngh-text-2",
		nodeId: "node-text-1",
		nodeTitle: "脚本节点",
		kind: "text",
		createdAt: T(25, 9),
		current: false,
		recoverable: true,
		previewable: true,
		source: { label: "文本生成" },
		preview: { kind: "text", excerpt: "上一版旁白：夜色沉入森林，旅人停下脚步。" }
	}
];

/** 预览失败 fixture（任务 6.2）：悬空引用触发失败占位，模型缩略图为 null 触发占位。 */
export function previewFailureFixtures(): CanvasGenerationHistoryListItem[] {
  return [
    {
      entryId: "ngh-fail-image",
      nodeId: "node-image-fail",
      nodeTitle: "读取失败的图片",
      kind: "image",
      createdAt: T(27, 6),
      current: false,
      recoverable: true,
      previewable: true,
      source: { label: "图片生成" },
      preview: { kind: "image", href: "data:application/octet-stream;base64,%%INVALID%%" }
    },
    {
      entryId: "ngh-fail-model",
      nodeId: "node-model-fail",
      nodeTitle: "模型缩略图缺失",
      kind: "model",
      createdAt: T(27, 5),
      current: false,
      recoverable: true,
      previewable: false,
      source: { label: "模型脚本" },
      preview: { kind: "model", thumbnailHref: null, entry: { canvasId: "canvas-showcase", nodeId: "node-model-fail", entryId: "ngh-fail-model" } }
    }
  ];
}

function countsOf(items: readonly CanvasGenerationHistoryListItem[]): NodeHistoryKindCounts {	const counts: NodeHistoryKindCounts = { text: 0, image: 0, video: 0, audio: 0, model: 0 };
	for (const item of items) counts[item.kind] += 1;
	return counts;
}

export type MemoryCanvasHistoryClient = {
	controller: CanvasHistoryController;
	/** 让下一次 list 失败；用于 error story。 */
	failNext(message: string): void;
	/** 已收到的 list 请求（含 kind 与 cursor）。 */
	calls: Array<{ kind?: string; cursor?: string }>;
};

/**
 * 构造一个实现 `CanvasHistoryClient` 的内存 client，以及绑定它的 controller。
 *
 * seed 为唯一事实来源；cursor 是稳定 offset 字符串（生产是不透明 cursor，controller 只回传）。
 */
export function createMemoryCanvasHistoryClient(options: {
	seed?: CanvasGenerationHistoryListItem[];
	pageSize?: number;
	deferList?: boolean;
	failInitial?: string;
} = {}): MemoryCanvasHistoryClient {
	const records = options.seed ?? CANVAS_HISTORY_FIXTURES;
	const pageSize = options.pageSize ?? 20;
	const calls: Array<{ kind?: string; cursor?: string }> = [];
	let failure: string | null = options.failInitial ?? null;

	const client: CanvasHistoryClient = {
		async listCanvas(input) {
			calls.push({ ...(input.kind ? { kind: input.kind } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) });
			if (options.deferList) await new Promise<void>((resolve) => { pending.push(resolve); });
			if (failure) {
				const message = failure;
				failure = null;
				return { ok: false, code: "unavailable", error: message };
			}
			const filtered = input.kind ? records.filter((item) => item.kind === input.kind) : records;
			const offset = input.cursor ? Number(input.cursor) : 0;
			const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
			const items = filtered.slice(start, start + pageSize);
			const next = start + items.length;
			return {
				ok: true,
				items,
				nextCursor: next < filtered.length ? String(next) : null,
				total: filtered.length,
				kindCounts: countsOf(records)
			};
		}
	};
	const pending: Array<() => void> = [];

	return {
		controller: new CanvasHistoryController(client),
		failNext(message: string) {
			failure = message;
		},
		calls
	};
}

/** Story 用 controller 缓存：Ladle/Fast Refresh 重挂载时不重新发 list。 */
export function useShowcaseCanvasHistoryController(
	options: { seed?: CanvasGenerationHistoryListItem[]; pageSize?: number; deferList?: boolean; failInitial?: string } = {}
): MemoryCanvasHistoryClient {
	const key = JSON.stringify({ n: options.seed?.length ?? -1, p: options.pageSize ?? 20, d: options.deferList ?? false, f: options.failInitial ?? null });
	return useMemo(() => createMemoryCanvasHistoryClient(options), [key]);
}
