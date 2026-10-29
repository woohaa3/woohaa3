import { useMemo, type ComponentType } from "react";
import type { PromptSnippet, PromptSnippetTag, PromptSnippetMaterial } from "@woohaa3/contracts";
import {
	createDeleteConfirmRenderer,
	createEditorRenderer,
	createLibraryRenderer,
	createTagDeleteConfirmRenderer,
	createSnippetCatalog,
	SNIPPET_DELETE_DIALOG_ID,
	SNIPPET_EDITOR_DIALOG_ID,
	SNIPPET_LIBRARY_DIALOG_ID,
	SNIPPET_TAG_DELETE_DIALOG_ID,
	snippetDeleteDefinition,
	snippetEditorDefinition,
	snippetLibraryDefinition,
	snippetTagDeleteDefinition,
	type MaterialCandidate,
	type MaterialPreviewStore,
	type SnippetCatalog,
} from "@woohaa3/extension-prompt-snippets/frontend";
import {
	createReplaceConfirmRenderer,
	DialogHost,
	DialogService,
	PASTE_REPLACE_DIALOG_ID,
	replaceConfirmDefinition,
	type DialogDefinition,
	type DialogRenderer,
} from "../../../frontend/src/cordis/ui/index";

/**
 * 片段 dialog 的查看页夹具。
 *
 * 真实片段插件通过 `canvasRemote` 访问 Canvas Service；查看页没有后端，所以用一个
 * **内存中的假实现**替换远程依赖，接口与真实 adapter 的子集一致。组件、dialog
 * definition/renderer 都是生产实现的同一份代码，只有 IO 被替换
 * （change: align-showcase-reference-ux，design D1/D2 / 任务 3.1）。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z").toISOString();

type StoredSnippet = PromptSnippet;
type StoredTag = PromptSnippetTag & { snippetCount: number };

function snippet(id: string, name: string, body: string, tagIds: string[], builtIn: boolean): StoredSnippet {
	return { id, formatVersion: 1, builtIn, name, body, materials: [], tagIds, revision: 1, createdAt: NOW, updatedAt: NOW };
}

/**
 * 稳定 fixture 目录（任务 3.1）：覆盖内置、自定义、无标签与多标签计数。
 *
 * - 内置 2 条（各 1 个标签）
 * - 自定义有标签 1 条
 * - 自定义无标签 1 条
 * 计数期望：all=4、builtIn=2、untagged=1；标签「分镜」=1、「写实」=2。
 */
const INITIAL_SNIPPETS: StoredSnippet[] = [
	snippet("psnip-photoreal", "写实增强", "以写实摄影风格重绘：电影级布光，浅景深，细腻皮肤质感，8K 细节。", ["tag-photo"], true),
	snippet("psnip-storyboard", "分镜九宫格", "把内容拆解为九宫格分镜：每格描述镜头、主体、动作与构图，保持角色一致性。", ["tag-storyboard"], true),
	snippet("psnip-custom", "我的夜景镜头", "霓虹夜景，雨后街道，低机位仰拍，冷暖对比强烈。", ["tag-photo"], false),
	snippet("psnip-untagged", "临时草稿", "一句还没归类的提示词草稿，用于验证「无标签」筛选。", [], false),
];

const INITIAL_TAGS: StoredTag[] = [
	{ id: "tag-storyboard", name: "分镜", builtIn: true, revision: 1, createdAt: NOW, updatedAt: NOW, snippetCount: 1 },
	{ id: "tag-photo", name: "写实", builtIn: false, revision: 1, createdAt: NOW, updatedAt: NOW, snippetCount: 2 },
];

const ok = <T,>(value: T) => ({ ok: true as const, value });

/** 可观察的目录调用记录（任务 3.3/3.4：action 可观察）。 */
export type CatalogEvent =
	| { type: "list"; query: Record<string, unknown> }
	| { type: "create"; name: string }
	| { type: "update"; snippetId: string; name: string }
	| { type: "delete"; snippetId: string }
	| { type: "copy"; snippetId: string }
	| { type: "tag-create"; name: string }
	| { type: "tag-rename"; tagId: string; name: string }
	| { type: "tag-delete"; tagId: string };

/** 事件接收器：既接受数组（fixture/测试），也接受自定义 push。 */
export type CatalogEventSink = { push: (event: CatalogEvent) => void };

export type FakeSnippetRemoteOptions = {
	events?: CatalogEventSink;
	failList?: boolean;
	failCreate?: boolean;
	failUpdate?: boolean;
	failDelete?: boolean;
	failTagCreate?: boolean;
	failTagRename?: boolean;
	failTagDelete?: boolean;
	/**
	 * 「保存为片段」入口捕获的初始草稿（对齐生产 `saveNodeAsSnippet` 的 payload）。
	 * 提供后，带 `nodeId` 的 create 打开 editor 时会携带草稿，用真实入口而非 noop。
	 */
	createDraft?: { name?: string; body?: string };
};

/** 一个仅内存的最小远程实现（只覆盖片段目录用到的成员）。 */
export function createFakeSnippetRemote(options: FakeSnippetRemoteOptions = {}) {
	let snippets = INITIAL_SNIPPETS.map((entry) => ({ ...entry }));
	let tags = INITIAL_TAGS.map((entry) => ({ ...entry }));
	let seq = 0;
	const record = (event: CatalogEvent) => options.events?.push(event);

	const strip = ({ ...rest }: StoredSnippet): PromptSnippet => rest;

	return {
		async listSnippets(query: { query?: string; filter?: string; tagId?: string; limit?: number } = {}) {
			record({ type: "list", query });
			if (options.failList) {
				return { ok: false as const, code: "unavailable" as const, error: "查询失败（fixture）" };
			}
			const text = (query.query ?? "").trim().toLowerCase();
			const items = snippets
				.filter((entry) => {
					if (query.filter === "builtIn" && !entry.builtIn) return false;
					if (query.filter === "untagged" && (entry.builtIn || entry.tagIds.length > 0)) return false;
					if (query.filter === "tag" && (!query.tagId || !entry.tagIds.includes(query.tagId))) return false;
					if (!text) return true;
					return entry.name.toLowerCase().includes(text) || entry.body.toLowerCase().includes(text);
				})
				.sort((a, b) => (a.id < b.id ? -1 : 1));
			return ok({ items: items.map(strip), nextCursor: null, total: items.length });
		},
		async listSnippetTags() {
			return ok(tags.map((tag) => ({ ...tag, snippetCount: snippets.filter((s) => s.tagIds.includes(tag.id)).length })));
		},
		async getSnippet(snippetId: string) {
			const found = snippets.find((entry) => entry.id === snippetId);
			return found ? ok(strip(found)) : { ok: false as const, code: "SNIPPET_NOT_FOUND" as const, error: "片段不存在" };
		},
		async createSnippet(input: { name: string; body: string; materials: PromptSnippetMaterial[]; tagIds: string[] }) {
			record({ type: "create", name: input.name });
			if (options.failCreate) return { ok: false as const, code: "unavailable" as const, error: "保存失败（fixture）" };
			const created = snippet(`psnip-${++seq}`, input.name, input.body, input.tagIds, false);
			snippets = [...snippets, created];
			return ok(strip(created));
		},
		async updateSnippet(input: { snippetId: string; expectedRevision: number; name: string; body: string; tagIds: string[] }) {
			record({ type: "update", snippetId: input.snippetId, name: input.name });
			if (options.failUpdate) return { ok: false as const, code: "unavailable" as const, error: "保存失败（fixture）" };
			const found = snippets.find((entry) => entry.id === input.snippetId);
			if (!found) return { ok: false as const, code: "SNIPPET_NOT_FOUND" as const, error: "片段不存在" };
			if (found.revision !== input.expectedRevision) {
				return { ok: false as const, code: "SNIPPET_REVISION_CONFLICT" as const, error: "片段已被修改" };
			}
			found.name = input.name;
			found.body = input.body;
			found.tagIds = [...input.tagIds];
			found.revision += 1;
			return ok(strip(found));
		},
		async deleteSnippet(snippetId: string) {
			record({ type: "delete", snippetId });
			if (options.failDelete) return { ok: false as const, code: "unavailable" as const, error: "删除失败（fixture）" };
			snippets = snippets.filter((entry) => entry.id !== snippetId);
			return ok(null);
		},
		async createSnippetTag(input: { name: string }) {
			record({ type: "tag-create", name: input.name });
			if (options.failTagCreate) return { ok: false as const, code: "unavailable" as const, error: "标签创建失败（fixture）" };
			const created: StoredTag = { id: `tag-${++seq}`, name: input.name, builtIn: false, revision: 1, createdAt: NOW, updatedAt: NOW, snippetCount: 0 };
			tags = [...tags, created];
			return ok(created);
		},
		async renameSnippetTag(input: { tagId: string; name: string }) {
			record({ type: "tag-rename", tagId: input.tagId, name: input.name });
			if (options.failTagRename) return { ok: false as const, code: "unavailable" as const, error: "标签重命名失败（fixture）" };
			const found = tags.find((tag) => tag.id === input.tagId);
			if (!found) return { ok: false as const, code: "TAG_NOT_FOUND" as const, error: "标签不存在" };
			found.name = input.name;
			found.revision += 1;
			return ok(found);
		},
		async deleteSnippetTag(tagId: string) {
			record({ type: "tag-delete", tagId });
			if (options.failTagDelete) return { ok: false as const, code: "unavailable" as const, error: "标签删除失败（fixture）" };
			tags = tags.filter((tag) => tag.id !== tagId);
			snippets = snippets.map((entry) => ({ ...entry, tagIds: entry.tagIds.filter((id) => id !== tagId) }));
			return ok(null);
		},
		async resolveSnippetMaterial() {
			return { ok: false as const, code: "unavailable" as const, error: "查看页无媒体解析" };
		},
	};
}

export type FakeSnippetRemote = ReturnType<typeof createFakeSnippetRemote>;

/**
 * 从内存 fixture 读取单个片段（editor `loadSnippet` 的 IO 替换点）。
 *
 * 编辑器的加载只依赖目录读取，因此用一个独立的内存远端即可；保存/删除等 mutation 仍
 * 走 story 注入的同一个 `catalog`，保证连续性。
 */
export async function loadFixtureSnippet(snippetId: string): Promise<PromptSnippet | null> {
	const remote = createFakeSnippetRemote();
	const result = await remote.getSnippet(snippetId);
	return result.ok ? result.value : null;
}

/** 构造一个接在假远端上的片段目录（每个查看页 story 一份，互不影响）。 */
export function useShowcaseCatalog(options: FakeSnippetRemoteOptions = {}): SnippetCatalog {
	return useMemo(
		() => createSnippetCatalog({ remote: createFakeSnippetRemote(options) as never, debounceMs: 0 }),
		// options 由 story 模块级常量提供，稳定即可。
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);
}

/** 从 fixture 目录直接构造一个生产 catalog（组件测试用，不依赖 React）。 */
export function createShowcaseCatalog(options: FakeSnippetRemoteOptions = {}): SnippetCatalog {
	return createSnippetCatalog({ remote: createFakeSnippetRemote(options) as never, debounceMs: 0 });
}

/** 无素材的候选与预览存根（查看页片段不含素材引用）。 */
export function useShowcaseEditorDeps() {
	return useMemo(
		() => ({
			candidates: () => [] as MaterialCandidate[],
			previews: {
				get: () => ({ status: "loading" as const, url: null }),
				request: () => undefined,
				subscribe: () => () => undefined,
				version: () => 0,
				dispose: () => undefined,
			} satisfies MaterialPreviewStore,
		}),
		[],
	);
}

export type FakeDialogRenderer = ComponentType<{
	instance: {
		instanceId: string;
		dialogId: string;
		payload: unknown;
		parentInstanceId: null;
		dismissible: boolean;
		busy: boolean;
	};
	requestClose: () => void;
	setBusy: (busy: boolean) => void;
	replace: (payload: unknown) => void;
}>;

/**
 * 单个 dialog 的预览舞台：把某个 dialog 的 renderer 直接渲染在受控的假实例上。
 *
 * 真实运行时由 DialogHost 从 stack 解析 renderer；查看页为了聚焦单个弹窗外观，
 * 直接调用 renderer 并注入假的 `DialogRendererProps`。
 */
export function DialogStage({
	renderer,
	payload,
	instanceId,
	title,
	width,
	height,
	narrow,
}: {
	renderer: FakeDialogRenderer;
	payload: unknown;
	instanceId: string;
	title: string;
	width?: number;
	height?: number;
	narrow?: boolean;
}) {
	const Renderer = renderer;
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{title}</div>
			<div
				className={`showcase__dialog-box${narrow ? " showcase__dialog-box--narrow" : ""}`}
				style={{ ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }}
			>
				<Renderer
					instance={{ instanceId, dialogId: instanceId, payload, parentInstanceId: null, dismissible: true, busy: false }}
					requestClose={() => undefined}
					setBusy={() => undefined}
					replace={() => undefined}
				/>
			</div>
		</div>
	);
}

/**
 * 片段库 dialog 的完整 flow 舞台：library → editor / delete-confirm → 返回 library。
 *
 * 使用生产 `DialogService` + `DialogHost`，所以 stack/焦点/上下文保留全部走真实实现；
 * 内存 fixture 只替换 IO（design D1/D4 / 任务 3.3）。
 */
export function useSnippetDialogService(options: FakeSnippetRemoteOptions = {}): { service: DialogService; catalog: SnippetCatalog } {
	const catalog = useShowcaseCatalog(options);
	const service = useMemo(() => {
		const instance = new DialogService();
		const registrations: Array<{ dialogId: string; definition: DialogDefinition; renderer: DialogRenderer }> = [
			{
				dialogId: SNIPPET_LIBRARY_DIALOG_ID,
				definition: snippetLibraryDefinition,
				renderer: createLibraryRenderer(catalog, {
					openEditor: (payload) => {
						// 「保存为片段…」入口（带 nodeId）在 fixture 中携带捕获草稿，对齐生产
						// `saveNodeAsSnippet`；library 的「新建片段」不带 nodeId，保持空编辑器。
						instance.open({
							dialogId: SNIPPET_EDITOR_DIALOG_ID,
							payload:
								payload.mode === "create" && payload.nodeId
									? {
										...payload,
										...(options.createDraft?.name ? { draftName: options.createDraft.name } : {}),
										...(options.createDraft?.body ? { draftBody: options.createDraft.body } : {}),
									}
									: payload,
						});
					},
					requestDelete: (snippet) => {
						instance.open({
							dialogId: SNIPPET_DELETE_DIALOG_ID,
							payload: { snippetId: snippet.id, name: snippet.name },
						});
					},
					requestDeleteTag: (tag) => {
						instance.open({
							dialogId: SNIPPET_TAG_DELETE_DIALOG_ID,
							payload: { tagId: tag.id, name: tag.name },
						});
					},
					copyBody: async (snippet) => {
						options.events?.push({ type: "copy", snippetId: snippet.id });
						try {
							if (typeof navigator === "undefined" || !navigator.clipboard) {
								return { ok: false as const, error: "当前环境不支持剪贴板" };
							}
							await navigator.clipboard.writeText(snippet.body);
							return { ok: true as const };
						} catch (reason) {
							return {
								ok: false as const,
								error: reason instanceof Error ? reason.message : "复制失败",
							};
						}
					},
				}),
			},
			{
				dialogId: SNIPPET_EDITOR_DIALOG_ID,
				definition: snippetEditorDefinition,
				renderer: createEditorRenderer({
					catalog,
					candidates: () => [],
					previews: previewStub,
					actions: {
						loadSnippet: (snippetId) => loadFixtureSnippet(snippetId),
						saveCreate: (input) => catalog.createSnippet(input),
						saveUpdate: (input) => catalog.updateSnippet(input),
					},
				}),
			},
			{
				dialogId: SNIPPET_DELETE_DIALOG_ID,
				definition: snippetDeleteDefinition,
				renderer: createDeleteConfirmRenderer(async (payload) => {
					const result = await catalog.deleteSnippet(payload.snippetId);
					if (result.ok) {
						instance.close();
						return { ok: true };
					}
					return { ok: false, error: result.error };
				}),
			},
			{
				dialogId: SNIPPET_TAG_DELETE_DIALOG_ID,
				definition: snippetTagDeleteDefinition,
				renderer: createTagDeleteConfirmRenderer(async (tagId) => {
					const result = await catalog.deleteTag(tagId);
					if (result.ok) {
						instance.close();
						return { ok: true };
					}
					return { ok: false, error: result.error };
				}),
			},
		];
		for (const registration of registrations) instance.registerDialog(registration.dialogId, registration);
		return instance;
		// options 由调用方提供稳定引用；service 只随 catalog 重建。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [catalog]);
	return { service, catalog };
}

const previewStub: MaterialPreviewStore = {
	get: () => ({ status: "loading" as const, url: null }),
	request: () => undefined,
	subscribe: () => () => undefined,
	version: () => 0,
	dispose: () => undefined,
};

export {
	createDeleteConfirmRenderer,
	createEditorRenderer,
	createLibraryRenderer,
	createTagDeleteConfirmRenderer,
	createReplaceConfirmRenderer,
	DialogHost,
	DialogService,
	SNIPPET_DELETE_DIALOG_ID,
	SNIPPET_EDITOR_DIALOG_ID,
	SNIPPET_LIBRARY_DIALOG_ID,
	SNIPPET_TAG_DELETE_DIALOG_ID,
	PASTE_REPLACE_DIALOG_ID,
	snippetDeleteDefinition,
	snippetEditorDefinition,
	snippetLibraryDefinition,
	snippetTagDeleteDefinition,
	replaceConfirmDefinition,
};
