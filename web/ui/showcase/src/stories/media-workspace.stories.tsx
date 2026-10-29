import type { Story, StoryDefault } from "@ladle/react";
import { CAPTURED_FRAMES_STORY, FrameCaptureStory } from "../video-dialog-fixtures.js";
import {
	MEDIA_IMAGE_READY,
	MEDIA_IMAGE_UNAVAILABLE,
	MediaImageStory,
} from "../media-dialog-fixtures.js";

export default {
	title: "画布组件/弹窗/媒体工作区",
} satisfies StoryDefault;

/** 图片 ready：生产 MediaDialog 的中性舞台 + 应用 chrome。 */
export const ImageReady: Story = () => <MediaImageStory fixture={MEDIA_IMAGE_READY} />;
ImageReady.storyName = "图片 ready";

/** 图片 unavailable：失效资产仍可关闭且显示原因。 */
export const ImageUnavailable: Story = () => <MediaImageStory fixture={MEDIA_IMAGE_UNAVAILABLE} />;
ImageUnavailable.storyName = "图片 不可用";

/**
 * 图片与视频桌面并列对比：两者应共享应用 Header/surface/边框/图标控件/focus 语言，
 * 又各自保持媒体舞台、辅助结果区与提交动作的功能层级。
 * 视频多状态（默认/已有帧/busy/error/部分失败）见「视频截帧」分组。
 */
export const CompareDesktop: Story = () => (
	<div className="showcase__stage">
		<div style={{ display: "flex", flexDirection: "column", gap: 28, width: "100%" }}>
			<MediaImageStory fixture={MEDIA_IMAGE_READY} />
			<FrameCaptureStory seed={CAPTURED_FRAMES_STORY} title="视频截帧 · 已有帧（与图片对照）" />
		</div>
	</div>
);
CompareDesktop.storyName = "图片与视频对照";

/** 390×844：图片与视频在同一窄屏视口下比较，均无横向溢出。 */
export const Narrow390: Story = () => (
	<div className="showcase__stage">
		<div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%" }}>
			<MediaImageStory fixture={MEDIA_IMAGE_READY} />
			<div style={{ width: 390, maxWidth: "100%" }}>
				<FrameCaptureStory
					seed={{ ...CAPTURED_FRAMES_STORY, error: "部分帧添加失败" }}
					title="视频截帧 · 窄屏 390"
					width={390}
				/>
			</div>
		</div>
	</div>
);
Narrow390.storyName = "390 窄屏";
