/**
 * Snippet Catalog 侧栏计数（change: align-showcase-reference-ux，任务 3.2）。
 *
 * `counts` 与当前查询无关，始终反映目录快照；标签关联数由 `listSnippetTags` 提供。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasRemoteService } from "@woohaa3/frontend/extension-api";
import { createSnippetCatalog } from "../src/frontend/catalog.js";

function remote(overrides: Partial<CanvasRemoteService> = {}): CanvasRemoteService {
	const listSnippets = vi.fn(async (query?: { filter?: string }) => {
		const total = query?.filter === "builtIn" ? 2 : query?.filter === "untagged" ? 1 : 4;
		return { ok: true as const, value: { items: [], nextCursor: null, total } };
	});
	return {
		listSnippets,
		listSnippetTags: vi.fn(async () => ({ ok: true as const, value: [] })),
		...overrides
	} as unknown as CanvasRemoteService;
}

describe("catalog 侧栏计数", () => {
	it("refresh 后 counts 反映全部/内置/无标签", async () => {
		const catalog = createSnippetCatalog({ remote: remote(), debounceMs: 0 });
		await catalog.refresh();
		expect(catalog.getState().counts).toEqual({ all: 4, builtIn: 2, untagged: 1 });
		catalog.dispose();
	});

	it("删除片段后 counts 重新拉取", async () => {
		let all = 4;
		const listSnippets = vi.fn(async (query?: { filter?: string }) => {
			const value =
				query?.filter === "builtIn" ? 2 : query?.filter === "untagged" ? 0 : all;
			return { ok: true as const, value: { items: [], nextCursor: null, total: value } };
		});
		const catalog = createSnippetCatalog({
			remote: remote({
				listSnippets,
				deleteSnippet: vi.fn(async () => {
					all = 3;
					return { ok: true as const, value: null };
				})
			} as never),
			debounceMs: 0
		});
		await catalog.refresh();
		await catalog.deleteSnippet("s1");
		expect(catalog.getState().counts.all).toBe(3);
		expect(catalog.getState().counts.untagged).toBe(0);
		catalog.dispose();
	});
});
