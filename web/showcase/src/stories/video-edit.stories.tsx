import type { Story, StoryDefault } from "@ladle/react";
import {
	BUSY_EDIT_STORY,
	EMPTY_EDIT_STORY,
	ERROR_STORY,
	EXISTING_ANNOTATION_STORY,
	POINT_AND_RANGE_STORY,
	VideoEditStory,
} from "../video-dialog-fixtures.js";

export default {
	title: "画布组件/弹窗/视频编辑标记",
} satisfies StoryDefault;

/** 空草稿：时间轴与新增点/区间，无编辑点。 */
export const Empty: Story = () => <VideoEditStory seed={EMPTY_EDIT_STORY} title="视频编辑 · 空草稿" />;
Empty.storyName = "空草稿";

/** 点与区间：稳定排序、选中与时间范围展示。 */
export const PointAndRange: Story = () => (
	<VideoEditStory seed={POINT_AND_RANGE_STORY} title="视频编辑 · 点与区间" />
);
PointAndRange.storyName = "点与区间";

/** 已有标注：含 shapes 与稳定 preview，工具/色板/线宽可见。 */
export const ExistingAnnotation: Story = () => (
	<VideoEditStory seed={EXISTING_ANNOTATION_STORY} title="视频编辑 · 已有标注" width={820} />
);
ExistingAnnotation.storyName = "已有标注";

/** 校验错误：缺 prompt 时确认被阻止。 */
export const ValidationError: Story = () => (
	<VideoEditStory seed={ERROR_STORY} title="视频编辑 · 校验错误" />
);
ValidationError.storyName = "校验错误";

/** busy：确认/标记图上传中禁止重复确认与隐式关闭。 */
export const Busy: Story = () => (
	<VideoEditStory seed={BUSY_EDIT_STORY} title="视频编辑 · 确认中" />
);
Busy.storyName = "busy 确认中";

/** 窄屏：390×844 下视频/时间轴/列表/工具/footer 纵向可达。 */
export const Narrow: Story = () => (
	<div style={{ width: 390, maxWidth: "100%" }}>
		<VideoEditStory seed={EXISTING_ANNOTATION_STORY} title="视频编辑 · 窄屏 390" width={390} />
	</div>
);
Narrow.storyName = "窄屏 390";
