/**
 * 节点「呈现矩形」到屏幕坐标的投影（从 `host.ts` 的同名方法原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`host.ts` 曾越过 800 物理行上限。这里只做坐标换算：
 * 输入是节点 id 与若干读函数，输出一个 CSS px 矩形，不写任何实例状态。
 */
import type { GroupBadgeProjection, ScreenRect, ServerCanvas } from "@woohaa3/contracts";
import { getGroupLayoutSizes } from "@woohaa3/contracts";
import { groupBadgePresentationScreenRect } from "./group-badge-screen-rect.js";

/**
 * 运行时控制器里本函数需要的那几项（未挂载时整体为 null）。
 *
 * 刻意写成与 `InteractionController` 同形的**结构类型**而不是 import 那个接口：
 * 这样 host 可以直接把 `this.controllerInstance` 传进来，不用每次调用现造一层适配对象
 * （这个方法挂在执行面板的渲染路径上，面板跟随徽标重排时逐帧走到）。同时不引入对
 * canvas-shell 的类型依赖，architecture.test.ts 的跨插件清单不需要改动。
 */
export type PresentationRuntime = {
  viewport(): { zoom: number };
  queryCompositeAssetScopes(): { ok: true; value: Array<{ nodeId: string; aabb: readonly number[] }> } | { ok: false; reason?: string };
  worldToClient(point: { x: number; y: number }): { x: number; y: number } | null;
};

export type PresentationScreenRectInputs = {
  nodeId: string;
  /** 卡片自身的屏幕矩形（拖动/缩放预览已经算进去）。 */
  card: ScreenRect | null;
  /** 当前 working canvas（缺失时按 null 处理）。 */
  canvas: ServerCanvas | null;
  /**
   * 当前运行时控制器；未挂载为 null。
   *
   * 传整个控制器而不是在调用点把 zoom / worldToClient / scope 查询各包一层：`card` 本来就
   * 由它产出，这里也只在有控制器时才会用到其余几项。少一层包装，也少一次每帧的闭包分配
   * （这个方法挂在执行面板的渲染路径上，面板跟随徽标重排时逐帧走到）。
   */
  runtime: PresentationRuntime | null;
  /**
   * 组的模型徽标投影（`groupBadgeProjectionOf` 的结果）。
   *
   * 由调用方算好传入，而不是在这里 import canvas-shell：`groupBadgeProjectionOf` 读
   * `model-scene` 的资源表，属于 canvas-shell 的内部依赖。搬进本文件会让 canvas-runtime
   * 多出一条要评审的跨插件依赖（architecture.test.ts 的白名单按源文件记账，一次纯搬家
   * 就要再加一行）。从 host 传进来既保住那条依赖留在原处，也让本函数保持纯几何。
   */
  groupBadgeProjection: GroupBadgeProjection | null;
};

/**
 * 单节点屏幕矩形（CSS px）（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
 * 未挂载或节点不存在返回 null。
 */
export function presentationScreenRect(input: PresentationScreenRectInputs): ScreenRect | null {
  const { nodeId, card, canvas, runtime } = input;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  // 普通 group 的执行面板跟随外部 3D 徽标，而不是跟随气泡主体。使用当前 screen rect
  // 保留拖动/缩放预览，再把同一份徽标几何投影到屏幕。
  //
  // 基准必须是**渲染矩形**而不是节点自身尺寸：Rust 把徽标画在渲染场景节点矩形的下缘，
  // 而 group 的渲染矩形是成员包围后的布局尺寸（`getGroupLayoutSizes`，可比节点自身高得多）。
  // 用节点尺寸推导会把徽标算高一整段，面板随之压回场景上。
  //
  // `runtime` 这一项对应原方法里的 `&& this.controllerInstance` 守卫：徽标投影与合成资产
  // scope 都来自运行时控制器，未挂载时两者都没有意义。今天 `card` 也由控制器产出（未挂载
  // 必为 null），所以这个条件是冗余的 —— 但不要依赖那条跨方法的不变量：一旦 `card` 有了
  // 缓存兜底，这里就会拿不到 zoom 而算出错误的面板锚点。
  if (card && node?.type === "group" && runtime) {
    const data = canvas?.nodeData[nodeId];
    const layout = canvas ? getGroupLayoutSizes(canvas.document.nodes).get(nodeId) ?? null : null;
    return groupBadgePresentationScreenRect({
      card,
      zoom: runtime.viewport().zoom,
      node,
      layout,
      collapsed: data?.groupCollapsed === true,
      projection: input.groupBadgeProjection
    }) ?? card;
  }
  // 走到这里一定已挂载：未挂载时 `card` 必然是 null，上面两个分支都会原样返回。
  if (!runtime) return card;
  const scopes = runtime.queryCompositeAssetScopes();
  if (!scopes.ok) return card;
  const scope = scopes.value.find((entry) => entry.nodeId === nodeId);
  if (!scope) return card;
  const [worldLeft, worldTop, width, height] = scope.aabb;
  const start = runtime.worldToClient({ x: worldLeft, y: worldTop });
  const end = runtime.worldToClient({ x: worldLeft + width, y: worldTop + height });
  if (!start || !end) return card;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  const x = Math.min(card?.left ?? left, left);
  const y = Math.min(card?.top ?? top, top);
  return { left: x, top: y, width: right - x, height: bottom - y };
}
