import type { Story, StoryDefault } from "@ladle/react";
import {
	CAPTURED_FRAMES_STORY,
	CAPTURE_ERROR_STORY,
	BUSY_CAPTURE_STORY,
	PARTIAL_FAILURE_STORY,
	FrameCaptureStory,
} from "../video-dialog-fixtures.js";

export default {
	title: "画布组件/弹窗/视频截帧",
} satisfies StoryDefault;

/** 默认：仅播放器与捕获控制，尚无截取帧。 */
export const Default: Story = () => (
	<FrameCaptureStory seed={{ video: { duration: 2, currentTime: 0.6, width: 160, height: 90 } }} title="视频截帧 · 默认" />
);
Default.storyName = "默认";

/** 已有帧：多帧列表、选择/取消、清空与添加动作。 */
export const Captured: Story = () => (
	<FrameCaptureStory seed={CAPTURED_FRAMES_STORY} title="视频截帧 · 已有帧" />
);
Captured.storyName = "已有帧";

/** busy：捕获中重复捕获与隐式关闭不可用。 */
export const Busy: Story = () => (
	<FrameCaptureStory seed={BUSY_CAPTURE_STORY} title="视频截帧 · busy（添加中）" />
);
Busy.storyName = "busy";

/** capture error：跨域 tainted canvas 的安全错误，保留会话。 */
export const CaptureError: Story = () => (
	<FrameCaptureStory seed={CAPTURE_ERROR_STORY} title="视频截帧 · 跨域捕获错误" />
);
CaptureError.storyName = "捕获错误";

/** 部分失败：逐项结果 + 只重试失败项。 */
export const PartialFailure: Story = () => (
	<FrameCaptureStory seed={PARTIAL_FAILURE_STORY} title="视频截帧 · 部分失败" />
);
PartialFailure.storyName = "部分失败";

/** 窄屏：390×844 下无横向溢出、控件可达（FrameCaptureStory 自带 390 宽舞台）。 */
export const Narrow: Story = () => (
	<div style={{ width: 390, maxWidth: "100%" }}>
		<FrameCaptureStory seed={{ ...CAPTURED_FRAMES_STORY, error: "部分帧添加失败" }} title="视频截帧 · 窄屏 390" width={390} />
	</div>
);
Narrow.storyName = "窄屏 390";
