import { useMemo } from "react";
import {
	createFrameCaptureRenderer,
	createVideoEditRenderer,
	VIDEO_EDIT_DIALOG_ID,
	VIDEO_FRAME_CAPTURE_DIALOG_ID,
	validateVideoDialogPayload,
	useCaptureSession,
	CaptureButtons,
	CaptureFooterActions,
	CaptureFrameList,
	CapturePlaybackControls,
	type CapturedFrameEntry,
	type CaptureInitialState,
	type FrameCaptureSource,
	type VideoDialogPayload,
	type VideoEditStorySeed,
} from "../../../frontend/src/cordis/ui/index";
import type { VideoEditAnnotationShape, VideoEditIntent } from "@woohaa3/contracts";
import { DialogStage } from "./snippet-fixtures.js";

/**
 * 视频 dialogs 的查看页夹具
 * （change: port-video-editing-dialogs，任务 5.1 / 5.2）。
 *
 * 直接渲染**生产** renderer；只把网络与规范状态替换为内存 stub，并用确定性视频
 * fixture（`public/fixtures/video-edit-fixture.webm`，160×90、2 秒、左右分色）驱动
 * seek/canvas。story 不连接真实服务、不写 canonical canvas。
 */

const VIDEO_STORAGE_KEY = `sha256-${"a".repeat(64)}`;
/** 相对路径：Ladle 独立预览（根）与 e2e server 的 `/showcase/` 前缀下都可用。 */
export const VIDEO_FIXTURE_URL = "fixtures/video-edit-fixture.webm";

export function videoPayload(overrides: Partial<VideoDialogPayload> = {}): VideoDialogPayload {
	const payload: VideoDialogPayload = {
		videoAssetId: "asset-video-fixture",
		videoStorageKey: VIDEO_STORAGE_KEY,
		videoUrl: VIDEO_FIXTURE_URL,
		targetNodeId: "node-video-1",
		title: "示例视频",
		...overrides,
	};
	// story 直接使用规范校验后的 payload，保证与生产打开路径一致。
	const validated = validateVideoDialogPayload(payload);
	return validated.ok ? validated.payload : payload;
}

function frame(id: string, startSeconds: number, endSeconds?: number, prompt = ""): VideoEditIntent {
	return {
		id,
		startSeconds,
		...(endSeconds !== undefined ? { endSeconds } : {}),
		prompt,
		annotationShapes: [],
		frameWidth: 160,
		frameHeight: 90,
	};
}

const PREVIEW_STORAGE_KEY = `sha256-${"b".repeat(64)}`;

export const EMPTY_EDIT_STORY: VideoEditStorySeed = {
	video: { duration: 2, currentTime: 0, width: 160, height: 90 },
	intents: [],
};

export const POINT_AND_RANGE_STORY: VideoEditStorySeed = {
	video: { duration: 2, currentTime: 1, width: 160, height: 90 },
	intents: [
		frame("i1", 0.4, 0.8, "把左侧区域改为绿色"),
		frame("i2", 1.5, undefined, "镜头轻微推近"),
	],
};

const ANNOTATION_SHAPE: VideoEditAnnotationShape = {
	id: "s1",
	tool: "rect",
	color: "#ff3b30",
	strokeWidth: 2,
	points: [{ x: 0.05, y: 0.1 }, { x: 0.45, y: 0.9 }],
};

export const EXISTING_ANNOTATION_STORY: VideoEditStorySeed = {
	video: { duration: 2, currentTime: 0.5, width: 160, height: 90 },
	intents: [
		{
			...frame("i1", 0.4, 0.8, "高亮左侧红色区域"),
			annotationShapes: [ANNOTATION_SHAPE],
			annotationPreview: { assetId: "asset-preview", storageKey: PREVIEW_STORAGE_KEY, mediaType: "image/png" },
		},
	],
};

export const ERROR_STORY: VideoEditStorySeed = {
	video: { duration: 2, currentTime: 0.5, width: 160, height: 90 },
	intents: [frame("i1", 0.4, 0.8, "")],
	error: "请为每个编辑点填写修改提示词",
};

function makeFrame(id: string, timeSeconds: number, selected = true): CapturedFrameEntry {
	return { id, timeSeconds, selected, url: "", blob: new Blob([]) };
}

export const CAPTURED_FRAMES_STORY = {
	video: { duration: 2, currentTime: 1.2, width: 160, height: 90 },
	frames: [
		makeFrame("f1", 0),
		makeFrame("f2", 0.6),
		makeFrame("f3", 1.2),
		makeFrame("f4", 1.95, false),
	],
};

export const PARTIAL_FAILURE_STORY = {
	video: { duration: 2, currentTime: 0.4, width: 160, height: 90 },
	frames: [makeFrame("f1", 0), makeFrame("f2", 0.6), makeFrame("f3", 1.2)],
	receipts: [
		{ frameId: "f1", timeSeconds: 0, ok: true, nodeId: "video-frame-f1", assetId: "asset-1" },
		{ frameId: "f2", timeSeconds: 0.6, ok: false, error: "上传失败，请重试" },
		{ frameId: "f3", timeSeconds: 1.2, ok: true, nodeId: "video-frame-f3", assetId: "asset-3" },
	],
};

export const CAPTURE_ERROR_STORY = {
	video: { duration: 2, currentTime: 1, width: 160, height: 90 },
	error: "视频来源受跨域限制，无法读取画面像素。请使用已导入画布的同源视频。",
};

export const BUSY_CAPTURE_STORY = {
	video: { duration: 2, currentTime: 1, width: 160, height: 90 },
	captureBusy: "add" as const,
};

export const BUSY_EDIT_STORY = {
	video: { duration: 2, currentTime: 0.5, width: 160, height: 90 },
	intents: [frame("i1", 0.4, 0.8, "处理中…")],
	busy: true,
};

/** 截帧 dialog story：默认/已有帧/busy/error/部分失败/窄屏。 */
export function FrameCaptureStory({ seed, title, width = 640 }: {
	seed: Parameters<typeof createFrameCaptureRenderer>[0]["story"];
	title: string;
	width?: number;
}) {
	const renderer = useMemo(
		() => createFrameCaptureRenderer({ onAddFrames: async () => [], ...(seed ? { story: seed } : {}) }),
		[seed],
	);
	return (
		<DialogStage
			renderer={renderer}
			instanceId={VIDEO_FRAME_CAPTURE_DIALOG_ID}
			payload={videoPayload()}
			title={title}
			width={width}
		/>
	);
}

/** 编辑 dialog story：空草稿/点区间/已有标注/undo-redo/validation/窄屏。 */
export function VideoEditStory({ seed, title, width = 760 }: {
	seed: Parameters<typeof createVideoEditRenderer>[0]["story"];
	title: string;
	width?: number;
}) {
	const renderer = useMemo(
		() => createVideoEditRenderer({ onConfirm: async () => ({ ok: true }), ...(seed ? { story: seed } : {}) }),
		[seed],
	);
	return (
		<DialogStage
			renderer={renderer}
			instanceId={VIDEO_EDIT_DIALOG_ID}
			payload={videoPayload()}
			title={title}
			width={width}
		/>
	);
}

/**
 * 视频聚焦工作区 story 夹具
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 5.2）。
 *
 * 直接渲染**生产**共享截帧主体（`useCaptureSession` + `CapturePlaybackControls` /
 * `CaptureFrameList` / `CaptureFooterActions`）；用内存 fake `FrameCaptureSource` 提供确定性
 * 播放状态与已有帧/部分失败/busy/只读态，不连接真实服务、不写 canonical canvas。
 */
export function VideoFocusWorkspaceFixture({ seed, title, readOnly = false, width = 900 }: {
	seed: CaptureInitialState;
	title: string;
	readOnly?: boolean;
	width?: number;
}) {
	const source: FrameCaptureSource = useMemo(() => {
		const provided = seed.video;
		const video = {
			duration: provided?.duration ?? 0,
			currentTime: provided?.currentTime ?? 0,
			width: provided?.width ?? 0,
			height: provided?.height ?? 0,
			ready: provided?.ready ?? true,
			playing: provided?.playing ?? false,
			muted: provided?.muted ?? false,
		};
		let muted = video.muted;
		return {
			state: () => ({ ...video, muted }),
			subscribe: () => () => undefined,
			play: async () => undefined,
			pause: () => undefined,
			seek: async () => undefined,
			setMuted: (next) => { muted = next; },
			capture: async () => new Blob([]),
		};
	}, [seed]);
	const session = useCaptureSession({
		source,
		instanceId: "video-focus-story",
		targetNodeId: "node-video-1",
		onAddFrames: async () => [],
		initial: seed,
	});
	return (
		<div data-story-title={title} className="video-focus-workspace" data-video-focus-workspace="true" style={{ position: "relative", width, height: 420, background: "var(--app-web-panel)" }}>
			<div className="video-focus-workspace__stage" data-video-focus-stage="true" aria-label="视频画面" />
			<div className="video-focus-workspace__player" data-focus-canvas-chrome="true">
				<CapturePlaybackControls session={session} />
				<CaptureButtons session={session} />
			</div>
			<div className="video-focus-workspace__inspector" data-focus-canvas-chrome="true">
				{readOnly ? <span className="video-focus-workspace__readonly" role="status">历史版本预览（只读）</span> : null}
				<CaptureFrameList session={session} />
				<div className="video-focus-workspace__actions"><CaptureFooterActions session={session} /></div>
			</div>
		</div>
	);
}
