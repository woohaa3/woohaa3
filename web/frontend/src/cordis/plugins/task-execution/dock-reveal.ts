import { nodeWorldRect } from "@woohaa3/contracts";
import type { CanvasRuntimeService } from "../../contracts.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

type ScreenRect = { left: number; right: number; top: number; bottom: number };

/** 最小向上平移；超大节点保留顶部，避免为了露出底部把整个节点移出画布。 */
export function dockRevealOffset(node: ScreenRect, dock: ScreenRect, surfaceTop: number): number {
  if (node.right <= dock.left || node.left >= dock.right || node.top >= dock.bottom || node.bottom <= dock.top) return 0;
  return Math.max(0, Math.min(node.bottom - dock.top + 16, node.top - surfaceTop - 16));
}

/** 当前节点对应的底部面板；加载骨架与真实面板是先后两个元素，都带同一个 data-node-id。 */
function findDock(nodeId: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(".node-execution-dock"))
    .find((element) => element.dataset.nodeId === nodeId) ?? null;
}

/** 面板仍是懒加载骨架（骨架换成真实面板后需要重新绑定观察目标）。 */
function isSkeleton(dock: HTMLElement): boolean {
  return dock.querySelector(".authoring-generate-placeholder") !== null;
}

/** 只在面板出现、换节点或面板尺寸改变时避让；不订阅视口，不追逐用户平移。 */
export function watchDockReveal(runtime: CanvasRuntimeService, nodeId: string): (() => void) | undefined {
  let dock = findDock(nodeId);
  if (!dock) return;
  let frame = 0;
  const initial = runtime.controller()?.viewport();
  if (!initial) return;
  let targetY = initial.y;
  const reveal = () => {
    if (nodeSelectionStore.getSnapshot().primaryNodeId !== nodeId || runtime.isFocused()) return;
    const controller = runtime.controller();
    const surface = document.getElementById("bevy-canvas");
    const state = woohaa3CanvasStore.getState();
    const canvas = workingCanvasOf(state) ?? state.canvas;
    const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
    if (!controller || !surface || !node || !canvas) return;
    const viewport = controller.viewport();
    // 面板异步增高可以继续避让；用户已接管镜头后停止观察，不抢回视口。
    if (viewport.x !== initial.x || viewport.zoom !== initial.zoom || viewport.y > initial.y || viewport.y < targetY) {
      observer.disconnect();
      return;
    }
    const rect = nodeWorldRect(node, new Map(canvas.document.nodes.map((entry) => [entry.id, entry])));
    const start = runtime.worldToClient(rect);
    const end = runtime.worldToClient({ x: rect.x + rect.width, y: rect.y + rect.height });
    const panel = dock!.getBoundingClientRect();
    if (!start || !end || !panel.height) return;
    const offset = dockRevealOffset({ left: start.x, top: start.y, right: end.x, bottom: end.y }, panel, surface.getBoundingClientRect().top);
    if (offset > 0) {
      targetY = viewport.y - offset;
      controller.panViewportTo({ ...viewport, y: targetY });
    }
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reveal);
  };
  const observer = new ResizeObserver(schedule);
  /**
   * 懒加载骨架被真实面板替换后，观察目标会脱离文档（`getBoundingClientRect()` 恒为 0，后续增高
   * 不再触发避让）。这里按 DOM 变化有限地重新绑定：确认面板已不是骨架后立即断开，避免长期观察。
   */
  const shell = new MutationObserver(() => {
    if (dock?.isConnected) {
      if (!isSkeleton(dock)) shell.disconnect();
      return;
    }
    const next = findDock(nodeId);
    if (!next) return;
    observer.unobserve?.(dock!);
    dock = next;
    observer.observe(next);
    schedule();
    if (!isSkeleton(next)) shell.disconnect();
  });
  if (isSkeleton(dock)) shell.observe(document.body, { childList: true, subtree: true });
  observer.observe(dock);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    shell.disconnect();
    observer.disconnect();
  };
}
