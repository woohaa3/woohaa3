/**
 * 宿主默认图片聚焦查看器 Plugin
 * （change: default-image-focus-viewer）。
 *
 * 背景：图片聚焦的**工作区**原先完全由图片编辑器扩展（PhotoCraft）贡献。扩展未安装/未启用时，
 * 双击图片既没有默认工作区，导航 preflight 也会因为目标集合为空而拒绝进入——用户看到的是
 * 「聚焦目标不可用」。本插件补上宿主默认实现：
 *
 * - 目标校验的 canonical 兜底在 Canvas Runtime adapter（`imageFocusTargetValid`：注册集合优先，
 *   缺席时回落 canonical 判定）；本插件负责**呈现**：没有其他 kind=image 工作区贡献时注册
 *   `canvas.focus-workspace`，已安装的编辑器扩展一旦出现就让位（避免「多个扩展声明了此节点的工作区」）。
 * - 只做原地查看（取景/缩放/平移），真实画面仍由 Bevy 主画布按现有图片聚焦投影显示；
 *   不加载编辑内核、不创建作品版本、不写 nodeData/Y.Doc。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { definePlugin } from "../../plugin.js";
import { resolveImageFocusTarget } from "../../focus/image-focus-target.js";
import type { FocusContentRect } from "../../focus/types.js";
import { IMAGE_VIEW_SERVICE } from "../service-keys.js";
import { ImageViewerSession } from "./session.js";
import { ImageViewerWorkspace } from "./image-viewer-workspace.js";

export const IMAGE_VIEWER_PLUGIN_ID = "image-viewer";
const IMAGE_VIEWER_WORKSPACE_ID = "image-viewer-workspace";

export function imageViewerExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const getCanvas = () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
      let session: ImageViewerSession | null = null;
      let detachViewport: (() => void) | null = null;
      let removeWorkspace: (() => void) | null = null;

      /** 可用内容矩形：与 Bevy 取景和底部控件共用同一表面。 */
      const contentRect = (): FocusContentRect => {
        const surface = ctx.canvasRuntime.controller()?.surface() ?? { width: 1, height: 1, pixelRatio: 1 };
        return ctx.canvasRuntime.focusContentRect?.() ?? { x: 0, y: 0, width: surface.width, height: surface.height };
      };

      const exit = (): void => {
        detachViewport?.();
        detachViewport = null;
        session?.dispose();
        session = null;
      };

      const enter = (nodeId: string): void => {
        const resolved = resolveImageFocusTarget(getCanvas(), nodeId);
        if (!resolved) return;
        exit();
        const controller = ctx.canvasRuntime.controller();
        const current = new ImageViewerSession({
          nodeId,
          target: resolved,
          getCanvas,
          rect: contentRect,
          savedViewport: controller?.viewport() ?? { x: 0, y: 0, zoom: 1 },
          transition: ctx.canvasRuntime.focusTransitionPort(),
          runtime: {
            setProjection: (projection) => ctx.canvasRuntime.setImageFocus(projection),
            setTexture: (texture) => ctx.canvasRuntime.setImageFocusTexture(texture),
            setPending: (pending) => ctx.canvasRuntime.setImageFocusPending(pending)
          }
        });
        session = current;
        detachViewport = ctx.canvasRuntime.registerImageViewportTarget(current.viewportTarget());
        void current.start();
      };

      /**
       * 是否存在**编辑器**的 kind=image 工作区（PhotoCraft 一类）。
       *
       * 本插件自己占用 `image-view`，不参与这个判断，因此无需排除自身 id。
       */
      const hasImageEditorWorkspace = (): boolean =>
        ctx.slots.list("canvas.focus-workspace").some((entry) => entry.kind === "image");

      // 节点操作横条的「去P图」入口：进入 **kind=image** 的工作区（编辑器扩展在位时即 PhotoCraft）。
      //
      // 与双击路径分开：双击 → `image-view`（只读查看），本按钮 → `image`（编辑器）。
      //
      // 只在编辑器确实贡献了 kind=image 工作区时出现：编辑器未安装/停用时点它没有任何呈现，
      // 宁可不显示（查看仍可双击）。
      //
      // 进入聚焦是导航而不是写入，因此不看 `writable`（与双击、`model-focus-view` 一致）；
      // 真正的写入门禁由编辑器在「应用到节点」时自己判。
      const removeEditAction = ctx.slots.register("canvas.node-action", {
        id: "image-edit-focus",
        owner: IMAGE_VIEWER_PLUGIN_ID,
        order: 21,
        describe: ({ nodeId }) => {
          if (!hasImageEditorWorkspace()) return null;
          if (!resolveImageFocusTarget(getCanvas(), nodeId)) return null;
          return { label: "去P图", icon: "photoshop", enabled: true };
        },
        activate: ({ nodeId }) => {
          if (!hasImageEditorWorkspace()) return;
          void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId, kind: "image", owner: "direct" });
        }
      });

      const registerWorkspace = (): void => {
        if (removeWorkspace) return;
        removeWorkspace = ctx.slots.register("canvas.focus-workspace", {
          id: IMAGE_VIEWER_WORKSPACE_ID,
          owner: IMAGE_VIEWER_PLUGIN_ID,
          // 只读查看器占用独立的 `image-view` kind，**不与编辑器争同一个 kind**：
          // 双击 → image-view（本工作区），横条「去P图」→ image（PhotoCraft）。
          // 两者共用同一套二维媒体取景与历史语义（见 `isImageFocusKind`）。
          kind: "image-view",
          exclusive: true,
          // 不在这里声明静态 `layout`：公共宿主的 `useFocusLayoutSource` 会在工作区
          // 的 `useFocusLayout` 之后提交，静态配置会把工作区上报的 player/panel 覆盖掉
          // （症状：底部控制条高度变 0、内容溢出到屏幕底边）。video/model editor 同样只经
          // `useFocusLayout` 上报（change: default-image-focus-viewer）。
          render: ({ focus }) => (
            <ImageViewerWorkspace getSession={() => session} nodeId={focus?.nodeId ?? ""} />
          )
        });
      };

      /**
       * 聚焦 mode → 会话：只有 kind=image-view 时建立会话。
       *
       * 编辑器在位时本工作区不再让位（kind 已分开），所以这里只看 mode，不看谁占了 image。
       */
      const reconcileFocus = (): void => {
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        if (mode.type !== "node-focus" || mode.kind !== "image-view") { exit(); return; }
        if (session?.nodeId !== mode.nodeId) enter(mode.nodeId);
      };
      const unsubscribeNav = ctx.canvasNavigation.subscribe(reconcileFocus);

      // 内容矩形变化（历史 drawer / 窗口尺寸）→ 重新适应窗口。
      const unsubscribeRect = ctx.canvasRuntime.subscribeFocusContentRect(() => session?.setRect());

      // 远端回流：canonical 输出变化时重开来源（同地址不动）。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => session?.refreshFromCanonical());

      registerWorkspace();
      // 插件可能在聚焦之后才装配（扩展热加载）：先对齐当前 mode 再订阅变化。
      reconcileFocus();

      // 只读查看 capability：编辑器扩展缺席时，历史面板用它换到旧版本预览
      // （与 `imageEdit` 同形，只实现只读子集；编辑器装入后 history 始终优先 imageEdit）。
      ctx.provide(IMAGE_VIEW_SERVICE as never, {
        isActive: () => session !== null,
        nodeId: () => session?.nodeId ?? null,
        setHistoryOverride: (override: { url: string } | null, nodeId?: string) => {
          if (session && (!nodeId || nodeId === session.nodeId)) session.setHistoryOverride(override);
        },
        refreshFromCanonical: () => session?.refreshFromCanonical(),
        draftState: () => "saved" as const
      } as never);

      // 退出协调 participant：查看没有净变化，只在导航 dispatch 前做取景缩回。
      const disposeParticipant = ctx.focusExit.register({
        id: IMAGE_VIEWER_PLUGIN_ID,
        hasUnsavedChanges: () => false,
        prepare: async () => ({ ok: true }),
        afterPrepare: async () => { await session?.animateExit(); }
      });

      // E2E/排障镜像（生产无副作用）。
      (globalThis as unknown as { __imageViewerDebug?: unknown }).__imageViewerDebug = () => ({
        active: session !== null,
        nodeId: session?.nodeId ?? null,
        state: session?.state() ?? null
      });

      ctx.effect(() => () => {
        unsubscribeNav();
        unsubscribeRect();
        unsubscribeCanvas();
        removeEditAction();
        disposeParticipant();
        removeWorkspace?.();
        removeWorkspace = null;
        exit();
      }, "image-viewer-lifecycle");
    },
    { name: IMAGE_VIEWER_PLUGIN_ID, inject: ["slots", "canvasRuntime", "canvasNavigation", "focusExit"] }
  );
}
