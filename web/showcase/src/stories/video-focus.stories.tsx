import type { Story, StoryDefault } from "@ladle/react";
import {
	CAPTURED_FRAMES_STORY,
	CAPTURE_ERROR_STORY,
	BUSY_CAPTURE_STORY,
	PARTIAL_FAILURE_STORY,
	VideoFocusWorkspaceFixture,
} from "../video-dialog-fixtures.js";

/**
 * 视频聚焦工作区查看页
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 5.2）。
 *
 * 直接渲染**生产**共享截帧主体（`useCaptureSession` 与共享展示组件）；用内存 fake 解码源
 * 驱动播放状态与已有帧/部分失败/busy/只读态。不连接真实服务、不写 canonical canvas。
 */
export default {
	title: "画布组件/视频聚焦",
} satisfies StoryDefault;

/** 默认视频聚焦：有画面、播放/进度/静音、首/当前/尾帧、空帧集合。 */
export const FocusDefault: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · 默认" seed={{ video: { duration: 2, currentTime: 0.6, width: 160, height: 90, ready: true, playing: false, muted: false } }} />
);
FocusDefault.storyName = "默认";

/** 已有帧：多帧选择/取消/移除/清空与添加全部/选中。 */
export const FocusWithFrames: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · 已有帧" seed={CAPTURED_FRAMES_STORY} />
);
FocusWithFrames.storyName = "已有帧";

/** 部分失败：逐项结果 + 只重试失败项。 */
export const FocusPartialFailure: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · 部分失败" seed={PARTIAL_FAILURE_STORY} />
);
FocusPartialFailure.storyName = "部分失败";

/** busy：添加中重复提交/隐式关闭不可用。 */
export const FocusBusy: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · busy" seed={BUSY_CAPTURE_STORY} />
);
FocusBusy.storyName = "busy";

/** 只读历史播放：只读标识 + 本地可取帧但禁止添加。 */
export const FocusHistoryReadonly: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · 历史只读" seed={CAPTURED_FRAMES_STORY} readOnly />
);
FocusHistoryReadonly.storyName = "历史只读";

/** 当前无输出：空态面板（无真实源）。 */
export const FocusCurrentEmpty: Story = () => (
	<VideoFocusWorkspaceFixture
		title="视频聚焦 · 当前无输出"
		seed={{ video: { duration: 0, currentTime: 0, width: 0, height: 0, ready: false, playing: false, muted: false } }}
	/>
);
FocusCurrentEmpty.storyName = "当前无输出";

/** 捕获错误：跨域安全错误保留会话。 */
export const FocusCaptureError: Story = () => (
	<VideoFocusWorkspaceFixture title="视频聚焦 · 捕获错误" seed={CAPTURE_ERROR_STORY} />
);
FocusCaptureError.storyName = "捕获错误";

/** 窄屏 390：控件可达、无横向溢出。 */
export const FocusNarrow: Story = () => (
	<div style={{ width: 390, maxWidth: "100%" }}>
		<VideoFocusWorkspaceFixture title="视频聚焦 · 窄屏 390" seed={PARTIAL_FAILURE_STORY} width={390} />
	</div>
);
FocusNarrow.storyName = "窄屏 390";
