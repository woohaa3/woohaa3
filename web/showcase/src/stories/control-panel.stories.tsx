import type { Story, StoryDefault } from "@ladle/react";
import {
	CanvasControlPanel,
	CanvasZoomControls,
	FitScreenIcon,
	SnippetLibraryIcon,
	WandSparklesIcon,
	ZoomInIcon,
	ZoomOutIcon,
	syncStatusView,
} from "../../../frontend/src/cordis/ui/index";
import type { SyncStatusView } from "../../../frontend/src/cordis/ui/index";
import { TaskActivityFeed } from "@woohaa3/extension-task-activity/frontend";
import {
	activityFixtureMediaUrl,
	createActivityStoreFixture,
	defaultActivitySeed
} from "../fixtures/activity-fixtures.js";

export default {
	title: "画布组件/右下角控件",
} satisfies StoryDefault;

const SYNCED: SyncStatusView = syncStatusView({
	mode: "remote",
	phase: "synced",
	pendingCount: 0,
	error: null,
	revision: 12,
});
const PENDING: SyncStatusView = syncStatusView({
	mode: "remote",
	phase: "synced",
	pendingCount: 3,
	error: null,
	revision: 12,
});
const OFFLINE: SyncStatusView = syncStatusView({
	mode: "offline",
	phase: "offline",
	pendingCount: 0,
	error: "网络已断开，画布只读",
	revision: 12,
});

/**
 * 画布右下角的统一控件面板：上排同步状态与功能图标、下排视图控件。
 *
 * 这里用**纯展示**的 `CanvasControlPanel` + `CanvasZoomControls`（注入无控制器的
 * 假 getController），与线上同一份组件代码。真实放置是 `position: fixed` 右下角；
 * 查看页把它固定在舞台里看外观。
 */
export const Panel: Story = () => (
	<div className="showcase__stage">
		<div className="showcase__caption">
			<code>CanvasControlPanel</code> · 同步状态（hover 只显示同步信息）/ 上排功能 / 下排视图
		</div>
		<div className="showcase__panel-stage">
			<CanvasControlPanel
				status={SYNCED}
				actions={[
					{ id: "assistant", label: "AI 助手", icon: WandSparklesIcon, tone: "primary", onActivate: () => undefined },
					{ id: "snippets", label: "提示词片段管理", icon: SnippetLibraryIcon, onActivate: () => undefined },
				]}
				viewport={<CanvasZoomControls getController={() => null} revision={0} />}
			/>
		</div>
	</div>
);
Panel.storyName = "默认";

/** 同步状态三种表现：稳态（hover 气泡）、待保存（气泡常驻）、断线（气泡常驻）。 */
export const SyncStatus: Story = () => (
	<div className="showcase__stage">
		<div className="showcase__caption">同步状态：稳态静置（hover 才显示气泡）/ 待保存气泡常驻 / 断线气泡常驻</div>
		<div className="showcase__icons">
			<div className="showcase__panel-stage">
				<CanvasControlPanel status={SYNCED} viewport={<CanvasZoomControls getController={() => null} revision={0} />} />
			</div>
			<div className="showcase__panel-stage">
				<CanvasControlPanel status={PENDING} viewport={<CanvasZoomControls getController={() => null} revision={0} />} />
			</div>
			<div className="showcase__panel-stage">
				<CanvasControlPanel status={OFFLINE} viewport={<CanvasZoomControls getController={() => null} revision={0} />} />
			</div>
		</div>
	</div>
);
SyncStatus.storyName = "同步状态";

/** 追加更多功能图标（后续会加）：验证上排可自然向右排列。 */
export const PanelWithMoreActions: Story = () => (
	<div className="showcase__stage">
		<div className="showcase__caption">上排可追加更多功能图标</div>
		<div className="showcase__panel-stage">
			<CanvasControlPanel
				actions={[
					{ id: "snippets", label: "提示词片段管理", icon: SnippetLibraryIcon, onActivate: () => undefined },
					{ id: "fit", label: "聚焦", icon: FitScreenIcon, onActivate: () => undefined },
					{ id: "disabled", label: "未启用功能", icon: ZoomInIcon, onActivate: () => undefined, disabled: true },
				]}
				viewport={<CanvasZoomControls getController={() => null} revision={0} />}
			/>
		</div>
	</div>
);
PanelWithMoreActions.storyName = "上排多个功能图标";

/** 只有视图控件（无功能图标）时的面板。 */
export const PanelViewportOnly: Story = () => (
	<div className="showcase__stage">
		<div className="showcase__caption">仅视图控件</div>
		<div className="showcase__panel-stage">
			<CanvasControlPanel viewport={<CanvasZoomControls getController={() => null} revision={0} />} />
		</div>
	</div>
);
PanelViewportOnly.storyName = "仅视图控件";

/**
 * 右下角工具 + 左下角活动栈并存
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 3.5 / design D6）。
 *
 * 在 390px 窄舞台里同时放置迁移后的 `CanvasControlPanel`（右下）与 `TaskActivityFeed`
 * （左下），用于验证两者互不遮挡、无横向溢出。
 */
export const CornerCoexistence: Story = () => {
	const controls = createActivityStoreFixture({ seed: defaultActivitySeed() });
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">
				右下角工具面板 + 左下角活动栈（窄屏避免重叠）
			</div>
			<div className="showcase__activity-stage showcase__activity-stage--narrow">
				<CanvasControlPanel
					status={SYNCED}
					actions={[{ id: "snippets", label: "提示词片段管理", icon: SnippetLibraryIcon, onActivate: () => undefined }]}
					viewport={<CanvasZoomControls getController={() => null} revision={0} />}
				/>
				<TaskActivityFeed
					store={controls.store}
					resolveMediaUrl={activityFixtureMediaUrl}
				/>
			</div>
		</div>
	);
};
CornerCoexistence.storyName = "右下工具 + 左下活动";

/** 图标一览。 */
export const Icons: Story = () => (
	<div className="showcase__stage">
		<div className="showcase__caption">控件图标</div>
		<div className="showcase__icons">
			<span className="showcase__icon-cell">
				<ZoomOutIcon className="showcase__icon-lg" />
				<code>ZoomOutIcon</code>
			</span>
			<span className="showcase__icon-cell">
				<ZoomInIcon className="showcase__icon-lg" />
				<code>ZoomInIcon</code>
			</span>
			<span className="showcase__icon-cell">
				<FitScreenIcon className="showcase__icon-lg" />
				<code>FitScreenIcon</code>
			</span>
			<span className="showcase__icon-cell">
				<SnippetLibraryIcon className="showcase__icon-lg" />
				<code>SnippetLibraryIcon</code>
			</span>
		</div>
	</div>
);
Icons.storyName = "图标一览";
