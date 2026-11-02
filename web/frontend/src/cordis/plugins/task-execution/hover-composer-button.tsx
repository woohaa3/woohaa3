/**
 * 悬停卡片底部浮出的「添加到对话框」大胶囊
 * （参考稿：指针停在图片上时，卡片下缘浮出一条圆角胶囊，中间一个 ⊕ 加文案）。
 *
 * 位置由 `nodeScreenRect` 投影，随视口与画布变化刷新；显示条件见 `hover-composer.ts`。
 *
 * 指针移进胶囊会让画布补发 `pointerleave` 并清空 hover，于是「hover 一空就卸载」会让胶囊
 * 在被点到之前先消失。这里用一个很短的延迟收起：离开卡片后先排一次隐藏，指针若落进胶囊
 * 就取消它。延迟同时也覆盖「指针直接移出画布」——没有进入胶囊，到点即收起。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { PlusIcon } from "@woohaa3/ui/icons";
import { useService } from "../../react.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import { hoverComposerBox, resolveHoverComposerTarget } from "./hover-composer.js";
import "./hover-composer.css";

/**
 * 收起延迟（毫秒）。只需长到让「离开画布 → 进入胶囊」这两个相邻事件落在同一窗口里；
 * 再长就会在指针已经移开时留下一条悬空的胶囊。
 */
const HIDE_DELAY = 160;

/** 只读画布上的原因文案（与旧横条动作的 `reason` 一致，不再让点击静默失败）。 */
const READ_ONLY_REASON = "当前会话不可写（画布只读）";

/** 视口尺寸的稳定快照（`useSyncExternalStore` 要求同一状态返回同一引用）。 */
let viewportSnapshot = { width: 0, height: 0 };
function readViewport() {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  if (viewportSnapshot.width !== width || viewportSnapshot.height !== height) viewportSnapshot = { width, height };
  return viewportSnapshot;
}
function subscribeViewportSize(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** 矩形的比较键：取整到 0.5px，避免亚像素抖动触发重渲染。 */
function rectKey(rect: { left: number; top: number; width: number; height: number } | null): string {
  if (!rect) return "";
  const q = (value: number) => Math.round(value * 2) / 2;
  return `${q(rect.left)}|${q(rect.top)}|${q(rect.width)}|${q(rect.height)}`;
}

export function HoverComposerButton() {
  const runtime = useService("canvasRuntime");
  const navigation = useService("canvasNavigation");
  const canvasState = useService("canvasState");
  const session = useService("canvasSession");
  useSyncExternalStore(canvasState.subscribe, canvasState.getCanvas, canvasState.getCanvas);
  useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  useSyncExternalStore(runtime.subscribeViewport, runtime.viewportVersion, runtime.viewportVersion);
  // 可写性只在渲染那一刻读一次是不够的：断线/重连会把会话切成只读，而指针可能正静止在卡片上，
  // 上面几个订阅都不会因此通知。canvas-host 同样订阅 session 后重读 `isWritable()`
  // （`canvas-host.tsx`「新 snapshot 引用迫使订阅者重渲染并重新读取 isWritable()」）。
  useSyncExternalStore(session.subscribe, session.getStatus, session.getStatus);
  const viewport = useSyncExternalStore(subscribeViewportSize, readViewport, readViewport);
  const hovered = useSyncExternalStore(hoverNodeStore.subscribe, hoverNodeStore.getSnapshot, hoverNodeStore.getSnapshot).nodeId;

  const [shownNodeId, setShownNodeId] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 指针当前是否落在胶囊上（`pointerenter/leave`）。 */
  const pointerInside = useRef(false);

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);
  const hideNow = useCallback(() => {
    cancelHide();
    setShownNodeId(null);
  }, [cancelHide]);
  /**
   * 排一次收起。到点**再确认一次指针位置**：延迟只是留给「离开画布 → 进入胶囊」这两个相邻
   * 事件的时间窗，不是给胶囊的额外存活期 —— 指针既不在卡片上、也不在胶囊上时立刻收起，
   * 免得指针已经移开、胶囊还停在原处被下一帧的点击误中。
   */
  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (pointerInside.current) return;
      setShownNodeId(null);
    }, HIDE_DELAY);
  }, [cancelHide]);

  // 悬停节点到达即展示；离开后延迟收起，留给指针落进胶囊的时间。
  //
  // 首次挂载且本来就无悬停时不排这一枪：否则每次进画布都会白跑一个定时器（StrictMode 下
  // 还会跑两轮），而结果只是把 null 再设成 null。
  const wasHovering = useRef(false);
  useEffect(() => {
    if (hovered) {
      wasHovering.current = true;
      cancelHide();
      setShownNodeId(hovered);
    } else if (wasHovering.current) {
      scheduleHide();
    }
  }, [hovered, cancelHide, scheduleHide]);

  useEffect(() => cancelHide, [cancelHide]);

  // 画布外框移动但视口没变（资源栏收展、窗口缩放、卡片改尺寸、图片加载）时，上面几个订阅
  // 都不会通知，胶囊就停在旧位置。执行面板靠 scene / frame / ResizeObserver 兜住这几类变化，
  // 这里照做：帧回调里只在「渲染过的矩形」与「此刻矩形」不同时才重渲染，静止时不产生渲染。
  const [, setGeometryTick] = useState(0);
  const renderedNodeId = useRef<string | null>(null);
  const renderedRectKey = useRef("");
  useEffect(() => {
    const bump = () => setGeometryTick((tick) => tick + 1);
    const recheck = () => {
      const nodeId = renderedNodeId.current;
      if (!nodeId) return;
      if (rectKey(runtime.nodeScreenRect(nodeId)) !== renderedRectKey.current) bump();
    };
    const offScene = runtime.subscribeScene?.(recheck);
    const offFrame = runtime.subscribeFrame?.(recheck);
    const surface = document.getElementById("bevy-canvas");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recheck);
    if (surface) observer?.observe(surface);
    if (surface?.parentElement) observer?.observe(surface.parentElement);
    window.addEventListener("resize", recheck);
    return () => {
      offScene?.();
      offFrame?.();
      observer?.disconnect();
      window.removeEventListener("resize", recheck);
    };
  }, [runtime]);

  const canvas = canvasState.getWorkingCanvas() ?? canvasState.getCanvas();
  // 订阅只用来在会话状态变化时重渲染；可写性仍以 `isWritable()` 为准
  // （它还看本地离线与只读标记，不能只看订阅到的 status）。
  const writable = session.isWritable();
  const target = resolveHoverComposerTarget({
    hoveredNodeId: hovered,
    pinnedNodeId: shownNodeId,
    // 聚焦工作区里卡片由聚焦界面接管，不再浮出胶囊。
    focusActive: navigation.getSnapshot().mode.type !== "overview",
    nodes: canvas?.document.nodes ?? []
  });

  // 视口尺寸用于在卡片贴边时翻到上方/钳制进来；量不到（0）时退回纯几何。
  const nodeRect = target ? runtime.nodeScreenRect(target.nodeId) : null;
  renderedNodeId.current = target?.nodeId ?? null;
  renderedRectKey.current = rectKey(nodeRect);
  const box = target ? hoverComposerBox(nodeRect, viewport.width > 0 ? viewport : undefined) : null;
  if (!target || !box) return null;

  const style: CSSProperties = {
    left: `${Math.round(box.left)}px`,
    top: `${Math.round(box.top)}px`,
    width: `${Math.round(box.width)}px`,
    height: `${Math.round(box.height)}px`
  };
  return (
    <div
      className="hover-composer"
      style={style}
      onPointerEnter={() => {
        pointerInside.current = true;
        cancelHide();
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        // 指针离开胶囊时卡片那边早已没有悬停 → 立刻收起，不留可被误点的窗口。
        if (!hovered) hideNow();
      }}
      data-node-id={target.nodeId}
    >
      <button
        type="button"
        className="hover-composer__button"
        // 只读画布保留呈现但不可用（与本动作原先在横条里的表达一致：留白原因而不是让点击静默失败）。
        aria-disabled={writable ? undefined : true}
        title={writable ? undefined : READ_ONLY_REASON}
        onClick={() => {
          if (!writable) return;
          // 与顶部横条里的同一动作走一条路径：只选中，面板内容跟随 selection。
          runtime.controller()?.selectNode(target.nodeId);
        }}
      >
        {/* ⊕ = 圆环（CSS 描边）+ 图标库的加号；审计禁止业务插件自绘通用操作 <svg>。 */}
        <span className="hover-composer__glyph" aria-hidden="true">
          <PlusIcon />
        </span>
        <span>添加到对话框</span>
      </button>
    </div>
  );
}
