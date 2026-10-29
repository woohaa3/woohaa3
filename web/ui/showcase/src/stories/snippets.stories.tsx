import { useEffect, useMemo, useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { DialogHost } from "../../../../frontend/src/cordis/ui/index";
import { SNIPPET_LIBRARY_DIALOG_ID } from "@woohaa3/extension-prompt-snippets/frontend";
import {
	DialogStage,
	createDeleteConfirmRenderer,
	createEditorRenderer,
	useShowcaseCatalog,
	useShowcaseEditorDeps,
	useSnippetDialogService,
	loadFixtureSnippet,
	SNIPPET_DELETE_DIALOG_ID,
	SNIPPET_EDITOR_DIALOG_ID,
	type CatalogEvent,
	type CatalogEventSink,
} from "../snippet-fixtures.js";
import { ObservableLog } from "../dialog-fixtures.js";

export default {
	title: "画布组件/弹窗/提示词片段",
} satisfies StoryDefault;

/**
 * 片段库：library/tags 双视图、搜索、筛选、计数、条目菜单、footer。
 *
 * 走生产 `DialogService` + `DialogHost`，打开 editor / delete-confirm 是真实 action
 * （无 noop）；上下文（搜索/筛选）返回后保留（任务 3.2 / 3.3）。
 */
export const Library: Story = () => (
	<SnippetFlowStage narrow={false} caption="片段库 · library 视图" />
);
Library.storyName = "片段库";

/**
 * 连续 flow：library → editor → save/back 与 library → delete-confirm → return，
 * 使用生产 `DialogService` + `DialogHost`，上下文（搜索/筛选）保留（任务 3.3）。
 */
export const LibraryFlow: Story = () => (
	<SnippetFlowStage narrow={false} caption="片段库连续 flow · 生产 DialogHost" />
);
LibraryFlow.storyName = "连续 flow 桌面";

/** 编辑器：新建片段（名称、标签、正文 mention 编辑、素材清单）。 */
export const EditorCreate: Story = () => (
	<EditorStage mode="create" />
);
EditorCreate.storyName = "编辑器 新建";

/** 编辑器：编辑已有片段（异步加载）。 */
export const EditorEdit: Story = () => (
	<EditorStage mode="edit" snippetId="psnip-custom" />
);
EditorEdit.storyName = "编辑器 编辑";

/** 删除确认（复用 AlertDialog 语义）。 */
export const DeleteConfirm: Story = () => {
	const renderer = createDeleteConfirmRenderer(async () => ({ ok: true }));
	return (
		<DialogStage
			renderer={renderer}
			instanceId={SNIPPET_DELETE_DIALOG_ID}
			payload={{ snippetId: "psnip-custom", name: "我的夜景镜头" }}
			title="删除确认"
		/>
	);
};
DeleteConfirm.storyName = "删除确认";

/** 连续 flow 的窄屏（390×844）变体。 */
export const LibraryFlowNarrow: Story = () => (
	<SnippetFlowStage narrow caption="片段库连续 flow · 390×844" />
);
LibraryFlowNarrow.storyName = "连续 flow 窄屏";

/**
 * 稳定 fixture 快照（任务 3.1）：显示内存目录的条目与计数，作为计数断言的可见面。
 */
export const FixtureSnapshot: Story = () => <FixtureSnapshotView />;
FixtureSnapshot.storyName = "fixture 快照";

function EditorStage({
	mode,
	snippetId,
}: {
	mode: "create" | "edit";
	snippetId?: string;
}) {
	const catalog = useShowcaseCatalog();
	const deps = useShowcaseEditorDeps();
	const renderer = createEditorRenderer({
		catalog,
		candidates: deps.candidates,
		previews: deps.previews,
		actions: {
			loadSnippet: (id) => loadFixtureSnippet(id),
			saveCreate: (input) => catalog.createSnippet(input),
			saveUpdate: (input) => catalog.updateSnippet(input),
		},
	});
	return (
		<DialogStage
			renderer={renderer}
			instanceId={SNIPPET_EDITOR_DIALOG_ID}
			payload={
				mode === "create"
					? {
						mode,
						draftName: "我的夜景镜头",
						draftBody: "霓虹夜景，雨后街道，低机位仰拍，冷暖对比强烈。",
					}
					: { mode, ...(snippetId ? { snippetId } : {}) }
			}
			title={mode === "create" ? "片段编辑器 · 新建" : "片段编辑器 · 编辑"}
		/>
	);
}

function SnippetFlowStage({ narrow, caption }: { narrow: boolean; caption: string }) {
	const [events, setEvents] = useState<CatalogEvent[]>([]);
	const eventSink = useMemo<CatalogEventSink>(
		() => ({ push: (event: CatalogEvent) => setEvents((current) => [...current, event]) }),
		[],
	);
	const { service } = useSnippetDialogService({ events: eventSink });
	const [opened, setOpened] = useState(false);

	// 打开一次片段库，后续 editor/delete 由生产 renderer 在同一 service 上入栈。
	useEffect(() => {
		if (!opened) {
			service.open({ dialogId: SNIPPET_LIBRARY_DIALOG_ID, payload: {} });
			setOpened(true);
		}
	}, [opened, service]);

	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{caption}</div>
			<div
				className={`showcase__dialog-box${narrow ? " showcase__dialog-box--narrow" : ""}`}
				data-testid="snippet-flow-viewport"
			>
				<DialogHost dialogs={service} />
			</div>
			<ObservableLog label="catalog events" entries={events} />
		</div>
	);
}

function FixtureSnapshotView() {
	const catalog = useShowcaseCatalog();
	const [snapshot, setSnapshot] = useState<{
		all: number;
		builtIn: number;
		untagged: number;
		tags: Array<{ name: string; snippetCount: number }>;
	} | null>(null);

	useEffect(() => {
		void catalog.refresh().then(() => {
			const state = catalog.getState();
			const tagState = catalog.getTagState();
			setSnapshot({
				all: state.counts.all,
				builtIn: state.counts.builtIn,
				untagged: state.counts.untagged,
				tags: tagState.items.map((tag) => ({ name: tag.name, snippetCount: tag.snippetCount })),
			});
		});
	}, [catalog]);

	return (
		<pre className="showcase__hint" data-testid="fixture-snapshot">
			{JSON.stringify(snapshot, null, 2)}
		</pre>
	);
}
