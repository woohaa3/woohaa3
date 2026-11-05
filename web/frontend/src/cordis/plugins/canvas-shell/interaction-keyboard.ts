/**
 * 画布键盘与剪贴板快捷键
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-2d-input 拆出）。
 *
 * Space 平移门禁、聚焦飞行键、2D copy/delete/Escape；paste 不在此处理（交给 Input Scope Host）。
 *
 * Mod+C 的落点有两层（change: fix-desktop-native-menu-clipboard-shortcuts）：
 * - 浏览器/Safari 没有登记该组合的系统菜单，`keydown` 正常到达，走 `onKeyDown` → `runClipboardShortcut`；
 * - Tauri/macOS 窗口默认带 App 菜单，`Cmd+C` 先被原生 Edit > Copy 的快捷键吃掉，页面只收到
 *   DOM `copy` 事件。因此复制必须同时挂 `copy` 监听：只依赖 `keydown` 会让桌面端完全复制不出节点。
 */
import { isEditableElement, isMacPlatform, resolveCanvasShortcut } from "./input/shortcuts.js";
import { buildCanvasCopyPayload, serializeCanvasCopyPayload } from "./clipboard/payload.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { planDeleteNodes } from "../../../extension-api/command-planner.js";
import type { InteractionCore } from "./interaction-core.js";
import { managedNodeRelationOf, partitionManagedNodeDeletion } from "@woohaa3/contracts";

/** 页内剪贴板 fallback 的全局键。 */
export const MEMORY_CLIPBOARD_KEY = "__canvasMemoryClipboard";
export const DUPLICATE_CANVAS_EVENT = "woohaa3-canvas-duplicate";

/** 有真实文本选区时，Mod+C 应由浏览器复制选中文本，而不是复制画布节点。 */
function hasSelectedText(target: { getSelection?: () => Selection | null }): boolean {
  const selection = target.getSelection?.();
  return selection != null && selection.toString().trim().length > 0;
}

export function createKeyboardShortcuts(core: InteractionCore) {
  const { options, target, writable, state, model, schedule } = core;

  /** Live media is frozen by the existing provider before publishing a copy. */
  const copyableSelection = () => {
    const canvasState = woohaa3CanvasStore.getState().canvas;
    if (!canvasState) return null;
    const snapshot = nodeSelectionStore.getSnapshot();
    if (!snapshot.nodeIds.length) return null;
    return { canvasState, others: snapshot.nodeIds };

  };

  /**
   * 序列化当前选择为剪贴板文本，并写入页内 fallback。
   *
   * 剪贴板只有一个 writer 入口：`keydown` 路径（浏览器）与 DOM `copy` 事件（桌面原生菜单）
   * 都调用这里，避免两套载荷构造逻辑漂移。
   */
  const buildClipboardText = (): string | null => {
    const copyable = copyableSelection();
    if (!copyable) return null;
    // Payload includes the generic owner closure; standalone media is frozen below.
    const payload = buildCanvasCopyPayload(copyable.canvasState, copyable.others, );
    if (!payload) return null;
    const text = serializeCanvasCopyPayload(payload);
    (target as unknown as Record<string, unknown>)[MEMORY_CLIPBOARD_KEY] = text;
    return text;
  };

  const freezeClipboardText = async (): Promise<string | null> => {
    const copyable = copyableSelection();
    if (!copyable) return null;
    const payload = buildCanvasCopyPayload(copyable.canvasState, copyable.others, );
    if (!payload) return null;
    const included = new Set(payload.nodes.map(n => n.id));
    const liveIds = payload.nodes.filter(n => {
      const data = copyable.canvasState.nodeData[n.id];
      const relation = managedNodeRelationOf(data);
      return data?.mediaContent && !(relation && included.has(relation.ownerNodeId));
    }).map(n => n.id);
    if (!liveIds.length) return buildClipboardText();
    if (!options.mediaContent) throw Error("媒体内容 provider 未就绪，无法复制");
    const frozen = await options.mediaContent.freeze(copyable.canvasState, liveIds, crypto.randomUUID());
    const frozenPayload = buildCanvasCopyPayload(frozen, copyable.others, );
    if (!frozenPayload) return null;
    const text = serializeCanvasCopyPayload(frozenPayload);
    (target as unknown as Record<string, unknown>)[MEMORY_CLIPBOARD_KEY] = text;
    return text;
  };

  const runClipboardShortcut = async (action: "copy" | "duplicate" | "delete") => {
    if (core.modalActive()) return;
    const canvasState = woohaa3CanvasStore.getState().canvas;
    const session = options.getSession();
    if (!canvasState || !session) return;
    const snapshot = nodeSelectionStore.getSnapshot();
    const clip = target as unknown as {
      navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
    };
    if (action === "copy" || action === "duplicate") {
      if (action === "duplicate" && !writable()) return;
      let text: string | null;
      try { text = await freezeClipboardText(); } catch (error) { options.onInteractionError?.(error); return; }
      if (text === null) return;
      if (action === "duplicate") {
        if (!writable() || core.modalActive() || nodeSelectionStore.getSnapshot().editingFocus || isEditableElement(target.document.activeElement) || woohaa3CanvasStore.getState().canvas?.id !== canvasState.id) return;
        target.dispatchEvent(new CustomEvent(DUPLICATE_CANVAS_EVENT, { detail: text }));
        return;
      }
      try {
        await clip.navigator?.clipboard?.writeText?.(text);
      } catch {
        // 保留页内 fallback。
      }
      return;
    }
    if (state.selectedEdgeId && writable()) {
      core.submit([{ type: "edge.remove", edgeId: state.selectedEdgeId }]);
      state.selectedEdgeId = null;
      core.clearHover();
      schedule();
      return;
    }
    const deletion = partitionManagedNodeDeletion(canvasState.document.nodes, canvasState.nodeData, snapshot.nodeIds);
    const deletable = deletion.allowed;
    if (deletable.length === 0) {
      if (deletion.blocked.length > 0) notifyManagedRejected("托管节点需通过所属作品管理");
      return;
    }
    if (!writable()) return;
    // 删除经页面编辑历史（可撤销）；回退直接提交（任务 1.5/1.7）。
    const label = deletable.length > 1 ? `删除 ${deletable.length} 个作品` : "删除作品";
    if (deletion.blocked.length > 0) notifyManagedRejected("已删除其余作品；托管节点需通过所属作品管理");
    if (options.onEditCommands) {
      void options.onEditCommands(planDeleteNodes(deletable), label);
      return;
    }
    session.submitCommands(planDeleteNodes(deletable), `web-delete-${Date.now().toString(36)}-${core.nextSeq()}`);
  };

  /** Relation-policy diagnostics share the normal interaction error outlet. */
  const notifyManagedRejected = (message: string): void => {
    options.onInteractionError?.(new Error(message));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || core.modalActive()) return;
    // 画布快捷键在 modal/panel 打开时不参与；但聚焦相机的飞行/退出只被真正 modal 阻断
    // （change: fix-model-focus-navigation-and-camera-parity，design D6）。
    const imageFocused = options.isImageFocused?.() ?? !!options.getImageFocus?.();
    const imagePending = imageFocused && (options.isImageFocusPending?.() ?? false);
    const videoFocused = options.isVideoFocused?.() ?? !!options.getVideoFocus?.();
    // Space 临时平移只在**普通画布**握着输入时武装：编辑面（prompt / 输入框 / 菜单）、图片、
    // 视频与模型聚焦里的 Space 是输入字符或播放暂停，武装平移会让之后的左键点击全部变成
    // 平移、无法再点选节点（change: fix-space-pan-latch-after-focus-exit）。
    // 例外：图片聚焦已进入但编辑器还没接管画面（加载中）没有输入面，画布仍要能平移。
    if (event.code === "Space") {
      state.spacePressed = !isEditableElement(event.target) && !model.active && (!imageFocused || imagePending) && !videoFocused;
    }
    if (core.modalActive() && (!(model.active || imageFocused || videoFocused) || core.focusInputBlocked())) return;
    if (imageFocused) {
      if (event.key === "Escape" && !isEditableElement(event.target) && !core.focusInputBlocked()) {
        event.preventDefault();
        core.options.onModelFocusIntent?.({ type: "exit" });
      }
      return;
    }
    // 视频聚焦：Escape 退出（经统一退出协调）；Space 播放/暂停由聚焦 overlay 消费。
    if (videoFocused) {
      if (event.key === "Escape" && !isEditableElement(event.target) && !core.focusInputBlocked()) {
        event.preventDefault();
        options.onModelFocusIntent?.({ type: "exit" });
      }
      return;
    }
    // 聚焦查看：W/A/S/D/Q/E 飞行、Escape 退出；DOM 编辑面优先（design D4/D5）。
    if (model.active && !isEditableElement(event.target)) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (core.options.onModelFocusIntent) core.options.onModelFocusIntent({ type: "exit" });
        else model.exitModelFocus();
        return;
      }
      model.applyFlyKey(event, true);
      if (model.flyKeyName(event.code)) event.preventDefault();
      return;
    }
    // 拖动粘连 Q/E（change: add-drag-touch-connections，design D2）：只在带 attach 子状态的
    // 拖动中消费，按物理 code 路由。模型聚焦分支已在上方独占（更高优先级）。
    if ((event.code === "KeyQ" || event.code === "KeyE") && core.attachActive() && !isEditableElement(event.target)) {
      if (core.onAttachKey(event.code, true)) {
        event.preventDefault();
        return;
      }
    }
    const selection = nodeSelectionStore.getSnapshot();
    const action = resolveCanvasShortcut(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        editableTarget: isEditableElement(event.target),
        textSelectionActive: hasSelectedText(target)
      },
      {
        keyboardActive: selection.keyboardActive,
        editingFocus: selection.editingFocus,
        isMac: isMacPlatform(target.navigator),
        writable: writable()
      }
    );
    if (action) {
      // Mod+V 不 preventDefault：让原生 paste event 抵达 Input Scope Host（文件/内部载荷）。
      // 内部载荷粘贴由 `input.paste` contribution 处理，页内 fallback 也在那里。
      if (action === "find") {
        // Ctrl/⌘+F：只有主画布拥有输入且无编辑器/模态时才打开查找（任务 4.2）。
        event.preventDefault();
        options.onFindRequest?.();
        return;
      }
      if (action === "undo" || action === "redo") {
        // 撤销/重做由页面编辑历史处理（read-only 下也可回放本地参数）（任务 1.7）。
        event.preventDefault();
        if (action === "undo") options.onUndoRequest?.();
        else options.onRedoRequest?.();
        return;
      }
      if (action !== "paste") {
        event.preventDefault();
        void runClipboardShortcut(action);
      }
      return;
    }
    if (event.key === "Escape") {
      // 拖动粘连手势：Escape 取消整次手势（清 held/preview 且不提交），
      // change: add-drag-touch-connections，design D6。
      if (core.attachActive()) {
        event.preventDefault();
        core.cancelDragGesture();
        return;
      }
      state.selectedEdgeId = null;
      core.clearHover();
      state.draft = null;
      state.localPositions = new Map();
      state.localSizes = new Map();
      state.viewportPreview = null;
      state.gesture = { kind: "none" };
      schedule();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === "Space") state.spacePressed = false;
    if (model.active) model.applyFlyKey(event, false);
    // 拖动粘连 Q/E held 释放（change: add-drag-touch-connections，design D2）。
    if ((event.code === "KeyQ" || event.code === "KeyE") && core.attachActive()) {
      core.onAttachKey(event.code, false);
    }
  };

  /**
   * 捕获阶段的 Space 释放（change: fix-space-pan-latch-after-focus-exit）。
   *
   * 只在捕获阶段清一个布尔闩锁，不消费事件、不影响 DOM 优先的按键契约。挂捕获阶段是因为
   * 冒泡阶段的 `keyup` 会被浮层/编辑面 `stopPropagation` 吞掉（如文字输入层
   * `onKeyUp={event => event.stopPropagation()}`）；吞掉后 `spacePressed` 永久为真，
   * 之后普通画布上每次左键按下都在命中查询前短路成 pan，节点再也点不中。
   */
  const onSpaceRelease = (event: KeyboardEvent) => {
    if (event.code === "Space") state.spacePressed = false;
  };

  /**
   * DOM `copy` 事件兜底（桌面原生菜单派发的复制路径）。
   *
   * Tauri/macOS 默认 App 菜单登记了 `Cmd+C`，按键先被原生 Edit > Copy 消费，页面收不到
   * `keydown`；WebKit 随后仍会在非编辑焦点的元素上派发 `copy`。这里把载荷写进事件的
   * `clipboardData`，让同一次复制既进系统剪贴板又保留页内 fallback：
   * - 编辑面（input/textarea/contenteditable/菜单/弹窗）或存在真实文本选区时完全不介入，
   *   文本框的原生复制仍然由浏览器处理；
   * - 只有 `keyboardActive` 且画布持有输入时认领，无普通选中节点时不改写剪贴板。
   */
  const onCopy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || core.modalActive()) return;
    if (!nodeSelectionStore.getSnapshot().keyboardActive) return;
    if (isEditableElement(event.target) || hasSelectedText(target)) return;
    const copyable = copyableSelection();
    if (!copyable) return;
    const closure = buildCanvasCopyPayload(copyable.canvasState, copyable.others, );
    const included = new Set(closure?.nodes.map(n => n.id));
    if (closure?.nodes.some(n => {
      const data = copyable.canvasState.nodeData[n.id];
      const relation = managedNodeRelationOf(data);
      return data?.mediaContent && !(relation && included.has(relation.ownerNodeId));
    })) {
      // A native copy event cannot await a provider. Publish only the completed
      // snapshot through the async clipboard writer and the in-page fallback.
      // Never put a still-live reference on the clipboard as an interim copy.
      event.clipboardData?.setData("text/plain", "");
      event.preventDefault();
      void runClipboardShortcut("copy");
      return;
    }
    const text = buildClipboardText();
    if (text === null) return;
    const data = event.clipboardData;
    if (!data) return;
    data.setData("text/plain", text);
    event.preventDefault();
  };

  return { onKeyDown, onKeyUp, onCopy, onSpaceRelease };
}
