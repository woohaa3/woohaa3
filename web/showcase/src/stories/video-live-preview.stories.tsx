import type { Story, StoryDefault } from "@ladle/react";
import { useEffect, useRef, useState } from "react";
import { ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { FixtureStage, ProductionFixtureHeader } from "../fixtures/stage.js";
import { baseCanvas, canvasFixture } from "../fixtures/canvas.js";

export default {
	title: "画布组件/视频实时预览",
} satisfies StoryDefault;

const VIDEO_FIXTURE_URL = "fixtures/video-live-preview-fixture.webm";

/**
 * 视频帧会话夹具
 * （change: enable-video-node-live-preview，任务 5.1）。
 *
 * 用与生产**同一**「不可见 video 解码 → 帧 canvas → 纹理」路径，但把 Bevy `setTexture`
 * 替换为可见 `<canvas>`，让查看页能观察：
 * - 首帧 seek 后上传的真实画面（蓝）；
 * - hover 播放随时间变化到红色（fixture 前 1 秒蓝、后 1 秒红）；
 * - 离开后暂停并保留最后呈现帧。
 *
 * 挂载期间在 DOM 里保留一个隐藏的 `document.createElement("video")` 等价元素（不插入可见布局），
 * 与生产的 `HTMLVideoElement` 解码边界一致。
 */
function VideoFramePreview() {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [status, setStatus] = useState("加载中…");
	const [playing, setPlaying] = useState(false);

	useEffect(() => {
		const video = document.createElement("video");
		video.src = VIDEO_FIXTURE_URL;
		video.muted = true;
		video.loop = true;
		video.playsInline = true;
		video.preload = "auto";
		video.crossOrigin = "anonymous";
		videoRef.current = video;

		let disposed = false;
		let raf = 0;
		let lastUpload = 0;
		const MIN_INTERVAL = 1000 / 30;

		const paint = () => {
			const target = canvasRef.current;
			if (!target || !video.videoWidth) return;
			const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
			const width = Math.max(1, Math.round(video.videoWidth * scale));
			const height = Math.max(1, Math.round(video.videoHeight * scale));
			if (target.width !== width) target.width = width;
			if (target.height !== height) target.height = height;
			target.getContext("2d")?.drawImage(video, 0, 0, width, height);
			setStatus(`真实帧 ${width}×${height} @ ${video.currentTime.toFixed(2)}s`);
		};

		const tick = () => {
			if (disposed) return;
			if (performance.now() - lastUpload >= MIN_INTERVAL) {
				lastUpload = performance.now();
				paint();
			}
			raf = requestAnimationFrame(tick);
		};

		const onLoaded = () => {
			video.currentTime = Math.min(0.1, (video.duration || 0.2) / 2);
			raf = requestAnimationFrame(tick);
		};
		video.addEventListener("loadeddata", onLoaded);

		return () => {
			disposed = true;
			cancelAnimationFrame(raf);
			video.pause();
			video.removeAttribute("src");
			videoRef.current = null;
		};
	}, []);

	return (
		<div style={{ display: "grid", gap: 8 }}>
			<canvas
				ref={canvasRef}
				data-testid="video-frame-preview"
				onPointerEnter={() => {
					void videoRef.current?.play();
					setPlaying(true);
				}}
				onPointerLeave={() => {
					videoRef.current?.pause();
					setPlaying(false);
				}}
				style={{ width: 240, border: "1px solid var(--app-web-border)", borderRadius: 8 }}
			/>
			<code data-testid="video-frame-status">
				{playing ? "hover 播放中" : "已暂停（保留最后帧）"} · {status}
			</code>
		</div>
	);
}

/** 默认：真实首帧（蓝），与生产一致的视频会话路径。 */
export const LivePreview: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="视频节点实时预览"
			note="浏览器解码真实帧并上传；hover 播放随时间变化，离开暂停保留最后帧。"
		/>
		<VideoFramePreview />
		<ShowcasePanelHost canvas={baseCanvas("video")} />
	</FixtureStage>
);
LivePreview.storyName = "实时帧 生产路径";

/** video ready 输出 + poster：节点先显示 poster，真实帧到达后必须替换它。 */
export const PosterFallback: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="poster 回退" note="真实帧可用后必须替换 poster，不得继续作为最终内容。" />
		<ShowcasePanelHost canvas={canvasFixture("videoRunning")} />
	</FixtureStage>
);
PosterFallback.storyName = "poster 回退";
