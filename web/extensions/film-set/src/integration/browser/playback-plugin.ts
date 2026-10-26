/**
 * 动画节点播放 Plugin
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1；
 *   2026-10-06 改为 hover 触发；
 *   2026-10-15 改为**拍摄镜头预览卡片内容区**触发）。
 *
 * 宿主从最近接受的命中发布 typed 拍摄播放目标（`{ kind:"shot-preview", previewNodeId,
 * filmSetNodeId, clipId }`，见 `interaction-hover.ts`）。本 Plugin 只消费该目标：
 *
 * - 校验目标仍是**动态**拍摄镜头（clip.kind === "dynamic"），并确认预览节点仍存在且归属一致；
 * - 短单调延迟（`HOVER_PLAYBACK_DELAY_MS`，见 `hover-delay.ts`）后从 T=0 **强制循环**播放该明确
 *   clipId（不写 defaultClipId、不改保存 timeline.loop、不写 canonical）；
 * - 目标消失/内容变化/转静态/离开内容区/手势/modal/capture owner/页面隐藏/renderer 更换立即
 *   取消等待与播放并复位基础姿态（迟到回调按 key 与身份丢弃）。
 *
 * 片场地面、总览对象网格、标题/抓手/线/相机标记都不建立候选（design D6：移除地面/default
 * 开播路径）。普通 model3d 动画 hover 不经过本 Plugin（由 Rust 侧 `scene.hover` 驱动）。
 *
 * 与 `model-scene` 分工：后者执行 `modelScript` 得到模型几何资源；本 Plugin 只负责「哪个拍摄
 * 镜头在播放、到第几秒」。求值由 Bevy 按 IR 完成。
 */
import type { FilmSetContext as Context } from "./context.js";
import type { Plugin } from "@deepseek-ai/cordis";
import { decodeFilmSetNodeData, filmSetAnimationsOf, resolveFilmSetClip, isFilmSetNode, shotPreviewOwnershipOf, type FilmSetNodeData } from "@woohaa3/contracts";
import { AnimationPlaybackController } from "../../preview/shared/playback-controller.js";
import { defineExtensionPlugin as definePlugin } from "@woohaa3/frontend/extension-api";
import { HoverPlaybackDelay } from "../../preview/browser/hover-delay.js";

export const ANIMATION_PLAYBACK_PLUGIN_ID = "animation-playback";

export type AnimationPlaybackExtensionOptions = {
  /** 注入控制器（测试用）；缺省创建生产控制器。 */
  controller?: AnimationPlaybackController;
};

export function animationPlaybackExtension(options: AnimationPlaybackExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin<Context>(
    (ctx: Context) => {
      const controller = options.controller ?? new AnimationPlaybackController({
        readAnimation: (nodeId) => readAnimation(ctx.compositeAssets.projectCanvas(ctx.canvasState.getCanvas()), nodeId),
        publish: (playback) => {
          ctx.canvasRuntime.setAnimationPlayback(playback);
          ctx.filmSetPlayback.update({ sourceIdentity: playback?.sourceIdentity ?? null,
            generation: playback?.generation ?? 0, mode: playback?.viewMode ?? "edit" });
        },
        onTime: (input) => {
          ctx.canvasRuntime.notifyAnimationTime?.(input);
          if (ctx.filmSetPlayback.getSnapshot().preview) ctx.filmSetPlayback.update({ time: input.time, playing: input.playing });
        }
      });

      let previewActive = false;
      let visible = !document.hidden;
      let disposed = false;
      let canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getCanvas());
      /**
       * 预览节点 id → 该卡片当前**视觉内容身份**（源片场 + clip + 源内容）。
       *
       * 由权威画布派生：只有归属合法、源片场仍存在且仍能解析该 clipId 的动态拍摄镜头才进入。
       * 改名/纯画布位置变化不改变键；内容变化使键改变，从而撤销旧会话并重新等满延迟
       * （design D6）。
       */
      const candidates = new Map<string, string>();
      const refreshCandidates = () => {
        canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getCanvas());
        candidates.clear();
        if (!canvas) return;
        for (const node of canvas.document.nodes) {
          const ownership = shotPreviewOwnershipOf(canvas.nodeData[node.id]);
          if (!ownership) continue;
          const source = canvas.document.nodes.find((candidate) => candidate.id === ownership.filmSetNodeId);
          if (!source || !isFilmSetNode(source.type, canvas.nodeData[source.id])) continue;
          const decoded = decodeFilmSetNodeData(canvas.nodeData[source.id]);
          if (!decoded.ok) continue;
          const clip = filmSetAnimationsOf(decoded.value).clips.find((entry) => entry.id === ownership.clipId);
          // 静态镜头不建立任何播放状态机（design D6）。
          if (!clip || clip.kind !== "dynamic") continue;
          const key = animationSnapshotKey(decoded.value, ownership.clipId);
          if (key) candidates.set(node.id, key);
        }
      };
      refreshCandidates();
      const delay = new HoverPlaybackDelay(() => reconcile());
      let reconciling = false;
      const reconcile = (): void => {
        // 播放状态会同步 invalidate registry；发布中不能重入尚未完成的控制器切换。
        if (reconciling || disposed) return;
        reconciling = true;
        try {
          if (ctx.filmSetPlayback.isStillCapture()) { controller.select(null); return; }
          // 镜头参考录制会话优先于 hover/聚焦：把投影锁到该镜头的预览卡片（输出目标卡片、
          // 暂停在录制方 seek 的 T），renderer 才能在片场非聚焦时按 T 离屏出该镜头画面。
          const captureSession = ctx.filmSetPlayback.captureSessionRequest();
          if (captureSession) {
            const identity = candidates.get(captureSession.previewNodeId);
            if (!identity) {
              controller.select(null);
              return;
            }
            controller.select(captureSession.filmSetNodeId, identity, {
              clipId: captureSession.clipId,
              viewMode: "shot-node-preview",
              targetPreviewNodeId: captureSession.previewNodeId,
              paused: true
            });
            return;
          }

          // 聚焦（edit/history）覆盖 hover：聚焦期间不播放，并复位当前姿态。
          const mode = ctx.canvasNavigation.getSnapshot().mode;
          // 导航是聚焦 owner；动作失败时渲染器可暂时没有 projection，不能因此清掉显式预览。
          const focused = mode.type === "node-focus" || ctx.canvasRuntime.isFocused();
          const focusId = mode.type === "node-focus" && mode.kind === "model"
            ? mode.nodeId : ctx.canvasRuntime.modelFocusProjection()?.nodeId;
          const explicit = ctx.filmSetPlayback.getSnapshot();
          const enteringPreview = focused && explicit.preview && explicit.nodeId === focusId;
          if (enteringPreview && !previewActive) ctx.canvasRuntime.controller()?.cancelTransientGesture();
          previewActive = enteringPreview;
          if (focused) delay.cancel();
          if (focused && explicit.preview && explicit.nodeId === focusId) {
            const animation = readAnimation(canvas, focusId!);
            const resolved = animation ? resolveFilmSetClip(animation, explicit.clipId) : null;
            if (!resolved || resolved.clip.kind !== "dynamic") {
              controller.select(null);
              ctx.filmSetPlayback.update({ preview: false, playing: false, error: resolved ? null : "动画片段不存在，请选择其他片段" });
              return;
            }
            controller.select(focusId!, undefined, { clipId: explicit.clipId ?? undefined, paused: true, viewMode: "focus-preview" });
            ctx.filmSetPlayback.update({ duration: resolved.timeline.duration, diagnostics: controller.diagnostics(), error: controller.diagnostics().length ? `${controller.activeNodeId() ? "部分动作未播放：" : "片段无法播放："}${controller.diagnostics().join("；")}` : controller.activeNodeId() ? null : "片段动作无法播放，请检查动作脚本" });
            return;
          }
          if (!focused && explicit.preview) ctx.filmSetPlayback.update({ preview: false, playing: false });
          // 只从宿主发布的 typed 拍摄目标建立 hover 候选：片场地面/对象网格/标题/抓手/线/相机
          // 标记都不再开播（change: 2026-10-15，design D6：移除地面/default 开播路径）。
          const eligibility = ctx.hoverState.getPlaybackSnapshot();
          const runtime = ctx.canvasRuntime.runtime();
          const target = focused || !visible || eligibility.blocked || runtime?.acceptsPlayback?.() === false
            ? null : eligibility.target;
          const snapshotHash = target ? candidates.get(target.previewNodeId) : undefined;
          // key 含源片场/clip/预览节点、实际视觉内容身份、epoch 与 renderer generation：
          // 重命名与纯画布位置变化不重启，内容变化/目标切换/owner 释放重新等满延迟。
          const candidateKey = target && snapshotHash
            ? JSON.stringify([target.filmSetNodeId, target.clipId, target.previewNodeId, snapshotHash, eligibility.epoch, runtime?.generation() ?? 0]) : null;
          const ready = delay.sync(candidateKey);
          if (!ready) {
            controller.select(null);
            return;
          }
          // 复用短延迟到期后**重读**最新目标与内容身份：迟到回调不能复活旧会话。
          const current = ctx.hoverState.getPlaybackSnapshot();
          const latest = current.target && !current.blocked && candidates.has(current.target.previewNodeId)
            ? current.target : null;
          if (!latest || !target || latest.previewNodeId !== target.previewNodeId || !candidates.has(latest.previewNodeId)) {
            controller.select(null);
            return;
          }
          // 明确 owner + clip：`shot-node-preview` 模式，输入为所属片场 nodeId + clipId，输出为
          // 该卡片；hover 强制循环但**不**写 defaultClipId 或保存的 timeline.loop（design D6）。
          controller.select(latest.filmSetNodeId, candidates.get(latest.previewNodeId), {
            clipId: latest.clipId,
            viewMode: "shot-node-preview",
            targetPreviewNodeId: latest.previewNodeId,
            forceLoop: true
          });
        } finally { reconciling = false; }
      };

      const disconnectPlayback = ctx.filmSetPlayback.connect(controller, reconcile);
      // 双击拍摄镜头预览卡片 → 进入所属片场并选择对应镜头、显式预览零点暂停
      // （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.4 / design D8）。
      //
      // 宿主在进入片场聚焦成功后发布事件；本扩展按请求中的**显式 clipId** 选择镜头（不猜默认
      // 镜头），随即进入预览并停在 T=0。`reconcile` 据此建立 focus-preview 会话（paused）。
      // 归属与聚焦门禁由宿主输入层/reconcile 校验，这里不重复读取业务数据。
      const offShotPreviewEnter = ctx.on("ui.shot-preview.enter-requested", (request) => {
        ctx.filmSetPlayback.select(request.filmSetNodeId, request.clipId);
        ctx.filmSetPlayback.preview();
      });
      const onVisibility = () => {
        visible = !document.hidden;
        delay.cancel();
        if (!visible && previewActive) controller.pause();
        reconcile();
      };
      document.addEventListener("visibilitychange", onVisibility);
      const unsubscribeHistory = ctx.compositeAssets.subscribe(() => { refreshCandidates(); reconcile(); });
      const unsubscribeCanvas = ctx.canvasState.subscribe(() => { refreshCandidates(); reconcile(); });
      const unsubscribeHover = ctx.hoverState.subscribe(reconcile);
      const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(reconcile);
      const unsubscribeRuntime = ctx.canvasRuntime.subscribe(reconcile);
      const unsubscribeNavigation = ctx.canvasNavigation.subscribe(reconcile);
      reconcile();

      // 对象编辑暂停钩子（change: 2026-10-09 片场对象编辑）：把当前播放头 paused 在当前 T。
      ctx.canvasRuntime.setAnimationPauseSink?.(() => controller.pause());
      ctx.effect(() => () => ctx.canvasRuntime.setAnimationPauseSink?.(null), "animation-pause-sink");

      // E2E/排障镜像（生产无副作用）。仅观察 hover 会话；不再暴露选中驱动入口。
      (globalThis as unknown as { __animationPlayback?: unknown }).__animationPlayback = {
        nodeId: () => controller.activeNodeId(),
        playing: () => controller.isPlaying(),
        compilations: () => controller.compilationCount(),
        time: () => controller.time(),
        hovered: () => ctx.hoverState.getNodeId(),
        play: () => controller.play(),
        pause: () => controller.pause(),
        stop: () => controller.stop(),
        seek: (time: number) => controller.seek(time)
      };

      return () => {
        disposed = true;
        delay.dispose();
        document.removeEventListener("visibilitychange", onVisibility);
        disconnectPlayback();
        offShotPreviewEnter();
        unsubscribeHistory();
        unsubscribeCanvas();
        unsubscribeHover();
        unsubscribeFocus();
        unsubscribeNavigation();
        unsubscribeRuntime();
        controller.dispose();
        ctx.canvasRuntime.setAnimationPlayback(null);
      };
    },
    { name: ANIMATION_PLAYBACK_PLUGIN_ID, inject: ["canvasRuntime", "canvasState", "compositeAssets", "hoverState", "filmSetPlayback", "canvasNavigation"] }
  );
}

/** 从权威画布读取某节点的完整动画定义；不存在/非法返回 null。 */
export function readAnimation(
  canvas: { document: { nodes: readonly { id: string; type: string }[] }; nodeData: Record<string, unknown> } | null,
  nodeId: string
): FilmSetNodeData | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node || !isFilmSetNode(node.type, canvas.nodeData[nodeId])) return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[nodeId]);
  return decoded.ok ? decoded.value : null;
}

/**
 * 压缩的内容身份键：场景 + items + **该预览卡片所属镜头**（时间线/binding）变化都使会话重建。
 *
 * 卡片只观察自己那个 clip，不看 defaultClipId：改名（`name: ""`）与纯画布位置变化不改变键，
 * 从而不重置 hover 截止点（design D6）。
 */
function animationSnapshotKey(animation: FilmSetNodeData, clipId: string): string {
  const collection = filmSetAnimationsOf(animation);
  const clip = collection.clips.find(entry => entry.id === clipId);
  return JSON.stringify({
    scene: animation.scenePlacement,
    content: animation.filmSetContent,
    clip: clip ? { ...clip, name: "" } : undefined
  });
}
