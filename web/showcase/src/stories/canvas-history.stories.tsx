import type { Story, StoryDefault } from "@ladle/react";
import { useEffect } from "react";
import { CanvasHistoryBrowser } from "../../../frontend/src/cordis/ui/index";
import {
	useShowcaseCanvasHistoryController,
	previewFailureFixtures
} from "../canvas-history-fixtures.js";

export default {
	title: "画布组件/生成历史弹窗",
} satisfies StoryDefault;

/**
 * 画布「全部生成历史」只读弹窗。
 *
 * 直接渲染生产 `CanvasHistoryBrowser` + `CanvasHistoryController`；这里只替换 IO（内存
 * client）。交互与样式都是线上同一份代码，且**只读**——没有恢复/添加动作。
 *
 * 这里不经过 Dialog Host（弹窗壳），只展示弹窗内容体，便于在舞台上查看。
 */
function Frame({
	controls,
	note,
	canvasId = "canvas-main"
}: {
	controls: ReturnType<typeof useShowcaseCanvasHistoryController>;
	note: string;
	canvasId?: string;
}) {
	// 打开弹窗内容：controller 绑定到固定画布。
	useEffect(() => {
		void controls.controller.open({ canvasId });
	}, [controls, canvasId]);
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>CanvasHistoryBrowser</code> · {note}
			</div>
			<div className="showcase__frame showcase__frame--full">
				<CanvasHistoryBrowser controller={controls.controller} onClose={() => undefined} />
			</div>
		</div>
	);
}

/** ready 列表：覆盖文本/图片/视频/音频/模型与当前标记。 */
export const Ready: Story = () => {
	const controls = useShowcaseCanvasHistoryController();
	return <Frame controls={controls} note="ready · 五类内容 + 当前标记" />;
};
Ready.storyName = "ready 列表";

/** 初始加载：client 一开始就挂起 list。 */
export const Loading: Story = () => {
	const controls = useShowcaseCanvasHistoryController({ deferList: true });
	return <Frame controls={controls} note="initial loading（list 挂起）" />;
};
Loading.storyName = "加载中";

/** 空结果。 */
export const Empty: Story = () => {
	const controls = useShowcaseCanvasHistoryController({ seed: [] });
	return <Frame controls={controls} note="空结果" />;
};
Empty.storyName = "空结果";

/** 加载失败：显示可诊断错误与「重试」。 */
export const Error: Story = () => {
	const controls = useShowcaseCanvasHistoryController({ failInitial: "生成历史加载失败：网关不可用（可点重试）" });
	return <Frame controls={controls} note="error / retry" />;
};
Error.storyName = "加载失败";

/** 分页：每页 2 条，cursor 翻页且不清空既有结果。 */
export const Pagination: Story = () => {
	const controls = useShowcaseCanvasHistoryController({ pageSize: 2 });
	return <Frame controls={controls} note="cursor 分页 · 每页 2 条" />;
};
Pagination.storyName = "分页";

/** 窄屏 390px：筛选、列表与详情都可达。 */
export const Narrow: Story = () => {
	const controls = useShowcaseCanvasHistoryController();
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>CanvasHistoryBrowser</code> · 390px 窄屏
			</div>
			<div className="showcase__frame showcase__frame--narrow">
				<CanvasHistoryBrowser controller={controls.controller} onClose={() => undefined} />
			</div>
		</div>
	);
};
Narrow.storyName = "窄屏 390";

/**
 * 前往节点查看版本（任务 6.3）：只读总览不直接恢复；目标失效时禁用并说明原因。
 */
export const NodeVersionJump: Story = () => {
	const controls = useShowcaseCanvasHistoryController();
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>CanvasHistoryBrowser</code> · 前往节点查看版本 / 目标失效禁用
			</div>
			<div className="showcase__frame showcase__frame--full">
				<CanvasHistoryBrowser
					controller={controls.controller}
					onClose={() => undefined}
					onOpenNodeVersion={() => undefined}
					canOpenNodeVersion={(nodeId) =>
						nodeId === "node-video-3"
							? { ok: false, reason: "该作品已被删除，无法查看版本" }
							: { ok: true }
					}
				/>
			</div>
		</div>
	);
};
NodeVersionJump.storyName = "前往节点版本";

/**
 * 预览失败与重试（任务 6.2）：受控引用读取失败显示失败占位与可读原因，可重试；
 * 模型缩略图缺失同样显示占位，不出现浏览器破图。
 */
export const PreviewFailure: Story = () => {
	const controls = useShowcaseCanvasHistoryController({ seed: previewFailureFixtures() });
	return (
		<div className="showcase__stage showcase__stage--full">
			<div className="showcase__caption">
				<code>CanvasHistoryBrowser</code> · 预览失败占位 + 重试 + 模型占位
			</div>
			<div className="showcase__frame showcase__frame--full">
				<CanvasHistoryBrowser controller={controls.controller} onClose={() => undefined} />
			</div>
		</div>
	);
};
PreviewFailure.storyName = "预览失败与重试";
