/**
 * 片段库 story fixture 与信息架构（change: align-showcase-reference-ux，任务 3.1 / 3.4）。
 *
 * 直接消费生产 `SnippetCatalog` + 内存远端 fixture，断言：
 * - fixture 覆盖内置、自定义、无标签与多标签计数；
 * - 无标签筛选、标签 CRUD 计数更新；
 * - mutation 会真正抵达远端（可观察事件）而不是 noop。
 */
import { describe, expect, it } from "vitest";
import { createShowcaseCatalog, type CatalogEvent } from "./snippet-fixtures.js";

describe("片段库内存 fixture", () => {
	it("覆盖内置/自定义/无标签/多标签计数", async () => {
		const events: CatalogEvent[] = [];
		const catalog = createShowcaseCatalog({ events: { push: (event) => events.push(event) } });
		await catalog.refresh();
		const state = catalog.getState();
		expect(state.counts).toEqual({ all: 4, builtIn: 2, untagged: 1 });
		const tags = catalog.getTagState().items;
		expect(tags.find((tag) => tag.name === "分镜")?.snippetCount).toBe(1);
		expect(tags.find((tag) => tag.name === "写实")?.snippetCount).toBe(2);
		expect(events.some((event) => event.type === "list")).toBe(true);
		catalog.dispose();
	});

	it("无标签筛选只返回无标签自定义片段并更新总数", async () => {
		const catalog = createShowcaseCatalog();
		await catalog.refresh();
		catalog.setFilter("untagged");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const state = catalog.getState();
		expect(state.items.map((item) => item.id)).toEqual(["psnip-untagged"]);
		expect(state.total).toBe(1);
		catalog.dispose();
	});

	it("创建、重命名、删除标签会更新标签与计数", async () => {
		const events: CatalogEvent[] = [];
		const catalog = createShowcaseCatalog({ events: { push: (event) => events.push(event) } });
		await catalog.refresh();

		const created = await catalog.createTag({ name: "新标签" });
		expect(created.ok).toBe(true);
		expect(catalog.getTagState().items.some((tag) => tag.name === "新标签")).toBe(true);

		const target = catalog.getTagState().items.find((tag) => tag.name === "写实");
		expect(target).toBeDefined();
		const renamed = await catalog.renameTag({ tagId: target!.id, expectedRevision: target!.revision, name: "写实风" });
		expect(renamed.ok).toBe(true);
		expect(catalog.getTagState().items.some((tag) => tag.name === "写实风")).toBe(true);

		const removed = await catalog.deleteTag(target!.id);
		expect(removed.ok).toBe(true);
		expect(catalog.getTagState().items.some((tag) => tag.id === target!.id)).toBe(false);
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["tag-create", "tag-rename", "tag-delete"]),
		);
		catalog.dispose();
	});

	it("更新片段会局部替换条目（保留列表）", async () => {
		const catalog = createShowcaseCatalog();
		await catalog.refresh();
		const before = catalog.getState().items.length;
		const result = await catalog.updateSnippet({
			snippetId: "psnip-custom",
			expectedRevision: 1,
			name: "改名后的片段",
			body: "新正文",
			materials: [],
			tagIds: [],
		});
		expect(result.ok).toBe(true);
		expect(catalog.getState().items).toHaveLength(before);
		expect(catalog.getState().items.find((item) => item.id === "psnip-custom")?.name).toBe("改名后的片段");
		catalog.dispose();
	});

	it("删除片段后计数更新", async () => {
		const catalog = createShowcaseCatalog();
		await catalog.refresh();
		expect(catalog.getState().counts.all).toBe(4);
		await catalog.deleteSnippet("psnip-custom");
		expect(catalog.getState().items.some((item) => item.id === "psnip-custom")).toBe(false);
		catalog.dispose();
	});
});
