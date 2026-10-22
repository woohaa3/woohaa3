import {
	MediaDialog,
} from "../../frontend/src/cordis/ui/index";
import { DialogStage } from "./dialog-viewport.js";

/**
 * 节点媒体 Dialog（图片预览）查看页夹具
 * （change: 2026-09-29-align-node-media-dialogs，任务 4.1）。
 *
 * 直接渲染**生产** `MediaDialog`：不复制 markup、不引入 story 私有样式修正布局、不访问
 * 真实媒体/Canvas 服务。视频截帧状态复用 `video-dialog-fixtures.tsx` 的 `FrameCaptureStory`。
 */

/** 宽幅图片 fixture：证明舞台对宽图保持 contain 与稳定外框。 */
export const IMAGE_READY_URL =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='240'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232b6a5a'/%3E%3Cstop offset='1' stop-color='%230f2a33'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='240' fill='url(%23g)'/%3E%3Ccircle cx='470' cy='96' r='54' fill='%23ffd9a0' opacity='0.85'/%3E%3C/svg%3E";

export type MediaImageFixture = {
	instanceId: string;
	title: string;
	url: string | null;
	unavailableReason?: string;
};

export const MEDIA_IMAGE_READY: MediaImageFixture = {
	instanceId: "story-media-ready",
	title: "生成结果 · 电影感森林",
	url: IMAGE_READY_URL,
};

export const MEDIA_IMAGE_UNAVAILABLE: MediaImageFixture = {
	instanceId: "story-media-missing",
	title: "该媒体已失效",
	url: null,
	unavailableReason: "该图片资产已失效或不可预览",
};

/** 图片预览舞台：生产 `MediaDialog` 放进完整可用视口（桌面或 390）。 */
export function MediaImageStory({ fixture }: { fixture: MediaImageFixture }) {
	return (
		<DialogStage caption={fixture.title}>
			<MediaDialog
				instanceId={fixture.instanceId}
				title={fixture.title}
				url={fixture.url}
				kind="image"
				{...(fixture.unavailableReason ? { unavailableReason: fixture.unavailableReason } : {})}
				onClose={() => undefined}
			/>
		</DialogStage>
	);
}
