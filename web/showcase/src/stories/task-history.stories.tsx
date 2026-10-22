import { useReducer, useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { TaskHistoryPage } from "../../../frontend/src/pages/task-history/index.js";
import {
	completeRunningTask,
	useShowcaseTaskHistoryClient,
	fixtureMediaUrl,
	INSERTED_RUNNING_TASK,
	TASK_HISTORY_FIXTURES,
	type MemoryTaskHistoryClient
} from "../task-history-fixtures.js";

export default {
	title: "画布组件/任务历史",
} satisfies StoryDefault;

/**
 * 任务历史查看页。
 *
 * 直接渲染生产 `TaskHistoryPage`；这里只替换 IO（内存 client）、当前时间与 host 导航，
 * 组件、样式和交互都是线上同一份代码。所有时间来自 fixture（不读取当前时钟），
 * 因此列表与截图可重复。
 */
function HistoryFrame({
	controls,
	note,
	navigate,
	pageSize = 20,
}: {
	controls: MemoryTaskHistoryClient;
	note: string;
	navigate?: (input: { canvasId: string; nodeId: string }) => void;
	pageSize?: number;
}) {
	const [navigation, setNavigation] = useState<string | null>(null);
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>TaskHistoryPage</code> · {note}
			</div>
			<div className="showcase__frame showcase__frame--full">
				<TaskHistoryPage
					client={controls.client}
					resolveMediaUrl={fixtureMediaUrl}
					pageSize={pageSize}
					copyText={async () => true}
					onOpenCanvas={
						navigate
							? (input) => {
									setNavigation(`${input.canvasId} / ${input.nodeId}`);
									navigate(input);
								}
							: undefined
					}
				/>
			</div>
			<output className="showcase__log" data-testid="history-navigation">
				{navigation ? `onOpenCanvas(${navigation})` : "onOpenCanvas: 未触发"}
			</output>
		</div>
	);
}

/** ready 列表：覆盖文本/图片/视频/音频结果与 succeeded/running/failed/pending/cancelled。 */
export const Ready: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="ready 列表 · 4 类媒体 + 多状态" navigate={() => undefined} />;
};
Ready.storyName = "ready 列表";

/** 初始加载：client 一开始就挂起 list，页面显示骨架屏。 */
export const Loading: Story = () => {
	const controls = useShowcaseTaskHistoryClient({ deferList: true });
	return <HistoryFrame controls={controls} note="initial loading（list 挂起 · 骨架屏）" />;
};
Loading.storyName = "加载中";

/** 空结果：client 返回空页，页面显示空状态而不是错误。 */
export const Empty: Story = () => {
	const controls = useShowcaseTaskHistoryClient({ seed: [] });
	return <HistoryFrame controls={controls} note="空结果" />;
};
Empty.storyName = "空结果";

/** 加载失败：首次 list 失败，页面显示可诊断错误与「重试」；点重试后显示任务。 */
export const Error: Story = () => {
	const controls = useShowcaseTaskHistoryClient({ failInitialList: "历史加载失败：网关不可用（可点重试）" });
	return <HistoryFrame controls={controls} note="error / retry" />;
};
Error.storyName = "加载失败";

/** 分页：每页 4 条，cursor 翻页且不清空既有结果。 */
export const Pagination: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="cursor 分页 · 每页 4 条" pageSize={4} />;
};
Pagination.storyName = "分页";

/** 实时更新：既有 running 原位收敛为 succeeded；新任务进入去重「新任务」提示。 */
export const LiveUpdate: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	const [events, setEvents] = useState(0);
	const [version, bump] = useReducer((count: number) => count + 1, 0);
	void version;
	const running = TASK_HISTORY_FIXTURES.find((task) => task.taskKey === "task-video-running")!;
	const emit = (emitRecord: () => void) => {
		emitRecord();
		setEvents((value) => value + 1);
		bump();
	};
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>TaskHistoryPage</code> · 实时更新（原位 succeeded + 新任务提示）
			</div>
			<div className="showcase__actions">
				<button
					type="button"
					data-testid="emit-insert"
					onClick={() => emit(() => controls.emit(INSERTED_RUNNING_TASK))}
				>
					插入 running 任务
				</button>
				<button
					type="button"
					data-testid="emit-complete"
					onClick={() => emit(() => controls.emit(completeRunningTask(running, "2026-09-27T08:05:00.000Z")))}
				>
					标记为 succeeded
				</button>
			</div>
			<div className="showcase__frame showcase__frame--full">
				<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} pageSize={20} copyText={async () => true} />
			</div>
			<output className="showcase__log" data-testid="history-log">
				{events === 0 ? "实时事件：未发送" : `实时事件：已发送 ${events} 次`}
			</output>
		</div>
	);
};
LiveUpdate.storyName = "实时更新";

/** 详情：视频成功记录（poster/duration），可关闭并恢复焦点。 */
export const Detail: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="详情 · 视频结果与 metadata" />;
};
Detail.storyName = "详情";

/** 失败详情：首屏优先错误与失败阶段。 */
export const DetailFailed: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="详情 · 失败优先错误" />;
};
DetailFailed.storyName = "详情-失败";

/** 详情失效：深链接 taskKey 不存在时显示稳定反馈。 */
export const DetailNotFound: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="深链接详情失效" />;
};
DetailNotFound.storyName = "详情-失效";

/** 可跳转 / 不可跳转：可跳转调用 recorder，缺 canvas/node 的显示原因且不导航。 */
export const CanvasNavigation: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return <HistoryFrame controls={controls} note="画布跳转资格 · 可跳转 vs 不可跳转" navigate={() => undefined} />;
};
CanvasNavigation.storyName = "画布跳转";

/** 窄屏 390px：列表、筛选与详情都在 390px 宽度下可达。 */
export const Narrow: Story = () => {
	const controls = useShowcaseTaskHistoryClient();
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>TaskHistoryPage</code> · 390px 窄屏
			</div>
			<div className="showcase__frame showcase__frame--full showcase__frame--narrow">
				<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} pageSize={20} copyText={async () => true} />
			</div>
		</div>
	);
};
Narrow.storyName = "窄屏 390";
