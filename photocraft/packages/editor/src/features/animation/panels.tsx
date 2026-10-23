/**
 * 时间轴与浏览器帧工作流面板（U77）。
 *
 * 结构沿用既有「菜单 → 工具组 → 参数栏 → 原图/属性反馈」：一个高级区域内的分组，不重做外壳。
 * 所有操作都经域会话（`controller.features.animation.*`）走命令门与草稿门禁：
 *
 * - 时间轴：建立/删除、帧率与时长、工作区范围；
 * - 播放与定位：上一帧/下一帧/定位、循环播放（会话态，不新增历史）；
 * - 帧编辑：新空白视频层、插入/复制/删除/恢复帧、显示原始帧、栅格化、解释素材帧率；
 * - 帧导入：浏览器解码图片帧后按字节交给内核（不接受路径），解码前先按内核预算拒绝；
 * - 交付：交付计划 + 动画 GIF + 帧序列 ZIP 下载；MP4/WebM 需要宿主 codec 端口，
 *   容器按端口实际能力协商，缺端口时禁用并给出端口自己的原因。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import {
  animationFrameBytes,
  type AnimationDeliveryPlan,
  type AnimationTimelineInfo,
  type AnimationVideoLayer
} from "@woohaa3/photocraft-protocol";
import { animationCodecPort, negotiateAnimationContainer, type AnimationNegotiation } from "./codec.js";
import { decodeFrameImages, FRAME_IMAGE_ACCEPT } from "./frame-decoder.js";
import { decodeVideoFrames } from "./video-decoder.js";
import { encodeFrameSequence } from "./frames-export.js";
import { zipStore } from "./zip-store.js";
import { TimelinePlayback, type PlaybackRange } from "./playback.js";

type Failure = { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTimelineInfo(value: unknown): AnimationTimelineInfo | null {
  if (!isRecord(value)) return null;
  const timeline = isRecord(value.timeline) ? value.timeline : null;
  const budget = isRecord(value.budget) ? value.budget : {};
  const layers = Array.isArray(value.videoLayers) ? value.videoLayers : [];
  const numberOf = (record: Record<string, unknown>, key: string, fallback = 0) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : fallback;
  return {
    timeline: timeline
      ? {
          fps: numberOf(timeline, "fps"),
          duration: numberOf(timeline, "duration"),
          current: numberOf(timeline, "current"),
          workStart: numberOf(timeline, "workStart"),
          workEnd: numberOf(timeline, "workEnd"),
          time: numberOf(timeline, "time")
        }
      : null,
    budget: {
      maxFrames: numberOf(budget, "maxFrames", 120),
      maxCumulativeFramePixels: numberOf(budget, "maxCumulativeFramePixels"),
      maxDecodeBytes: numberOf(budget, "maxDecodeBytes"),
      maxDeliveryBytes: numberOf(budget, "maxDeliveryBytes"),
      maxFps: numberOf(budget, "maxFps", 1000)
    },
    videoLayers: layers.filter(isRecord).map((layer): AnimationVideoLayer => ({
      layerId: numberOf(layer, "layerId"),
      name: typeof layer.name === "string" ? layer.name : "",
      frames: numberOf(layer, "frames"),
      fps: numberOf(layer, "fps"),
      showAltered: layer.showAltered !== false,
      hasOriginal: layer.hasOriginal === true
    }))
  };
}

function asPlan(value: unknown): AnimationDeliveryPlan | null {
  if (!isRecord(value)) return null;
  const number = (key: string) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : 0);
  return {
    frames: number("frames"),
    width: number("width"),
    height: number("height"),
    fpsMillis: number("fpsMillis"),
    frameBytes: number("frameBytes"),
    totalBytes: number("totalBytes")
  };
}

/** 把交付字节交给浏览器下载；不宣称已落盘（宿主交付端口负责可信写入）。 */
function download(bytes: Uint8Array, fileName: string, contentType: string): void {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** 未注册端口时的固定文案：说明「哪些可用」，而不是只说不可用。 */
const NO_CODEC_PORT = "当前宿主未注册视频编解码端口（WebCodecs + 容器封装），视频导入/导出不可用；帧序列与 GIF 仍可用";

const FRAME_ACTIONS: readonly { id: string; label: string; needsOriginal?: boolean; needsVideoLayer?: boolean }[] = [
  { id: "layer.videoLayers.newBlankVideoLayer", label: "新建空白视频层" },
  { id: "layer.videoLayers.insertBlankFrame", label: "插入空白帧", needsVideoLayer: true },
  { id: "layer.videoLayers.duplicateFrame", label: "复制当前帧", needsVideoLayer: true },
  { id: "layer.videoLayers.deleteFrame", label: "删除当前帧", needsVideoLayer: true },
  { id: "layer.videoLayers.restoreFrame", label: "恢复原始帧", needsOriginal: true, needsVideoLayer: true },
  { id: "layer.videoLayers.restoreAllFrames", label: "恢复全部原始帧", needsOriginal: true, needsVideoLayer: true },
  { id: "layer.videoLayers.showAlteredVideo", label: "显示修帧结果", needsVideoLayer: true },
  { id: "layer.videoLayers.rasterize", label: "栅格化视频层", needsVideoLayer: true }
];

export function TimelinePanel({ controller, readonly, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onChanged?: () => void;
}) {
  const [info, setInfo] = useState<AnimationTimelineInfo | null>(null);
  const [plan, setPlan] = useState<AnimationDeliveryPlan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fps, setFps] = useState(24);
  const [duration, setDuration] = useState(12);
  const [workStart, setWorkStart] = useState(0);
  const [workEnd, setWorkEnd] = useState(0);
  const [frame, setFrame] = useState(0);
  const [importName, setImportName] = useState("帧序列");
  const [importFps, setImportFps] = useState(24);
  const [footageFps, setFootageFps] = useState(24);
  const files = useRef<HTMLInputElement>(null);
  const videos = useRef<HTMLInputElement>(null);
  /** 在飞的 codec 请求（导出/导入共用）：取消按钮按 requestId 调用端口。 */
  const inFlight = useRef<string | null>(null);
  const revision = controller.currentView().document?.revision ?? 0;

  const animation = controller.features.animation;
  const timeline = info?.timeline ?? null;
  const document = controller.currentView().document;
  const videoTarget = info?.videoLayers.find((layer) => layer.layerId === document?.activeLayerId) ?? null;
  /**
   * 文档身份：切文档/关文档时变化，用于丢弃晚到的异步结果与停止播放。
   *
   * **不能**用修订号：导航与每次编辑都会推进修订，用修订号当代际会让播放每帧都被判定为
   * 「已切文档」而立即停止（也是把定位误判成内容修改的来源）。
   */
  const documentKey = document ? `${document.name}\u0000${document.width}x${document.height}` : "none";
  /** 最新文档身份的读取口：异步任务完成时用它判断结果是否已经过期。 */
  const documentKeyRef = useRef(documentKey);
  useEffect(() => { documentKeyRef.current = documentKey; }, [documentKey]);

  const refresh = useCallback(() => {
    const result = animation.timelineInfo();
    if (!result.ok) { setMessage(result.message); return; }
    setInfo(asTimelineInfo(result.value));
  }, [animation]);

  useEffect(() => { refresh(); }, [refresh, revision]);

  useEffect(() => {
    if (!timeline) return;
    setFps(timeline.fps);
    setDuration(timeline.duration);
    setWorkStart(timeline.workStart);
    setWorkEnd(timeline.workEnd);
    setFrame(timeline.current);
  }, [timeline?.fps, timeline?.duration, timeline?.workStart, timeline?.workEnd, timeline?.current, timeline]);

  useEffect(() => { if (videoTarget) setFootageFps(videoTarget.fps); }, [videoTarget?.layerId, videoTarget?.fps]);

  const fail = (result: Failure | { ok: true }) => {
    setMessage(result.ok ? null : result.message);
    if (result.ok) onChanged?.();
  };
  const run = (result: { ok: true } | Failure) => { fail(result); refresh(); };

  // 播放会话：代际跟随**文档身份**（不是修订号），否则每帧导航都会推进修订并立即停止播放。
  const generation = useRef<{ key: string; value: number }>({ key: documentKey, value: 0 });
  if (generation.current.key !== documentKey) {
    generation.current = { key: documentKey, value: generation.current.value + 1 };
  }
  const generationValue = generation.current.value;
  const playback = useMemo(() => {
    const resolveRange = (): PlaybackRange | null => {
      const current = animation.timelineInfo();
      if (!current.ok || !isRecord(current.value) || !isRecord(current.value.timeline)) return null;
      const raw = current.value.timeline;
      const value = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
      return { fps: value("fps"), duration: value("duration"), current: value("current"), workStart: value("workStart"), workEnd: value("workEnd") };
    };
    return new TimelinePlayback({
      generation: () => generation.current.value,
      range: resolveRange,
      navigate: (step) => {
        const result = animation.navigateTimeline("timeline.setFrame", { frame: step.frame });
        if (!result.ok) return { ok: false, message: result.message };
        if (result.value.historyAdded !== 0) {
          // 播放绝不新增历史；出现即视为实现缺陷，停止并报错而不是继续污染历史。
          return { ok: false, message: "播放意外新增了历史步骤，已停止" };
        }
        setFrame(step.frame);
        return { ok: true };
      },
      onState: (state, playMessage) => {
        setPlaying(state);
        if (playMessage) setMessage(playMessage);
      }
    });
  }, [animation]);

  useEffect(() => () => playback.stop(), [playback]);
  // 切文档/关文档：停止播放并作废旧代际（修订号变化不再打断播放）。
  useEffect(() => { playback.invalidate(); }, [playback, generationValue]);

  const codec = animationCodecPort();
  /**
   * 真实能力协商是异步的（`VideoEncoder.isConfigSupported`）；在结果回来之前入口保持禁用，
   * 不乐观宣称可用——否则 Safari 上会出现「按钮可点、点了才报错」。
   *
   * `negotiationGeneration` 防止切文档/换端口后旧协商结果写回。
   */
  const [negotiation, setNegotiation] = useState<{ encode: AnimationNegotiation; decode: AnimationNegotiation }>(
    { encode: { state: "pending" }, decode: { state: "pending" } }
  );
  useEffect(() => {
    const current = animationCodecPort();
    if (!current) { setNegotiation({ encode: { state: "unavailable", reason: NO_CODEC_PORT }, decode: { state: "unavailable", reason: NO_CODEC_PORT } }); return; }
    let live = true;
    void (async () => {
      const [encode, decode] = await Promise.all([
        negotiateAnimationContainer(current, "encode"),
        negotiateAnimationContainer(current, "decode")
      ]);
      if (!live) return;
      setNegotiation({ encode, decode });
    })();
    return () => { live = false; };
  }, [codec]);

  const encodeNegotiated = negotiation.encode;
  const codecReason = !codec
    ? NO_CODEC_PORT
    : encodeNegotiated.state === "pending"
      ? "正在协商宿主视频编码能力…"
      : encodeNegotiated.state === "unavailable"
        ? encodeNegotiated.reason
        : null;
  const decodeNegotiated = negotiation.decode;
  const videoImportReason = !codec
    ? NO_CODEC_PORT
    : decodeNegotiated.state === "pending"
      ? "正在协商宿主视频解码能力…"
      : decodeNegotiated.state === "unavailable"
        ? decodeNegotiated.reason
        : null;

  const createTimeline = () => run(animation.createTimeline({ duration: Math.max(1, Math.round(duration)), fps }));
  const applyProps = () => run(animation.setTimelineProps({
    fps,
    duration: Math.max(1, Math.round(duration)),
    // 工作区范围按「含首不含尾」解释，与内核 `work_end` 语义一致；缺省或非法值交回内核钳制
    // 前先在这里归一，避免把 NaN/逆序区间写进时间轴。
    workStart: Number.isFinite(workStart) ? Math.max(0, Math.round(workStart)) : 0,
    workEnd: Number.isFinite(workEnd) ? Math.max(0, Math.round(workEnd)) : 0
  }));
  const interpretFootage = () => run(animation.videoLayerCommand("layer.videoLayers.interpretFootage", { fps: footageFps }));
  /**
   * 把画布上的编辑写回当前帧。
   *
   * 内核在导航与保存时都会写回，这里提供显式入口：用户作画后不导航也能确认「这一帧已经进帧栈」，
   * 并拿到明确结果（`written:true` / `unchanged` / `draft-active` / `original-view-preview`）。
   */
  const flushFrames = () => {
    const result = animation.flushVideoFrames();
    fail(result);
    if (!result.ok) return;
    const flushed = isRecord(result.value) && isRecord(result.value.flushed) ? result.value.flushed : {};
    setNote(flushed.written === true
      ? "已把画布内容写回当前帧"
      : flushed.reason === "draft-active"
        ? "当前草稿未结算，未写回帧栈"
        : flushed.reason === "original-view-preview"
          // 预览模式的作画不会进帧栈；照内核给的原因说清楚，不报成「没有要写的东西」。
          ? (typeof flushed.message === "string" ? flushed.message : "「显示原始素材」模式下的编辑不会写回帧栈")
          : "当前帧没有需要写回的修改");
    refresh();
  };
  const goTo = (target: number) => {
    const result = animation.navigateTimeline("timeline.setFrame", { frame: target });
    fail(result);
    if (result.ok) { setFrame(target); refresh(); }
  };
  const step = (id: "timeline.nextFrame" | "timeline.previousFrame") => {
    const result = animation.navigateTimeline(id, {});
    fail(result);
    if (result.ok) refresh();
  };
  const togglePlay = () => {
    if (playback.isPlaying()) { playback.stop(); return; }
    const started = playback.play();
    if (!started.ok) setMessage(started.message);
  };

  const importFrames = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const document = controller.currentView().document;
    if (!document) return;
    // 导入前先按内核预算拒绝明显超限的选择，避免把上千张图全部解码进内存后才被内核拒绝。
    const maxFrames = info?.budget.maxFrames ?? 120;
    if (list.length > maxFrames) {
      setMessage(`选择的帧数超过上限：${list.length} > ${maxFrames} 帧`);
      return;
    }
    const budget = info?.budget;
    if (budget) {
      // 累计像素与解码字节是**同一份预算**：先按尺寸算总量，超了就一个像素都不解码。
      const pixels = document.width * document.height * list.length;
      if (pixels > budget.maxCumulativeFramePixels) {
        setMessage(`累计像素超过上限：${pixels} > ${budget.maxCumulativeFramePixels} 像素`);
        return;
      }
      const bytes = animationFrameBytes(document.width, document.height, list.length);
      if (bytes === null || bytes > budget.maxDecodeBytes) {
        setMessage(`解码字节超过上限：${bytes ?? "未知"} > ${budget.maxDecodeBytes} 字节`);
        return;
      }
    }
    const startedFor = documentKeyRef.current;
    setBusy(true);
    try {
      const decoded = await decodeFrameImages([...list], document.width, document.height);
      // 解码期间切换了文档：结果属于旧目标，丢弃而不是写进新文档（design D4）。
      if (documentKeyRef.current !== startedFor) { setMessage("文档已切换，已丢弃这次帧导入结果"); return; }
      if (!decoded.ok) { setMessage(decoded.message); return; }
      const pixels = new Uint8Array(decoded.width * decoded.height * 4 * decoded.frames.length);
      decoded.frames.forEach((frameBytes, index) => pixels.set(frameBytes, index * decoded.width * decoded.height * 4));
      const result = animation.importFrames({
        name: importName.trim() || "帧序列",
        width: decoded.width,
        height: decoded.height,
        fps: importFps,
        frameCount: decoded.frames.length,
        pixels
      });
      if (!result.ok) { setMessage(result.message); return; }
      const imported = result.value.imported;
      setNote(`已导入 ${imported.frames} 帧（${imported.width}×${imported.height}，${imported.fps} fps）`);
      setMessage(null);
      refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const refreshPlan = () => {
    const result = animation.deliveryPlan();
    if (!result.ok) { setMessage(result.message); setPlan(null); return; }
    setPlan(asPlan(result.value));
    setMessage(null);
  };

  /** 取消在飞的交付请求（codec 端口 cancel 必须幂等；帧序列在帧边界停止）。 */
  const cancelCodec = () => {
    const requestId = inFlight.current;
    if (!requestId) return;
    // 端口只对视频编解码有用；帧序列交付没有端口也要能取消。
    codec?.cancel(requestId);
    inFlight.current = null;
    setBusy(false);
    setMessage("已取消当前的动画交付请求，原文档未改变");
  };

  /** 视频导入：宿主端口解码 → 预算预检 → 内核按字节导入（不取首帧冒充）。 */
  const importVideo = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const document = controller.currentView().document;
    if (!document) return;
    const file = list[0]!;
    if (!codec) { setMessage(codecReason); return; }
    const budget = info?.budget;
    if (!budget) { setMessage("尚未读到内核预算，请稍后重试"); return; }
    const requestId = `animation-import-${Date.now()}`;
    const startedFor = documentKeyRef.current;
    inFlight.current = requestId;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = await decodeVideoFrames(codec, {
        fileName: file.name,
        mimeType: file.type,
        bytes,
        requestId
      }, {
        width: document.width,
        height: document.height,
        fps: importFps,
        budget: { maxFrames: budget.maxFrames, maxCumulativeFramePixels: budget.maxCumulativeFramePixels }
      });
      // 取消或切换文档后晚到的结果直接丢弃，不写入文档（design D4）。
      if (inFlight.current !== requestId) return;
      if (documentKeyRef.current !== startedFor) { setMessage("文档已切换，已丢弃这次视频导入结果"); return; }
      if (!decoded.ok) { setMessage(decoded.message); return; }
      const frameBytes = decoded.width * decoded.height * 4;
      const pixels = new Uint8Array(frameBytes * decoded.frames.length);
      decoded.frames.forEach((frame, index) => pixels.set(frame, index * frameBytes));
      const result = animation.importFrames({
        name: (importName.trim() || file.name.replace(/\.[^.]+$/, "")) || "视频帧",
        width: decoded.width,
        height: decoded.height,
        fps: decoded.fps,
        frameCount: decoded.frames.length,
        pixels
      });
      if (!result.ok) { setMessage(result.message); return; }
      const imported = result.value.imported;
      setNote(`已从视频导入 ${imported.frames} 帧（${imported.width}×${imported.height}，${imported.fps} fps）`);
      setMessage(null);
      refresh();
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "视频导入失败");
    } finally {
      if (inFlight.current === requestId) inFlight.current = null;
      setBusy(false);
    }
  };

  const exportGif = () => {
    setBusy(true);
    try {
      const result = animation.renderAnimationGif();
      if (!result.ok) { setMessage(result.message); return; }
      download(result.value, "photocraft-animation.gif", "image/gif");
      setNote(`已导出动画 GIF（${Math.round(result.value.length / 1024)} KiB）`);
      setMessage(null);
    } finally { setBusy(false); }
  };

  /** 帧序列交付：逐帧 PNG，无 codec 也能用；取消在帧边界生效。 */
  const exportFrames = async () => {
    const planResult = animation.deliveryPlan();
    if (!planResult.ok) { setMessage(planResult.message); return; }
    const delivery = asPlan(planResult.value);
    if (!delivery) { setMessage("交付计划无效，无法导出帧序列"); return; }
    const requestId = `animation-frames-${Date.now()}`;
    const startedFor = documentKeyRef.current;
    inFlight.current = requestId;
    setBusy(true);
    try {
      const result = await encodeFrameSequence({
        frames: delivery.frames,
        width: delivery.width,
        height: delivery.height,
        name: "photocraft-frame",
        // 取消或切换文档都停止继续渲染：切文档后 renderFrame 会去读另一份文档。
        cancelled: () => inFlight.current !== requestId || documentKeyRef.current !== startedFor,
        render: (index) => {
          const rendered = animation.renderFrame(index);
          return rendered.ok ? { ok: true, value: rendered.value } : { ok: false, message: rendered.message };
        }
      });
      if (inFlight.current !== requestId) return;
      if (!result.ok) {
        setMessage(result.message);
        if (result.delivered > 0) setNote(`已交付 ${result.delivered} 帧后失败，未下载半份序列`);
        return;
      }
      // 一次下载：浏览器对一次手势里的多个下载会拦截，序列打包成 store-only ZIP。
      const zip = zipStore(result.frames.map(frame => ({ name: frame.name, bytes: frame.bytes })));
      download(zip, "photocraft-frames.zip", "application/zip");
      setNote(`已交付 ${result.frames.length} 帧 PNG（${delivery.width}×${delivery.height}，ZIP ${Math.round(zip.length / 1024)} KiB）`);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "帧序列交付失败");
    } finally {
      if (inFlight.current === requestId) inFlight.current = null;
      setBusy(false);
    }
  };

  const exportVideo = async () => {
    if (!codec) { setMessage(codecReason); return; }
    const planResult = animation.deliveryPlan();
    if (!planResult.ok) { setMessage(planResult.message); return; }
    const delivery = asPlan(planResult.value);
    if (!delivery) { setMessage("交付计划无效，无法编码视频"); return; }
    // 用已经协商好的结果，不再临时问一次：真实探测是异步的，临时问会拿到 Promise。
    if (encodeNegotiated.state !== "ready") {
      setMessage(encodeNegotiated.state === "unavailable" ? encodeNegotiated.reason : "仍在协商宿主视频编码能力，请稍后重试");
      return;
    }
    const container = encodeNegotiated.container;
    setBusy(true);
    const requestId = `animation-export-${Date.now()}`;
    const startedFor = documentKeyRef.current;
    inFlight.current = requestId;
    try {
      const result = await codec.encode({
        requestId,
        width: delivery.width,
        height: delivery.height,
        fps: delivery.fpsMillis > 0 ? 1000 / delivery.fpsMillis : 30,
        frameCount: delivery.frames,
        container,
        frame: (index) => {
          // 切文档后不得继续从另一份文档取帧：混进别的文档的像素比失败更糟。
          if (documentKeyRef.current !== startedFor) throw new Error("文档已切换，已中止视频编码");
          const rendered = animation.renderFrame(index);
          if (!rendered.ok) throw new Error(rendered.message);
          return rendered.value;
        }
      });
      // 已取消：端口结果不得再下载或提示成功。
      if (inFlight.current !== requestId) return;
      if (!result.ok) { setMessage(result.reason); return; }
      download(result.bytes, `photocraft-animation.${result.container}`, `video/${result.container}`);
      setNote(`已导出 ${result.container.toUpperCase()}（${Math.round(result.bytes.length / 1024)} KiB）`);
      setMessage(null);
    } catch (error) {
      if (inFlight.current !== requestId) return;
      if (documentKeyRef.current !== startedFor) { setMessage("文档已切换，已中止视频编码"); return; }
      setMessage(error instanceof Error ? error.message : "视频编码失败");
    } finally {
      if (inFlight.current === requestId) inFlight.current = null;
      setBusy(false);
    }
  };

  if (typeof controller.features?.animation?.timelineInfo !== "function") return null;

  return (
    <section className="photo-editor__advanced-group" aria-label="时间轴与动画" data-animation-panel={revision}>
      <span className="photo-editor__options-title">时间轴</span>
      {timeline ? (
        <>
          <p className="photo-editor__brush-note" data-animation-summary="true">
            第 {timeline.current + 1} / {timeline.duration} 帧 · {timeline.fps} fps · {timeline.time.toFixed(2)} 秒
          </p>
          <div className="photo-editor__brush-fields">
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => step("timeline.previousFrame")}>上一帧</Button>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => step("timeline.nextFrame")}>下一帧</Button>
            <Button size="sm" disabled={readonly} onClick={togglePlay}>{playing ? "停止" : "播放"}</Button>
            <label>定位<input type="number" min={1} max={timeline.duration} value={frame + 1}
              disabled={readonly}
              onChange={(event) => setFrame(Math.max(0, Number(event.currentTarget.value) - 1))}
              onBlur={() => goTo(Math.min(Math.max(0, frame), timeline.duration - 1))} /></label>
          </div>
          <div className="photo-editor__brush-fields">
            <label>帧率<input type="number" min={1} max={info?.budget.maxFps ?? 1000} step={0.5} value={fps} disabled={readonly} onChange={(event) => setFps(Number(event.currentTarget.value))} /></label>
            <label>时长<input type="number" min={1} max={info?.budget.maxFrames ?? 120} value={duration} disabled={readonly} onChange={(event) => setDuration(Number(event.currentTarget.value))} />帧</label>
            <label>工作区起<input type="number" min={0} max={Math.max(0, (timeline.duration) - 1)} value={workStart} disabled={readonly} onChange={(event) => setWorkStart(Number(event.currentTarget.value))} /></label>
            <label>工作区止<input type="number" min={1} max={timeline.duration} value={workEnd} disabled={readonly} onChange={(event) => setWorkEnd(Number(event.currentTarget.value))} /></label>
            <Button size="sm" disabled={readonly} onClick={applyProps}>应用</Button>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run(animation.deleteTimeline())}>删除时间轴</Button>
          </div>
        </>
      ) : (
        <div className="photo-editor__brush-fields">
          <label>帧率<input type="number" min={1} max={info?.budget.maxFps ?? 1000} step={0.5} value={fps} disabled={readonly} onChange={(event) => setFps(Number(event.currentTarget.value))} /></label>
          <label>时长<input type="number" min={1} max={info?.budget.maxFrames ?? 120} value={duration} disabled={readonly} onChange={(event) => setDuration(Number(event.currentTarget.value))} />帧</label>
          <Button size="sm" disabled={readonly} onClick={createTimeline}>建立时间轴</Button>
        </div>
      )}

      <span className="photo-editor__options-title">帧编辑</span>
      <div className="photo-editor__brush-fields">
        {FRAME_ACTIONS.map((action) => {
          // 帧命令作用于**活动图层**：活动层不是视频层时先让用户选中，而不是让内核报错。
          const wrongTarget = action.needsVideoLayer === true && !videoTarget;
          const missingOriginal = action.needsOriginal === true && !videoTarget?.hasOriginal;
          const disabled = readonly || wrongTarget || missingOriginal;
          const title = wrongTarget
            ? "请先在图层列表选中一个视频图层"
            : missingOriginal
              ? "该视频层没有原始素材，无法恢复"
              : action.label;
          return (
            <Button key={action.id} size="sm" tone="ghost" disabled={disabled} title={title}
              onClick={() => run(animation.videoLayerCommand(action.id, {}))}>{action.label}</Button>
          );
        })}
      </div>
      {info?.videoLayers.length ? (
        <div className="photo-editor__brush-fields" data-animation-video-layers="true">
          {info.videoLayers.map((layer) => (
            <Button key={layer.layerId} size="sm" tone="ghost" disabled={readonly}
              data-animation-select-video-layer={layer.layerId}
              title={layer.layerId === videoTarget?.layerId ? "当前活动视频层" : "把该视频层设为活动图层"}
              onClick={() => run(controller.dispatch("layer.select", { layer: layer.layerId }))}>
              {layer.layerId === videoTarget?.layerId ? "● " : ""}{layer.name}（{layer.frames} 帧 / {layer.fps} fps）
            </Button>
          ))}
        </div>
      ) : null}
      {info?.videoLayers.length && !videoTarget ? (
        <p className="photo-editor__brush-note">当前活动图层不是视频层；帧编辑作用于活动图层，请先选中上面的视频层。</p>
      ) : null}
      {/* 跨文档粘贴只搬图层（含帧栈），时间轴是文档级数据：没有时间轴时帧栈不可导航。 */}
      {info?.videoLayers.length && !timeline ? (
        <p className="photo-editor__brush-note" data-animation-missing-timeline="true">
          已有视频层但没有时间轴：帧栈仍完整，建立时间轴后才能播放与定位到其它帧。
        </p>
      ) : null}
      {videoTarget ? (
        <div className="photo-editor__brush-fields">
          <label>解释素材帧率<input type="number" min={1} max={info?.budget.maxFps ?? 1000} step={0.5} value={footageFps} disabled={readonly}
            onChange={(event) => setFootageFps(Number(event.currentTarget.value))} /></label>
          <Button size="sm" tone="ghost" disabled={readonly} title="只改该视频层的帧率；时间轴帧率在上一组单独设置"
            onClick={interpretFootage}>解释素材</Button>
          <Button size="sm" tone="ghost" disabled={readonly} title="把画布上的编辑写回当前帧（保存前也可显式写回）"
            onClick={flushFrames}>写回当前帧</Button>
        </div>
      ) : null}

      <span className="photo-editor__options-title">帧导入</span>
      <div className="photo-editor__brush-fields">
        <label>名称<input value={importName} disabled={readonly} onChange={(event) => setImportName(event.currentTarget.value)} /></label>
        <label>帧率<input type="number" min={1} max={info?.budget.maxFps ?? 1000} step={0.5} value={importFps} disabled={readonly} onChange={(event) => setImportFps(Number(event.currentTarget.value))} /></label>
        <label className="photo-editor__file-action">选择图片帧
          <input ref={files} type="file" accept={FRAME_IMAGE_ACCEPT} multiple hidden disabled={readonly}
            onChange={(event) => { const list = event.currentTarget.files; event.currentTarget.value = ""; void importFrames(list); }} />
          <Button size="sm" disabled={readonly || busy} onClick={() => files.current?.click()}>导入帧…</Button>
        </label>
        <label className="photo-editor__file-action">导入视频
          <input ref={videos} type="file" accept="video/mp4,video/webm,.mp4,.m4v,.webm" hidden
            disabled={readonly || decodeNegotiated.state !== "ready"}
            onChange={(event) => { const list = event.currentTarget.files; event.currentTarget.value = ""; void importVideo(list); }} />
          <Button size="sm" tone="ghost" disabled={readonly || busy || decodeNegotiated.state !== "ready"}
            title={videoImportReason ?? "由宿主 codec 端口解码整段视频"} onClick={() => videos.current?.click()}>导入视频…</Button>
        </label>
        {busy && inFlight.current ? <Button size="sm" tone="ghost" onClick={cancelCodec}>取消</Button> : null}
      </div>
      <p className="photo-editor__brush-note">按画布尺寸等比缩放并居中；顺序即选择顺序，最多 {info?.budget.maxFrames ?? 120} 帧。</p>
      {videoImportReason ? <p className="photo-editor__brush-note" data-animation-video-import="true">
        视频导入由宿主 codec 端口整段解码，不取首帧；{videoImportReason}
      </p> : <p className="photo-editor__brush-note" data-animation-video-import="true">
        视频导入由宿主 codec 端口整段解码（MP4/WebM），不取首帧。
      </p>}

      <span className="photo-editor__options-title">交付</span>
      <div className="photo-editor__brush-fields">
        <Button size="sm" tone="ghost" disabled={!timeline || busy} onClick={refreshPlan}>交付计划</Button>
        <Button size="sm" tone="ghost" disabled={!timeline || busy} onClick={() => void exportFrames()}>导出帧序列</Button>
        <Button size="sm" disabled={!timeline || busy} onClick={exportGif}>导出动画 GIF</Button>
        <Button size="sm" disabled={!timeline || busy || encodeNegotiated.state !== "ready"} title={codecReason ?? "导出视频"} onClick={() => void exportVideo()}>导出视频</Button>
      </div>
      {plan ? (
        <p className="photo-editor__brush-note">
          {plan.frames} 帧 · {plan.width}×{plan.height} · {(1000 / Math.max(1, plan.fpsMillis)).toFixed(2)} fps · 约 {Math.round(plan.totalBytes / 1024)} KiB
        </p>
      ) : null}
      {codecReason ? <p className="photo-editor__brush-note">{codecReason}</p> : null}
      {note ? <p className="photo-editor__brush-note">{note}</p> : null}
      {playing ? <p className="photo-editor__brush-note">播放中…（定位与播放不新增历史步骤）</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}
