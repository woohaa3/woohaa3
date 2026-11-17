/**
 * 多选整理按钮的浮层。
 *
 * 定位只有一个来源：选区包围盒左上角经 `CanvasRuntimeService.worldToClient` 换到 client 坐标，
 * 再减 canvas 元素矩形得到容器内偏移。不另算视口、不另建相机。
 *
 * 跟随画布的方式沿用宿主节点横条的既有做法：**直接改 DOM 的 left/top**，而不是每帧触发
 * React 重渲染。拖动与缩放的帧通知走 `subscribeFrame` / `subscribeViewport`，快照值只用来
 * 决定「要不要渲染这个按钮」。
 *
 * 只在「≥2 个可整理单元被选中」且未进入聚焦工作区时出现：单选时宿主已有自己的动作横条，
 * 这里让位，避免两条横条抢同一个位置。
 *
 * 选区里有 2D 组时，**额外**出现一个组内整理按钮：整理整组不会动组内成员的相对位置（见
 * `tidy-plan` 的说明），想让成员排整齐必须显式点它——默认不替用户改别人排好的组。
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type {
  CanvasRuntimeService,
  CanvasSession,
  CanvasStoreFacade,
  SelectionService
} from "@woohaa3/frontend/extension-api";
import type { ServerCanvas } from "@woohaa3/contracts";
import { LayoutGridIcon } from "@woohaa3/ui/icons";
import { tidyAnchorOfSelection, type TidyGroupTarget } from "./tidy-plan.js";
import "./style.css";

/** 按钮底边与选区左上角的间距（px）。 */
const ANCHOR_GAP = 8;

export type TidyAnchor = {
  nodeIds: string[];
  /** 选区包围盒左上角（世界坐标）。 */
  worldTopLeft: { x: number; y: number };
  /** 选区里可整理内部的 2D 组；为空时不出现组内整理按钮。 */
  groups: TidyGroupTarget[];
};

/**
 * 判定是否出现按钮，并给出锚点。
 *
 * 只读公开的选区快照与 working 画布；不满足条件返回 null（不渲染）。
 */
/**
 * 按钮的呈现条件：**与 `planTidySelection` 的可执行条件一致**。
 *
 * 这条一致性是刻意的：按钮只在真能整理的时候出现，用户就不会点到一个注定失败的按钮、再被一个
 * 错误弹窗打断。选中含世界对象/导演区或只选组成员时，按钮干脆不出现。
 */
export function resolveTidyAnchor(input: {
  canvas: ServerCanvas | null;
  selectedNodeIds: readonly string[];
  writable: boolean;
  focused: boolean;
}): TidyAnchor | null {
  if (input.focused || !input.writable || !input.canvas) return null;
  const nodes = input.selectedNodeIds
    .map((id) => input.canvas!.document.nodes.find((node) => node.id === id))
    // 只有带卡片位置的节点能整理；世界对象与导演区没有卡片坐标。
    .filter((node): node is NonNullable<typeof node> => node?.position !== undefined);
  // 单选、空选都不归这里管：单选由宿主的节点动作横条负责。
  if (nodes.length < 2) return null;
  return tidyAnchorOfSelection(input.canvas, input.selectedNodeIds);
}

/** 世界坐标 → 画布容器内偏移；运行时未挂载或画布元素缺失时返回 null。 */
export function tidyButtonScreenPosition(
  runtime: CanvasRuntimeService,
  worldTopLeft: { x: number; y: number }
): { left: number; top: number } | null {
  const element = typeof document === "undefined" ? null : document.getElementById("bevy-canvas");
  if (!element) return null;
  const point = runtime.worldToClient(worldTopLeft);
  if (!point) return null;
  const box = element.getBoundingClientRect();
  return { left: point.x - box.left, top: point.y - box.top };
}

export type TidyButtonHostProps = {
  canvasState: CanvasStoreFacade;
  selection: SelectionService;
  session: CanvasSession;
  runtime: CanvasRuntimeService;
  onTidy: () => void;
  /** 整理选中组内部（宫格）；选区里有带成员的组时按钮才出现。 */
  onArrangeGroups: (groupIds: readonly string[]) => void;
};

export function TidyButtonHost({ canvasState, selection, session, runtime, onTidy, onArrangeGroups }: TidyButtonHostProps) {
  // 快照只承担「选区/画布结构是否变了」：它决定按钮存不存在，不决定它在哪。
  const signature = useSyncExternalStore(
    listener => {
      const disposers = [selection.subscribe(listener), canvasState.subscribe(listener)];
      return () => disposers.forEach(dispose => dispose());
    },
    () => `${selection.getSnapshot().nodeIds.join("|")}:${canvasState.getWorkingCanvas()?.revision ?? -1}`,
    () => ""
  );
  void signature;

  const anchor = resolveTidyAnchor({
    canvas: canvasState.getWorkingCanvas(),
    selectedNodeIds: selection.getSnapshot().nodeIds,
    writable: session.isWritable(),
    focused: runtime.isFocused()
  });
  if (!anchor) return null;
  // 锚点身份变化时重建定位 effect：同一批选区内部的位置变化仍由帧通知处理。
  return <TidyButton
    key={`${anchor.nodeIds.join("|")}:${anchor.worldTopLeft.x}:${anchor.worldTopLeft.y}`}
    anchor={anchor}
    runtime={runtime}
    onTidy={onTidy}
    onArrangeGroups={onArrangeGroups}
  />;
}

function TidyButton({ anchor, runtime, onTidy, onArrangeGroups }: {
  anchor: TidyAnchor;
  runtime: CanvasRuntimeService;
  onTidy: () => void;
  onArrangeGroups: (groupIds: readonly string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const position = () => {
      const next = tidyButtonScreenPosition(runtime, anchor.worldTopLeft);
      // 目标暂时算不出来（运行时重建中）时隐藏而不是留在上一帧的位置。
      element.style.visibility = next ? "visible" : "hidden";
      if (!next) return;
      element.style.left = `${Math.round(next.left)}px`;
      element.style.top = `${Math.round(next.top - ANCHOR_GAP)}px`;
    };
    position();
    const disposers = [
      runtime.subscribeViewport(position),
      runtime.subscribeFrame?.(position) ?? (() => {}),
      runtime.subscribeScene?.(position) ?? (() => {})
    ];
    window.addEventListener("resize", position);
    return () => {
      disposers.forEach(dispose => dispose());
      window.removeEventListener("resize", position);
    };
  }, [runtime, anchor]);

  // 只选了一个组时按钮直接指向它；选了几个组时按组分别列出，不替用户猜。
  const groups = anchor.groups;

  return <div
    ref={ref}
    className="canvas-tidy"
    style={{ visibility: "hidden" }}
    // 按钮浮在画布之上：不让指针事件穿透成画布手势（框选、拖动、右键菜单）。
    onPointerDown={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => event.stopPropagation()}
  >
    <button
      type="button"
      className="canvas-tidy__button"
      title="按连线方向从左到右分层排布（源在左、下游在右），顺带消除重叠并缩回过大的卡片；2D 组整体移动"
      onClick={onTidy}
    >
      <LayoutGridIcon size={15} />
      <span>一键整理</span>
    </button>
    {groups.length > 0 && <button
      type="button"
      className="canvas-tidy__button canvas-tidy__button--secondary"
      title={groups.length === 1
        ? `只整理「${groups[0]!.title}」内部 ${groups[0]!.memberCount} 个成员，组与其它卡片不动`
        : `只整理选中的 ${groups.length} 个组的内部成员，组与其它卡片不动`}
      onClick={() => onArrangeGroups(groups.map(group => group.groupId))}
    >
      <span>{groups.length === 1 ? "整理组内部" : `整理 ${groups.length} 个组内部`}</span>
    </button>}
  </div>;
}
