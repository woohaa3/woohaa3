import { createCancellationHandlers } from "./input/cancellation.js";
import { createContextMenuFallback } from "./input/context-menu.js";
import { createHistoryClick } from "./input/history-click.js";
import { createGroupBadgeClick } from "./input/group-badge-click.js";
/**
 * 2D 画布 gesture family（pointer / wheel / 快捷键 / 双击）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；design D2）。
 *
 * 从 `interaction-controller` 拆出的基础 2D 手势：拖拽、尺寸、连线、框选、平移、视口滚轮、
 * 右键菜单、双击预览。只通过 `InteractionCore` 访问共享坐标系、调度与提交，不自建监听。
 */
import { modelPreviewPointerDown, modelPreviewPointerMove } from "./input/model-preview.js";
import { bevyKindForNodeType, builtinNodeCapabilityResolver, explainWoohaa3CanvasConnectionBlock, isFilmSetObjectModelNode, normalizeWoohaa3CanvasGroupSelection } from "@woohaa3/contracts";
import { nodeSize, cardHitNodeId, type Point } from "./hit-test.js";
import { planAggregateConnect, planConnectEdge, planResizeNode } from "../../../extension-api/command-planner.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { createWheelViewport } from "./interaction-viewport.js";
import { resizeTarget as resizeTargetHelper, scopeResizeTarget, isGroupResizeCorner, SCOPE_HANDLE_ORDER } from "./interaction-2d-helpers.js";
import { createDragAttachState, isDragAttachConnectable } from "./drag-attach.js";
import { createDragGestureFamily } from "./drag-gesture.js";
import { applyDragAlignment, setAlignmentGuides } from "./alignment-snap.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { createAggregateConnectFamily } from "./aggregate-connect.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import { createWheelEntryHandler } from "./input/wheel-entry.js";
import { createPerfInputRecorder, type PerfMoment } from "./input/perf-interaction.js";
import { telemetryNow } from "../../services/telemetry-primitives.js";
/** 右键位移阈值：小于它视为短点击（开菜单），达到则进入平移并抑制菜单。 */
const RIGHT_CLICK_PAN_THRESHOLD_PX = 10;

export function create2dInputFamily(core: InteractionCore) {
  const { options, canvas, writable, state, model, setSelection, submit, schedule } = core;
  const viewport = createWheelViewport(core);
  const aggregate = createAggregateConnectFamily(core);
  const history = createHistoryClick(core);
  const groupBadge = createGroupBadgeClick(core);

  const drag = createDragGestureFamily(core);
  /**
   * 生成拖动预览位置（含辅助对齐吸附）。
   *
   * 原始位移 → 插件策略求吸附偏移 → 写回参考线 → 按吸附后的位移落预览。
   * pointermove 与 release 前的最后一次重算共用它，保证"看到的位置就是提交的位置"。
   */
  const applyDragPreview = (
    roots: ReadonlyMap<string, { x: number; y: number }>,
    dx: number,
    dy: number
  ): void => {
    const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
    const snapped = applyDragAlignment({
      state,
      policy: core.alignmentSnap(),
      index,
      roots,
      dx,
      dy,
      zoom: core.activeViewport().zoom
    });
    state.localPositions = new Map();
    for (const [id, origin] of roots) {
      state.localPositions.set(id, { x: origin.x + snapped.dx, y: origin.y + snapped.dy });
    }
  };
  /**
   * 本次指针手势的性能收集器（change: 2026-10-25-enhance-telemetry-performance-collection，
   * task 3.3 / design D2）。
   *
   * 只在**确认要开始某种手势**之后 `start`：门禁返回、命中不可用、命中横条动作等都不开启，
   * 于是不会产生 `perf.interaction`（spec: 拒绝输入不发）。高频 pointermove 用 `accumulate`
   * 累加，结束时只出一条 `perf.segment`。
   */
  const perf = createPerfInputRecorder();
  /**
   * 本次指针手势的计时起点。
   *
   * 种类在按下时并不确定（右键是菜单还是平移、拖拽是否越过阈值），所以起点先存下来，
   * 确认消费的分支再 `start`。
   */
  let pointerMoment: PerfMoment;
  /** 确认要开始某种手势：只在这里开门，门禁拒绝的路径不会调用。 */
  const beginPerfGesture = (kind: string): void => {
    perf.start(kind, pointerMoment);
  };
  /** 结束本次手势的性能事实；未开始时是 no-op（被拒绝的输入因此不发事件）。 */
  const finishPerfGesture = (result: "success" | "failure" | "cancelled" = "success"): void => {
    pointerMoment = undefined;
    perf.finish(result);
  };

  const resizeTarget = (    gesture: Extract<Gesture, { kind: "resize" }>,
    world: Point
  ): { width: number; height: number; position?: Point } | null => {
    const current = workingCanvasOf(woohaa3CanvasStore.getState());
    const node = current?.document.nodes.find(node => node.id === gesture.nodeId);
    if (!current || !node) return null;
    const context = { canvas: current, node, data: current.nodeData[node.id] };
    const resize = (options.nodeCapabilities ?? builtinNodeCapabilityResolver).resolve(context).resize;
    if (!resize) return null;
    return gesture.mode === "scope" && gesture.handle && gesture.anchor
      ? scopeResizeTarget(
          { handle: gesture.handle, anchor: gesture.anchor, originCenter: gesture.originCenter, originWidth: gesture.originWidth, originHeight: gesture.originHeight },
          world, resize.minimum(context)
        )
      : resizeTargetHelper(gesture, world, options.nodeCapabilities);
  };

  const commitDragGesture = drag.commit;
  /** 取消路径：手势作废，性能事实按 `cancelled` 结算（不记成 success）。 */
  const cancelDragGesture = (): void => {
    finishPerfGesture("cancelled");
    drag.cancel();
  };

  const onPointerDown = (event: PointerEvent) => {
    // 计时起点在最外层：命中查询也要算进这次输入的耗时（spec: 被拒绝的输入不发事件，
    // 但它的时间仍然值得记下来——只是不产生 `perf.interaction`）。
    pointerMoment = perf.enter();
    contextMenu.begin();
    // 聚焦查看：相机/编辑手势优先，短路一切 2D 手势（design D5）。
    // 非模态 editor/history panel 不得阻断 focus pointer（design D6）。
    if (model.active) {
      if (core.focusInputBlocked()) return;
      model.beginFocusPointer(event);
      return;
    }
    // 视频聚焦：内容手势由聚焦 overlay 独占，普通画布 2D 手势（拖动/框选/连线/菜单）隔离。
    if (options.isVideoFocused?.() ?? !!options.getVideoFocus?.()) return;
    // modal 打开时不开始任何 2D 画布手势（design D6）。
    if (core.modalActive()) { return; }
    // 开始手势即暂停 hover 视频播放（design D3）。持续手势还会清除 hover 投影，使模型动画
    // 门禁停止播放（change: play-model-animations-on-hover，任务 3.2）：见下方各持久手势分支。
    // 但按下那一刻的悬停态是本次命中判定的输入：删除按钮只存在于「悬停的连线」上
    // （change: add-edge-hover-delete），clearHover 之后再查询就永远命中不到它，所以先取下来。
    const pressedHoveredEdgeId = state.hoveredEdgeId;
    core.suspendHoverPlayback();
    // 命中沿用 pointerdown 当时的连线悬停态：删除按钮只在悬停中的连线上可命中
    // （change: add-edge-hover-delete）。clearHover 负责清 hover 投影与播放门禁，
    // 不改变本次命中的输入，因此先取 hoveredEdgeId 再清除。
    const hoveredEdgeId = state.hoveredEdgeId;
    core.clearHover();
    /** 持久手势开始：清除 hover 投影，避免手势期间继续播放模型动画。 */
    const beginGesture = () => core.clearHover();
    // 右键（2）用于「短点击开菜单 / 拖拽平移」；其它 >1 的按键忽略。
    const isRight = event.button === 2;
    const world = core.pointerWorld(event);
    state.lastPointerWorld = world;
    // pointerup is itself the authoritative release coordinate. A final DOM
    // event can arrive without an intervening pointermove, so refresh the
    // drag preview from the release point before constructing the atomic batch.
    if (state.gesture.kind === "drag" && state.gesture.moved) {
      const dx = world.x - state.gesture.start.x;
      const dy = world.y - state.gesture.start.y;
      const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
      const roots = index?.dragRoots(state.gesture.origins) ?? state.gesture.origins;
      // 释放点也用同一套吸附重算：否则松开瞬间会跳回未吸附坐标，提交位置与画面不一致。
      applyDragPreview(roots, dx, dy);
    }
    if (event.button !== undefined && event.button > 1 && !isRight) return;
    // 平移手势只用视口，不依赖命中几何：在任何查询之前处理。
    if (event.button === 1 || state.spacePressed) {
      beginGesture();
      beginPerfGesture("pan");
      state.gesture = { kind: "pan", pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    // 命中由 Rust interaction snapshot 计算（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    const hitStartedAt = pointerMoment;
    const hitResult = core.queryPoint(world, core.activeViewport().zoom, pressedHoveredEdgeId);
    // 命中查询是这次输入里最贵的一步；记成固定段（stage 来自契约枚举）。
    perf.accumulateSince("hit-query", hitStartedAt);
    if (!hitResult.ok) {
      // 几何不可用/过期：不开始新手势（design D3）。
      return;
    }    const hit = hitResult.value;

    if (modelPreviewPointerDown(core, event, hit)) return;

    if (isRight) {
      const nodeId = hit && "nodeId" in hit ? hit.nodeId : null;
      if (nodeId && !state.selected.includes(nodeId)) setSelection([nodeId]);
      beginGesture();
      // 右键的种类要等到释放才知道（短按=菜单，越过阈值=平移），所以此处**不开门**：
      // 菜单在 pointerup 结算，平移在 pointermove 越过阈值时开。这样 kind 不会记错。
      state.gesture = {
        kind: "right-press",
        pointerId: event.pointerId,
        start: world,
        startScreen: { x: event.clientX, y: event.clientY },
        nodeId,
        moved: false
      };
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    if (groupBadge.down(event, hit)) return;

    if (hit && hit.kind === "aggregate-handle") {
      // change: add-multi-select-aggregate-connect：从选区聚合把手批量拉线。
      if (aggregate.begin(hit.direction, world, event.pointerId)) {
        beginGesture();
        // 聚合拉线在数据层面就是一次批量连线，归入 `connect`（契约的 kind 集合没有单独一项）。
        beginPerfGesture("connect");
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        schedule();
        return;
      }
    }

    if (hit && hit.kind === "node-action") {
      // 顶部操作横条（Bevy 绘制、Rust 命中）动作：只派发，不开始任何画布手势
      // （change: 2026-10-13-add-node-to-film-set-shortcut）。横条之外的平移/缩放照常。
      event.preventDefault();
      options.onNodeAction?.({ nodeId: hit.nodeId, actionId: hit.actionId, menu: hit.menu });
      return;
    }

    if (hit && hit.kind === "selection-action") {
      // 多选动作横条（Bevy 绘制、Rust 命中）动作：只派发，不开始任何画布手势
      // （change: 2026-10-16-add-group-selection-toolbar）。横条之外的平移/缩放照常。
      event.preventDefault();
      options.onSelectionAction?.({ actionId: hit.actionId, menu: hit.menu });
      return;
    }

    if (hit && hit.kind === "port") {
      beginGesture();
      beginPerfGesture("connect");
      state.gesture = { kind: "connect", pointerId: event.pointerId, source: hit.nodeId, side: hit.side };
      state.draft = { source: hit.nodeId, side: hit.side, x: world.x, y: world.y };
      canvas.setPointerCapture?.(event.pointerId);
      schedule();
      return;
    }

    if (hit && hit.kind === "resize") {
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      const entry = canvasState?.document.nodes.find((node) => node.id === hit.nodeId);
      if (entry && canvasState && (options.nodeCapabilities ?? builtinNodeCapabilityResolver).resolve({ canvas: canvasState, node: entry, data: canvasState.nodeData[entry.id] }).resize) {
        const scene2 = core.buildScene();
        const renderNode = scene2?.nodes.find((node) => node.id === hit.nodeId);
        const kind = renderNode?.type ?? bevyKindForNodeType(entry.type);
        const startSize = renderNode
          ? { width: renderNode.width, height: renderNode.height }
          : nodeSize({ type: kind, width: entry.width, height: entry.height });
        // 地面范围只在 accepted scene 声明 isometric-diamond 且命中 8 抓手时启用对角锁定等比手势
        // （design D6）；整个手势锁定该策略，不中途回退普通自由缩放。抓手/锚点由 accepted 范围
        // 几何提供（与绘制/命中共用同一顶点/抓手）。
        const scope = renderNode?.compositeAsset?.scopeShape === "isometric-diamond"
          ? core.queryCompositeAssetScopes()
          : null;
        const handleIndex = hit.handle ? SCOPE_HANDLE_ORDER.indexOf(hit.handle as (typeof SCOPE_HANDLE_ORDER)[number]) : -1;
        const scopeEntry = scope?.ok ? scope.value.find((entry) => entry.nodeId === hit.nodeId) : undefined;
        const opposite = (index: number): number => (index + 4) % 8;
        const handlePoint = scopeEntry && handleIndex >= 0 ? scopeEntry.handles[handleIndex] : null;
        const anchorPoint = scopeEntry && handleIndex >= 0 ? scopeEntry.handles[opposite(handleIndex)] : null;
        const index = sharedCanvasNodeIndex(canvasState);
        const origin = index?.absolutePosition(hit.nodeId);
        const originCenter = origin
          ? { x: origin.x + startSize.width / 2, y: origin.y + startSize.height / 2 }
          : { x: renderNode ? renderNode.x + renderNode.width / 2 : 0, y: renderNode ? renderNode.y + renderNode.height / 2 : 0 };
        // 组容器的四角抓手走自由缩放的低层（非片场范围手势）：命中方向决定固定哪个对角，
        // 因此与既有右下角一样在释放时提交一次 `node.update`（含 position）。
        const groupCorner = !(handlePoint && anchorPoint) && isGroupResizeCorner(hit.handle) ? hit.handle : undefined;
        beginGesture();
        beginPerfGesture("resize");
        state.gesture = {
          kind: "resize",
          pointerId: event.pointerId,
          nodeId: hit.nodeId,
          start: world,
          originWidth: startSize.width,
          originHeight: startSize.height,
          originCenter,
          moved: false,
          mode: handlePoint && anchorPoint ? "scope" : "free",
          ...(handlePoint ? { handle: { x: handlePoint[0], y: handlePoint[1] } } : {}),
          ...(anchorPoint ? { anchor: { x: anchorPoint[0], y: anchorPoint[1] } } : {}),
          ...(groupCorner && origin ? { corner: groupCorner, origin } : {})
        };
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    // 未选中的模型预览与普通卡片一样，先选择并拖动节点；Shift 保留选择操作。
    // 片场范围命中同样选择并整体拖动（change: 2026-10-08-make-film-set-model-only）。
    // 拍摄镜头预览内容区（`shot-preview`）同样是卡片本体，否则缩略图上的按下会穿透成
    // 空白框选，卡片拖不动（change: 2026-10-15-add-film-set-shooting-shot-previews，D2/D8）。
    if (hit && cardHitNodeId(hit) !== null) {
      const hitNodeId = cardHitNodeId(hit) as string;
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      if (event.shiftKey) {
        setSelection(
          state.selected.includes(hitNodeId)
            ? state.selected.filter((id) => id !== hitNodeId)
            : [...state.selected, hitNodeId]
        );
      } else if (!state.selected.includes(hitNodeId)) {
        setSelection([hitNodeId]);
      }
      // 结构/位置索引按 working 身份缓存（design D5）：selection/pan 不失效，pending/远端
      // 结构与位置变化会产生新对象并重建。避免每次按下复制带 data 的整表节点数组。
      const index = sharedCanvasNodeIndex(canvasState);
      // Selection stays on the real model card for copying. Drag its outer container
      // instead, so the child follows through parentId with its local offset unchanged.
      const selected = state.selected.includes(hitNodeId) ? state.selected : [hitNodeId];
      const active = [...new Set(selected.map(id => {
        const node = index?.byId.get(id);
        return isFilmSetObjectModelNode(node, canvasState?.nodeData[id]) && node?.parentId
          ? node.parentId : id;
      }))];
      // selection/gesture 初始化与绝对 origin 解析。
      const origins = (() => {
        const starts = new Map<string, { x: number; y: number }>();
        const moving = new Set(active);
        for (const id of active) for (const childId of options.compositeAssets?.dragAlongNodeIds(canvasState, id) ?? []) {
          const childNode = canvasState?.document.nodes.find((entry) => entry.id === childId);
          if (!isFilmSetObjectModelNode(childNode, canvasState?.nodeData[childId])) moving.add(childId);
        }
        for (const id of moving) {
          // 拖动预览 `localPositions` 在渲染投影里是**绝对**画布坐标，因此 origin 也必须取
          // 绝对坐标。组内节点 position 是相对父级的局部坐标，直接用它会让节点在按下瞬间
          // 跳到「局部坐标 + 指针位移」的位置（change: fix-group-and-marquee-preview）。
          const start = index?.absolutePosition(id);
          if (start) starts.set(id, start);
        }
        if (canvasState) for (const id of active) {
          const adapter = options.compositeAssets?.resolve(canvasState, id);
          for (const related of adapter?.dragAlongNodeIds?.(canvasState, id) ?? []) {
            const relatedNode = canvasState.document.nodes.find((entry) => entry.id === related);
            if (isFilmSetObjectModelNode(relatedNode, canvasState.nodeData[related])) continue;
            const start = index?.absolutePosition(related);
            if (start) starts.set(related, start);
          }
        }
        return starts;
      })();
      // 拖动 group 时其后代随容器移动，因此只拖动**根**：后代保持相对坐标，
      // 若把后代也纳入 origins 会被平移两次（change: add-canvas-node-grouping，design D3）。
      const dragRoots = index?.dragRoots(origins) ?? new Map<string, { x: number; y: number }>();
      // 单节点拖动粘连子状态（change: add-drag-touch-connections，design D1）：只在活动选择
      // 恰为一个可连接、非 group、可写节点时创建；多选 / group / 只读不提供粘连。
      const singleId = active.length === 1 ? active[0]! : null;
      const singleNode = singleId ? index?.byId.get(singleId) : undefined;
      const attach =
        singleNode && singleId && isDragAttachConnectable({ type: singleNode.type }) && writable()
          ? createDragAttachState(singleId)
          : undefined;
      beginGesture();
      beginPerfGesture("drag");
      state.gesture = {
        kind: "drag",
        pointerId: event.pointerId,
        start: world,
        origins: dragRoots,
        moved: false,
        ...(attach ? { attach } : {})
      };
      canvas.setPointerCapture?.(event.pointerId);
      return;
    }

    if (hit && hit.kind === "history") {
      if (history.down(event, hit)) return;
      event.preventDefault();
      options.onNodeHistory?.({ nodeId: hit.nodeId });
      return;
    }

    if (hit && hit.kind === "edge-delete") {
      event.preventDefault();
      if (writable()) submit([{ type: "edge.remove", edgeId: hit.edgeId }]);
      return;
    }

    if (hit && hit.kind === "edge") {
      // 连线本体按下不再删除：改为无操作，避免误删（change: add-edge-hover-delete）。
      // 无操作点击不应隐藏已显示的删除按钮：保持该连线的悬停态，让按钮仍可命中。
      state.hoveredEdgeId = hoveredEdgeId;
      return;
    }

    if (!event.shiftKey) setSelection([]);
    beginGesture();
    beginPerfGesture("marquee");
    state.gesture = { kind: "marquee", pointerId: event.pointerId, start: world, current: world };
    canvas.setPointerCapture?.(event.pointerId);
    schedule();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (groupBadge.move(event)) return;
    if (history.move(event)) return;
    if (modelPreviewPointerMove(core, event)) return;
    if (model.active) {
      model.moveFocusPointer(event);
      return;
    }
    // 同一事件只读一次 canvas 外框（design D1 分段 + 任务 5.2）；world 换算与 hover 结算共用。
    const bounds = core.readBounds();
    const world = core.pointerWorld(event, bounds);
    state.lastPointerWorld = world;
    // pointer 热路径只查询 Rust interaction snapshot，不扫描全场景或构建渲染快照。
    // 卡片外的片场模型 picking 仍驱动原有 hover 播放。
    const hitResult = core.queryPoint(world, core.activeViewport().zoom, state.hoveredEdgeId);
    const badge = hitResult.ok && hitResult.value?.kind === "node-action" && hitResult.value.actionId === "group-badge-select" ? hitResult.value : null;
    // 徽标本体（模型投影范围）只负责选择、拖动与收起/展开；没有独立缩放手柄。
    canvas.title = badge ? "选择并拖动组" : "";
    if (canvas.style) canvas.style.cursor = writable() ? badge ? "pointer" : "" : "";
    core.settlePointerHover(
      hitResult,
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      core.surfaceSize()
    );
    if (state.gesture.kind === "none") return;
    // 移动段的计时起点：一次 pointermove 只读一次时钟，后续分支共用。
    const moveAt = telemetryNow();
    if (state.gesture.kind === "right-press") {
      const distance = Math.hypot(event.clientX - state.gesture.startScreen.x, event.clientY - state.gesture.startScreen.y);
      if (distance >= RIGHT_CLICK_PAN_THRESHOLD_PX) {
        // 越过阈值才确定这是平移：现在才开门，kind 因此是 `pan` 而不是菜单。
        beginPerfGesture("pan");
        perf.accumulateSince("hit-query", pointerMoment);
        state.gesture = {
          kind: "pan",
          pointerId: state.gesture.pointerId,
          last: { x: state.gesture.startScreen.x, y: state.gesture.startScreen.y }
        };
      }
      return;
    }
    if (state.gesture.kind === "pan") {
      const dx = event.clientX - state.gesture.last.x;
      const dy = event.clientY - state.gesture.last.y;
      state.gesture.last = { x: event.clientX, y: event.clientY };
      const base = state.viewportPreview ?? core.localViewport.get();
      state.viewportPreview = { x: base.x + dx, y: base.y + dy, zoom: base.zoom };
      // 平移只改本地视口预览：这段耗时归 `viewport-apply`（与滚轮同一个阶段名）。
      perf.accumulateSince("viewport-apply", moveAt);
      schedule("viewport");
      return;
    }
    if (state.gesture.kind === "drag") {
      const dx = world.x - state.gesture.start.x;
      const dy = world.y - state.gesture.start.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) state.gesture.moved = true;
      applyDragPreview(state.gesture.origins, dx, dy);
      // 先更新位置覆盖，再基于包含覆盖的最新轻量 scene 求值接触（design D3）。
      const changedAttach = drag.evaluate();
      perf.accumulateSince("gesture-move", moveAt);
      schedule(changedAttach ? "input" : "position-preview");
      return;
    }
    if (state.gesture.kind === "resize") {
      const target = resizeTarget(state.gesture, world);
      if (target) {
        state.gesture.moved = true;
        state.localSizes = new Map([[state.gesture.nodeId, { width: target.width, height: target.height }]]);
        // 地面范围左/上方向拖动同时改变中心：预览也提交 position，避免释放时跳变（design D6）。
        const positions = new Map<string, Point>();
        if (target.position) positions.set(state.gesture.nodeId, target.position);
        // 组四角缩放：成员留在画布原位，不跟着框原点移动。显式写成员绝对位置后，
        // `expandPositionPreviews` 不再按父级位移平移它们。
        if (state.gesture.corner) {
          const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
          for (const childId of index?.children.get(state.gesture.nodeId) ?? []) {
            const at = index?.absolutePosition(childId);
            if (at) positions.set(childId, at);
          }
        }
        state.localPositions = positions;
      } else {
        state.localSizes = new Map();
        state.localPositions = new Map();
      }
      perf.accumulateSince("gesture-move", moveAt);
      schedule();
      return;
    }
    if (state.gesture.kind === "connect") {
      state.draft = { source: state.gesture.source, side: state.gesture.side, x: world.x, y: world.y };
      perf.accumulateSince("gesture-move", moveAt);
      schedule();
      return;
    }
    if (state.gesture.kind === "aggregate-connect") {
      aggregate.move(world);
      perf.accumulateSince("gesture-move", moveAt);
      return;
    }
    if (state.gesture.kind === "marquee") {
      state.gesture.current = world;
      perf.accumulateSince("gesture-move", moveAt);
      schedule();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    contextMenu.end(event);
    if (groupBadge.up(event)) return;
    if (history.up(event)) return;
    if (model.active) {
      model.endFocusPointer(event);
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // 指针可能已释放。
      }
      return;
    }
    if (state.gesture.kind === "none") return;
    if ("pointerId" in state.gesture && state.gesture.pointerId !== event.pointerId) return;
    const world = core.pointerWorld(event);
    state.lastPointerWorld = world;
    if (state.gesture.kind === "model-preview") { event.preventDefault(); event.stopPropagation(); }
    // 释放后仍请求一帧（沿用既有语义）；纯 pan 释放用 `"viewport"` 以保持纯视口帧，
    // 其它手势（拖拽/resize/连线/框选）可能改变结构或呈现，用缺省 `"input"` 走 full。
    const releasedKind = state.gesture.kind;
    const commitAt = telemetryNow();

    try {
    if (state.gesture.kind === "aggregate-connect") {
      // change: add-multi-select-aggregate-connect：正常释放批量提交，取消路径见 cancelAggregateConnect。
      aggregate.finish(world);
    } else if (state.gesture.kind === "drag" && state.gesture.moved && state.localPositions.size > 0) {
      // 拖动普通节点时按落点重父化 group；拖动 group 容器时成员关系不变
      // （change: add-canvas-node-grouping，design D3）。结果与位置更新、粘连边同一批次提交
      // （change: add-drag-touch-connections，design D4）。
      const gesture = state.gesture;
      const previews = state.localPositions;
      commitDragGesture(gesture, previews);
      state.localPositions = new Map();
    } else if (state.gesture.kind === "drag" && state.gesture.attach) {
      // 未移动但已锁定待提交边：只提交边，不提交无净变化的位置更新（design D4）。
      drag.commit(state.gesture, new Map());
    } else if (state.gesture.kind === "resize") {
      if (state.gesture.moved && state.localSizes.size > 0) {
        const [nodeId, size] = [...state.localSizes][0];
        // 地面范围对角锁定缩放可能同时改变中心（左/上方向），因此与尺寸一并提交 position（design D6）。
        // 预览是绝对画布坐标，提交前换算为持久化相对坐标（与 drag 提交同一换算）。
        const position = state.localPositions.get(nodeId);
        const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
        const index = sharedCanvasNodeIndex(canvasState);
        const parent = index?.parentAbsolutePosition(nodeId) ?? { x: 0, y: 0 };
        const relativePosition = position ? { x: position.x - parent.x, y: position.y - parent.y } : undefined;
        const commands = planResizeNode({ nodeId, width: size.width, height: size.height, ...(relativePosition ? { position: relativePosition } : {}) });
        // 组四角缩放：成员保持画布绝对位置。框原点移动了多少，成员的局部坐标就反向补多少，
        // 同一批次原子提交（成员若越界会让整批被拒绝，因此跳过不可移动的片场对象模型）。
        const origin = state.gesture.origin;
        if (state.gesture.corner && position && origin && index) {
          const dx = position.x - origin.x;
          const dy = position.y - origin.y;
          if (dx !== 0 || dy !== 0) {
            for (const childId of index.children.get(nodeId) ?? []) {
              const child = index.byId.get(childId);
              if (!child || isFilmSetObjectModelNode(child, canvasState?.nodeData[childId])) continue;
              commands.push({ type: "node.update", nodeId: childId, position: { x: child.position.x - dx, y: child.position.y - dy } });
            }
          }
        }
        submit(commands);
      }
      state.localSizes = new Map();
      state.localPositions = new Map();
    } else if (state.gesture.kind === "connect") {
      const hitResult = core.queryPoint(world, core.activeViewport().zoom);
      const hit = hitResult.ok ? hitResult.value : null;
      const connectSourceId = state.gesture.source;
      // 连线落点同样按「卡片本体」判定：拍摄镜头预览内容区是真实媒体卡片，不能被当成空白。
      const connectTargetId = cardHitNodeId(hit);
      if (connectTargetId !== null && connectTargetId !== connectSourceId) {
        const source = state.gesture.side === "output" ? connectSourceId : connectTargetId;
        const target = state.gesture.side === "output" ? connectTargetId : connectSourceId;
        // group 聚合输出：从 group 拉线时展开为每个可连接叶子成员的真实边
        // （change: add-canvas-node-grouping，design D5）。空批次不提交。
        const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
        const sourceNode = canvasState?.document.nodes.find((node) => node.id === source);
        if (sourceNode?.type === "group") {
          const nodes = canvasState!.document.nodes.map((node) => ({ ...node, position: { ...node.position }, data: {} }));
          const commands = planAggregateConnect(nodes, canvasState!.document.edges, source, target);
          if (commands.length > 0) submit(commands);
        } else if (writable()) {
          // 预检连接合法性并把拒绝原因反馈给用户（任务 8.2）：镜头参考等被拒组合不再静默失败。
          const nodes = canvasState?.document.nodes ?? [];
          const edges = canvasState?.document.edges ?? [];
          const nodeData = canvasState?.nodeData ?? {};
          const block = explainWoohaa3CanvasConnectionBlock(
            { source, target, sourceHandle: null, targetHandle: null },
            nodes,
            edges,
            { get: (id: string) => nodeData[id] as Record<string, unknown> | undefined }
          );
          if (block) options.onInteractionError?.(new Error(block));
          else submit(planConnectEdge({ source, target, sourceHandle: null, targetHandle: null }));
        }
      } else if (state.gesture.side === "output" && (!hit || hit.kind === "edge")) {
        const canvasState = woohaa3CanvasStore.getState().canvas;
        const sourceNode = canvasState?.document.nodes.find((node) => node.id === connectSourceId);
        if (sourceNode) {
          options.onConnectToEmpty?.({
            screen: { x: event.clientX, y: event.clientY },
            world,
            sourceNodeId: sourceNode.id,
            sourceNodeType: sourceNode.type
          });
        }
      }
      state.draft = null;
    } else if (state.gesture.kind === "marquee") {
      const marqueeResult = core.queryMarquee({
        x: state.gesture.start.x,
        y: state.gesture.start.y,
        width: state.gesture.current.x - state.gesture.start.x,
        height: state.gesture.current.y - state.gesture.start.y
      });
      if (marqueeResult.ok) {
        const ids = marqueeResult.value;
        // 完整框住某 group 的全部直接成员时规范化为选中该 group；部分选中只作用于成员
        // （change: add-canvas-node-grouping，design D4）。
        const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
        const normalized = canvasState
          ? normalizeWoohaa3CanvasGroupSelection(
              canvasState.document.nodes.map((node) => ({ ...node, data: {} })),
              ids
            )
          : ids;
        setSelection(normalized);
      }
    } else if (state.gesture.kind === "right-press") {
      // 短按右键不是平移：到这里才确定它是菜单（spec: kind 取 `context-menu`）。
      beginPerfGesture("context-menu");
      options.onContextMenu?.({
        screen: { x: event.clientX, y: event.clientY },
        world,
        node: state.gesture.nodeId ? { nodeId: state.gesture.nodeId } : null
      });
    } else if (state.gesture.kind === "pan") {
      if (state.viewportPreview) core.commitViewport(state.viewportPreview);
      state.viewportPreview = null;
    }
    } catch (error) {
      // 提交/回调失败不得卡住输入：记录但不中断，手势仍在 finally 复位。
      options.onInteractionError?.(error);
    } finally {
      // 提交阶段（可能含一次命令提交与状态收敛）单独记一段：它与指针移动是两种成本。
      perf.accumulateSince("gesture-commit", commitAt);
      // 无论提交/回调是否抛错，都必须复位指针捕获与手势，避免拖拽状态卡死
      // （change: 2026-10-09-improve-canvas-workflow，任务 1.7 回归）。
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // 指针可能已释放。
      }
      state.gesture = { kind: "none" };
      state.dropTargetGroupIds = [];
      state.localPositions = new Map();
      state.localSizes = new Map();
      // 手势结束必须"推进版本号"：覆盖层只在版本变化时重渲染，仅靠访问器返回空数组会留下旧线。
      setAlignmentGuides(state, []);
      schedule(releasedKind === "pan" ? "viewport" : "input");
      // 一次被消费的手势到此结束：未开门（被拒绝/横条动作/连线点空白）时是 no-op。
      finishPerfGesture();
    }
  };

  const { onPointerCancel, onBlur, onVisibilityChange } = createCancellationHandlers(
    core, () => cancelDragGesture(), () => aggregate.cancel()
  );

  const onPointerLeave = (event: PointerEvent) => {
    core.forgetHoverPointer();
    canvas.title = "";
    core.suspendHoverPlayback();
    core.clearHover();
    // 右键按下时浏览器会补发 pointerleave（准备弹出菜单）。这时按钮仍按着，
    // 不能取消正在进行的镜头旋转。
    if (model.active && event.buttons === 0) core.clearHeldKeys();
  };

  const onWheel = createWheelEntryHandler(core, viewport);
  const contextMenu = createContextMenuFallback(core, onPointerUp);
  const family = {
    dispose: () => {
      drag.cancel();
      aggregate.cancel();
      // 卸载时结算未收尾的滚轮段（不丢事实，也不让定时器活到画布之外）。
      onWheel.flushPerfBurst();
    },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onContextMenu: contextMenu.handle,
    onPointerCancel: (event: PointerEvent) => { contextMenu.cancel(); onPointerCancel(event); },
    onPointerLeave,
    onWheel,
    onBlur: () => { contextMenu.cancel(); onBlur(); },
    onVisibilityChange: () => {
      // 页面隐藏：视口帧不再画，滚轮段到此为止（不把隐藏期的空闲算进这次输入的耗时）。
      onWheel.flushPerfBurst();
      onVisibilityChange();
    },
    /** 视口手势模块（供 controller 转发缩放按钮与预览提交）。 */
    viewport,
    /** 视口缩放（右下角控件）；委托 viewport 模块。 */
    zoomBy: (factor: number) => viewport.zoomBy(factor),
    zoomTo: (zoom: number) => viewport.zoomTo(zoom),
    zoomToFit: () => viewport.zoomToFit(),
    /** Q/E held 路由；只有带粘连子状态的拖动消费（change: add-drag-touch-connections，D2）。 */
    onAttachKey: (code: "KeyQ" | "KeyE", down: boolean) => drag.onAttachKey(code, down),
    /** 当前拖动是否带粘连子状态（键盘路由据此决定是否消费 Q/E）。 */
    attachActive: () => drag.attachActive(),
    /** working canvas 更新时清理失效 contact/pending（design D6）；返回是否变化。 */
    pruneAttach: (): boolean => drag.prune(),
    /** 取消完整拖动粘连手势（modal pre-open / dispose / host）。 */
    cancelDragGesture: () => drag.cancel(),
    /** 当前拖动粘连瞬时投影；无或未越过移动阈值时 `null`（design D5）。 */
    attachProjection: () => drag.projection(),
    /** 当前聚合把手瞬时投影；无把手时 `null`（change: add-multi-select-aggregate-connect）。 */
    aggregateProjection: () => aggregate.projection(),
    /** 是否处于聚合拉线拖拽。 */
    aggregateActive: () => state.gesture.kind === "aggregate-connect",
    /** 取消聚合拉线手势（modal pre-open / dispose / host）。 */
    cancelAggregateConnect: () => aggregate.cancel()
  };
  return family;
}
