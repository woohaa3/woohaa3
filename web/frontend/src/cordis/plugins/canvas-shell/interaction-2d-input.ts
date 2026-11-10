import { createCancellationHandlers } from "./input/cancellation.js";
import { createContextMenuFallback } from "./input/context-menu.js";
import { createHistoryClick } from "./input/history-click.js";
/**
 * 2D 画布 gesture family（pointer / wheel / 快捷键 / 双击）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；design D2）。
 *
 * 从 `interaction-controller` 拆出的基础 2D 手势：拖拽、尺寸、连线、框选、平移、视口滚轮、
 * 右键菜单、双击预览。只通过 `InteractionCore` 访问共享坐标系、调度与提交，不自建监听。
 */
import { modelPreviewPointerDown, modelPreviewPointerMove } from "./input/model-preview.js";
import { bevyKindForNodeType, effectiveCanvasNodeSize, builtinNodeCapabilityResolver, decodeWorkflowGroupData, explainWoohaa3CanvasConnectionBlock } from "@woohaa3/contracts";
import { nodeSize, cardHitNodeId, type Point } from "./hit-test.js";
import { planConnectEdge, planResizeNode } from "../../../extension-api/command-planner.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { createWheelViewport } from "./interaction-viewport.js";
import { resizeTarget as resizeTargetHelper } from "./interaction-2d-helpers.js";
import { createDragAttachState, isDragAttachConnectable } from "./drag-attach.js";
import { createDragGestureFamily } from "./drag-gesture.js";
import { applyDragAlignment, setAlignmentGuides } from "./alignment-snap.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { createAggregateConnectFamily } from "./aggregate-connect.js";
import { mergeMarqueeSelection, shouldUseWorldModelPick } from "../canvas-runtime/model-world-presentation.js";
import { commitPressSelection, noteSelectionPress } from "./input/selection/apply.js";
import { resolveContextSelection, resolvePressSelection } from "./input/selection/press.js";
import { cardPointerTarget, groundAreaCandidates, hasWorldObject, pickedWorldTarget } from "./input/selection/target.js";
import { createWorldCameraGestureFamilyFromOptions } from "./world-camera-gesture.js";
import { createWorldObjectPress } from "./world-object-press.js";
import { createWorldGroundGestureFamily } from "./world-ground-gesture.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import { createWheelEntryHandler } from "./input/wheel-entry.js";
import { createPerfInputRecorder, type PerfMoment } from "./input/perf-interaction.js";
import { telemetryNow } from "../../services/telemetry-primitives.js";
import { sceneAreaCursorTargets, sceneAreaEdgeCursor, workflowGroupCursor, workflowGroupInteraction, resizeCursorForEdge } from "./scene-area-cursor.js";
/** 右键位移阈值：小于它视为短点击（开菜单），达到则进入平移并抑制菜单。 */
const RIGHT_CLICK_PAN_THRESHOLD_PX = 10;

export function create2dInputFamily(core: InteractionCore) {
  const { options, canvas, writable, state, model, setSelection, submit, schedule } = core;
  const viewport = createWheelViewport(core);
  const aggregate = createAggregateConnectFamily(core);
  const history = createHistoryClick(core);
  let groundClick: { pointerId: number; x: number; y: number; candidates: string[] } | null = null;

  // 导演区边缘 hover：指针反馈不是手势，不进入 state；只在画布元素上设 CSS cursor。
  const setCursor = (next: string) => {
    // 测试/无 DOM host 可能只提供最小 canvas stub；cursor 是纯呈现，缺失时静默跳过。
    const style = canvas.style;
    if (!style) return;
    if (style.cursor !== next) style.cursor = next;
  };
  let cursorCanvas: ReturnType<typeof workingCanvasOf> = null;
  let cursorAreas: ReturnType<typeof sceneAreaCursorTargets> = [];
  let cursorGroups = new Map<string, { x: number; y: number; width: number; height: number }>();
  const sceneAreaTargets = () => {
    const current = workingCanvasOf(woohaa3CanvasStore.getState());
    if (current !== cursorCanvas) {
      cursorCanvas = current;
      cursorAreas = current ? sceneAreaCursorTargets(current) : [];
      cursorGroups = new Map();
      if (current) {
        const index = sharedCanvasNodeIndex(current);
        for (const node of current.document.nodes) {
          if (node.type !== "workflow-group-2d") continue;
          const position = index?.absolutePosition(node.id);
          if (position) cursorGroups.set(node.id, { ...position, ...effectiveCanvasNodeSize(node) });
        }
      }
    }
    return cursorAreas;
  };
  const updateHoverCursor = (event: PointerEvent, world: Point, hit: import("./hit-test.js").HitTarget | null) => {
    if (!writable()) return setCursor("");
    const areas = sceneAreaTargets();
    const groupCursor = workflowGroupCursor(cursorGroups, hit, world, core.activeViewport().zoom);
    if (groupCursor) return setCursor(groupCursor);
    if (hit?.kind === "node" && areas.some(area => area.nodeId === hit.nodeId)) return setCursor("grab");
    // Visible content and controls occlude the ground scopes.
    if (hit?.kind === "edge" || hit?.kind === "edge-delete" || hit?.kind === "port") return setCursor("pointer");
    if (hit) return setCursor("");
    if (areas.length === 0) return setCursor("");
    const point = { x: event.clientX, y: event.clientY };
    const ground = core.queryWorldGround(point);
    if (!ground) return setCursor("");
    const near = core.queryWorldGround({ x: point.x + 12, y: point.y });
    const tolerance = near
      ? Math.max(0.06, Math.hypot(near.u - ground.u, near.v - ground.v))
      : 0.18;
    const preferredNodeId = state.selected.length === 1 ? state.selected[0]! : null;
    setCursor(sceneAreaEdgeCursor({ areas, ground, tolerance, preferredNodeId }) ?? "");
  };

  const drag = createDragGestureFamily(core);
  const worldCamera = createWorldCameraGestureFamilyFromOptions(core, options);
  /** 共享世界模型的直接地面拖动（无卡片，只写瞬时世界位移预览）。 */
  const worldGround = createWorldGroundGestureFamily(core);
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

  const resizeTarget = (
    gesture: Extract<Gesture, { kind: "resize" }>,
    world: Point
  ): { width: number; height: number; position?: Point } | null => resizeTargetHelper(gesture, world, options.nodeCapabilities);

  const commitDragGesture = drag.commit;
  /** 取消路径：手势作废，性能事实按 `cancelled` 结算（不记成 success）。 */
  const cancelDragGesture = (): void => {
    finishPerfGesture("cancelled");
    worldGround.cancel();
    worldCamera.cancel();
    drag.cancel();
  };

  /** 3D 对象按下：镜头平移/Alt 旋转；世界模型复用地面拖动。 */
  const beginWorldObjectPress = createWorldObjectPress({
    state,
    setSelection,
    schedule,
    worldGround,
    worldCamera,
    beginGesture: () => core.clearHover(),
    beginPerfGesture
  });

  const onPointerDown = (event: PointerEvent) => {
    groundClick = null;
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
    // Keep the press-time hover identity for renderer hit testing, then suspend
    // playback and clear transient feedback before starting a gesture.
    const pressedHoveredEdgeId = state.hoveredEdgeId;
    core.suspendHoverPlayback();
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

    // 导演区手势（T07）：区域卡片默认搬场景；地面边缘 / 显式模式只改范围。
    // 区域内空白在 `auto` 模式下返回 null，继续走既有 groundClick + 框选，不吞拖动框选。
    const sceneAreaGesture = core.sceneAreaGestures();
    // 显式「搬场景 / 仅调范围」是用户可见承诺：此时导演区优先于世界模型拾取，
    // 文案里的「区域内任意位置」才成立。auto 模式保持模型拾取优先，模型交互不回退。
    const sceneAreaFirst = !!sceneAreaGesture && sceneAreaGesture.mode() !== "auto";
    const trySceneAreaGesture = (): boolean => {
      // Shift 保留既有加选框选语义；导演区手势不抢占它。
      if (!sceneAreaGesture || isRight || event.shiftKey) return false;
      const hitNodeId = cardHitNodeId(hit);
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      const hitNode = hitNodeId ? canvasState?.document.nodes.find(node => node.id === hitNodeId) : undefined;
      const areaCardId = hitNode?.type === "scene-area" ? hitNode.id : null;
      if (!areaCardId && hit) return false;
      const started = sceneAreaGesture.begin({
        point: { x: event.clientX, y: event.clientY },
        areaNodeId: areaCardId,
        card: !!areaCardId,
        altKey: event.altKey,
        preferredAreaNodeId: canvasState?.document.nodes.find(node => state.selected.length === 1 && node.id === state.selected[0] && node.type === "scene-area")?.id ?? null
      });
      if (!started) return false;
      core.claimSceneAreaGesture("pointer");
      beginGesture();
      beginPerfGesture(started.intent === "move" ? "drag" : "resize");
      // Install the scene-area state before setSelection: without rAF (tests) or in a
      // synchronous subscriber, selection schedules a frame immediately and a "none"
      // gesture there would cancel the gesture we just started.
      const area = started.edge ? sceneAreaTargets().find(area => area.nodeId === started.areaNodeId) : undefined;
      const cursor = area && started.edge ? resizeCursorForEdge(area.bounds, started.edge) : undefined;
      state.gesture = {
        kind: "scene-area",
        pointerId: event.pointerId,
        areaNodeId: started.areaNodeId,
        intent: started.intent,
        cursor
      };
      setCursor(started.intent === "move" ? "grabbing" : state.gesture.cursor ?? "nwse-resize");
      if (!state.selected.includes(started.areaNodeId)) setSelection([started.areaNodeId]);
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return true;
    };
    if (sceneAreaFirst && trySceneAreaGesture()) return;

    // 先把卡片/模型预览归一成节点目标；容器优先级只读一次选择规则，后面 2D/3D 共用。
    const pressedCanvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const cardTarget = cardPointerTarget(pressedCanvas, hit);
    const cardNodeId = cardTarget?.nodeId ?? null;
    const cardPlan = !isRight && cardTarget
      ? resolvePressSelection({
          canvas: pressedCanvas,
          nodeId: cardTarget.nodeId,
          selected: state.selected,
          additive: event.shiftKey,
          via: cardTarget.via,
          scopeId: cardTarget.scopeId
        })
      : null;
    // 点击进入容器：组/导演区尚未被选中时，第一次点击先选中容器；容器已进入
    // （自身已选或同区已有兄弟）时直接落到子元素。
    if (cardTarget && cardPlan?.gesture === "scope") {
      commitPressSelection({
        state,
        nodeId: cardTarget.nodeId,
        plan: cardPlan,
        setSelection,
        x: event.clientX,
        y: event.clientY
      });
      event.preventDefault();
      return;
    }

    // 共享世界模型没有内容卡片（`chrome.kind === "none"`）；命中到的卡片矩形可能是迁移
    // 前的残留。只要节点是世界实例，就按世界模型处理：选中并可直接沿地面拖动。
    if (!isRight && cardTarget?.kind === "world-object") {
      beginWorldObjectPress(event, cardTarget.nodeId, cardPlan ?? undefined);
      return;
    }

    // 共享世界模型没有内容卡片；**空白命中**才补一次渲染器拾取（真实表面/空模型锚点），
    // 否则 auto 模式的 scene-area 会先把世界模型点击当成搬场景；同时不抢可见端口、
    // 连线、历史条与动作横条的命中。
    if (!hit && hasWorldObject(pressedCanvas) && shouldUseWorldModelPick({
      cardHitNodeId: cardNodeId,
      focusActive: model.active,
      modalActive: core.modalActive(),
      gestureActive: state.gesture.kind !== "none"
    }) && !isRight) {
      const pick = core.queryModelPick({ x: event.clientX, y: event.clientY }, core.surfaceSize());
      // 细长/带孔模型（如自行车）可能从模型表面的空隙穿过；点拾取未命中时，
      // 用指针周围极小的 AABB 框选补一次，避免“选中了却拖不动”。
      let pickedNodeId = pick.ok && pick.value ? pick.value.nodeId : null;
      if (!pickedNodeId) {
        const fallback = core.queryModelMarquee({
          x: event.clientX - 2,
          y: event.clientY - 2,
          width: 4,
          height: 4
        });
        if (fallback.ok) {
          const candidates = fallback.value.filter(id => pickedWorldTarget(pressedCanvas, id));
          if (candidates.length === 1) pickedNodeId = candidates[0]!;
        }
      }
      const pickedTarget = pickedWorldTarget(pressedCanvas, pickedNodeId);
      if (pickedTarget && pickedNodeId) {
        const plan = resolvePressSelection({
          canvas: pressedCanvas,
          nodeId: pickedNodeId,
          selected: state.selected,
          additive: event.shiftKey,
          via: pickedTarget.via,
          scopeId: pickedTarget.scopeId
        });
        if (plan.gesture === "scope") {
          // 世界模型没有卡片、只经渲染器拾取命中；同样先选中它所在的组/导演区。
          commitPressSelection({
            state,
            nodeId: pickedNodeId,
            plan,
            setSelection,
            x: event.clientX,
            y: event.clientY
          });
          schedule();
          event.preventDefault();
          return;
        }
        // Shift 由世界对象按下统一处理：只切换选择，不开始拖动。
        beginWorldObjectPress(event, pickedNodeId, plan);
        return;
      }
    }

    if (trySceneAreaGesture()) return;

    if (modelPreviewPointerDown(core, event, hit)) {
      // 已选模型预览旋转也是双击序列的一部分：记录按下前选区，保持双击语义一致。
      noteSelectionPress({
        state,
        nodeId: cardTarget?.nodeId ?? null,
        reason: "already-selected",
        x: event.clientX,
        y: event.clientY
      });
      return;
    }

    if (!hit && !isRight && !event.shiftKey) {
      const ground = core.queryWorldGround({ x: event.clientX, y: event.clientY });
      const candidates = groundAreaCandidates(workingCanvasOf(woohaa3CanvasStore.getState()), ground);
      if (candidates.length) groundClick = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, candidates };
    }

    if (isRight) {
      const nodeId = hit && "nodeId" in hit ? hit.nodeId : null;
      if (nodeId) {
        const plan = resolveContextSelection({
          canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
          nodeId,
          selected: state.selected
        });
        commitPressSelection({
          state,
          nodeId,
          plan,
          setSelection,
          x: event.clientX,
          y: event.clientY
        });
      }
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

    if (hit && hit.kind === "port") {
      beginGesture();
      beginPerfGesture("connect");
      state.gesture = { kind: "connect", pointerId: event.pointerId, source: hit.nodeId, side: hit.side };
      state.draft = { source: hit.nodeId, side: hit.side, x: world.x, y: world.y };
      canvas.setPointerCapture?.(event.pointerId);
      schedule();
      return;
    }

    // Scope borders resize from any side; the title alone starts the group move below.
    sceneAreaTargets();
    const groupPart = workflowGroupInteraction(cursorGroups, hit, world, core.activeViewport().zoom);
    if (!isRight && hit && "nodeId" in hit && !writable()
      && (cursorGroups.has(hit.nodeId) || cursorAreas.some(area => area.nodeId === hit.nodeId))) {
      if (!event.shiftKey) setSelection([hit.nodeId]);
      return;
    }
    if (!isRight && !event.shiftKey && groupPart?.intent === "resize" && hit && "nodeId" in hit) {
      const bounds = cursorGroups.get(hit.nodeId)!;
      beginGesture();
      beginPerfGesture("resize");
      state.gesture = { kind: "resize", pointerId: event.pointerId, nodeId: hit.nodeId,
        start: world, originWidth: bounds.width, originHeight: bounds.height,
        originPosition: { x: bounds.x, y: bounds.y }, edge: groupPart.edge, cursor: groupPart.cursor, moved: false };
      if (state.selected.length !== 1 || state.selected[0] !== hit.nodeId) setSelection([hit.nodeId]);
      setCursor(groupPart.cursor);
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (!isRight && hit?.kind === "node" && cursorGroups.has(hit.nodeId) && groupPart?.intent !== "move") {
      if (!event.shiftKey) setSelection([hit.nodeId]);
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
        beginGesture();
        beginPerfGesture("resize");
        state.gesture = {
          kind: "resize",
          pointerId: event.pointerId,
          nodeId: hit.nodeId,
          start: world,
          originWidth: startSize.width,
          originHeight: startSize.height,
          moved: false
        };
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    // 未选中的模型预览与普通卡片一样，先选择并拖动节点；Shift 保留选择操作。
    if (cardTarget && (cardTarget.kind === "card" || cardTarget.kind === "model-preview")) {
      const hitNodeId = cardTarget.nodeId;
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      commitPressSelection({
        state,
        nodeId: hitNodeId,
        plan: cardPlan ?? resolvePressSelection({
          canvas: canvasState,
          nodeId: hitNodeId,
          selected: state.selected,
          additive: event.shiftKey,
          via: cardTarget.via,
          scopeId: cardTarget.scopeId
        }),
        setSelection,
        x: event.clientX,
        y: event.clientY
      });
      // 结构/位置索引按 working 身份缓存（design D5）：selection/pan 不失效，pending/远端
      // 结构与位置变化会产生新对象并重建。避免每次按下复制带 data 的整表节点数组。
      const index = sharedCanvasNodeIndex(canvasState);
      const active = [...new Set(state.selected.includes(hitNodeId) ? state.selected : [hitNodeId])];
      // selection/gesture 初始化与绝对 origin 解析。
      const origins = new Map<string, { x: number; y: number }>();
      for (const id of active) {
        const start = index?.absolutePosition(id);
        if (start) origins.set(id, start);
      }
      // 2D 组整体移动：活动选择中任意 2D 组卡片都把成员并入同一批 origins（T07）。
      // 多选（组 + 其他卡片）同样按整组展开，避免拖动时把成员留在原地。
      // 成员关系来自规范 nodeData；普通节点拖动不受影响。
      const selectedGroupIds = active.filter(id => canvasState?.document.nodes.some(node => node.id === id && node.type === "workflow-group-2d"));
      for (const groupId of selectedGroupIds) {
        const group = decodeWorkflowGroupData(canvasState?.nodeData[groupId]?.workflowGroup2d);
        if (!group.ok) continue;
        for (const memberId of group.value.memberNodeIds) {
          if (origins.has(memberId)) continue;
          const member = canvasState?.document.nodes.find(node => node.id === memberId);
          if (!member || member.type === "workflow-group-2d") continue;
          const start = index?.absolutePosition(memberId);
          if (start) origins.set(memberId, start);
        }
      }
      // 单节点拖动粘连子状态（change: add-drag-touch-connections，design D1）：只在活动选择
      // 恰为一个可连接、可写节点时创建；多选 / 只读不提供粘连。
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
        origins,
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

    if (hit && (hit.kind === "edge" || hit.kind === "edge-delete")) {
      event.preventDefault();
      if (state.selectedEdgeId === hit.edgeId) {
        if (writable()) {
          submit([{ type: "edge.remove", edgeId: hit.edgeId }]);
          state.selectedEdgeId = null;
        }
      } else {
        setSelection([]);
        state.selectedEdgeId = hit.edgeId;
      }
      state.hoveredEdgeId = hit.edgeId;
      state.hoverPointer = { ...world };
      schedule();
      return;
    }

    if (!event.shiftKey && !groundClick) {
      commitPressSelection({
        state,
        nodeId: null,
        plan: { selection: [], reason: "empty", scopeId: null, gesture: "keep" },
        setSelection,
        x: event.clientX,
        y: event.clientY
      });
    }
    beginGesture();
    beginPerfGesture("marquee");
    state.gesture = {
      kind: "marquee",
      pointerId: event.pointerId,
      start: world,
      current: world,
      startClient: { x: event.clientX, y: event.clientY }
    };
    canvas.setPointerCapture?.(event.pointerId);
    schedule();
  };

  const updateResizePreview = (world: Point) => {
    if (state.gesture.kind !== "resize") return;
    const target = resizeTarget(state.gesture, world);
    state.gesture.moved = !!target;
    state.localSizes = target ? new Map([[state.gesture.nodeId, { width: target.width, height: target.height }]]) : new Map();
    if (state.gesture.edge) state.localPositions = target?.position
      ? new Map([[state.gesture.nodeId, target.position]]) : new Map();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (history.move(event)) return;
    if (modelPreviewPointerMove(core, event)) return;
    if (model.active) {
      setCursor("");
      model.moveFocusPointer(event);
      return;
    }
    // 世界模型地面拖动：只更新瞬时世界位移预览，不做命中/悬停结算。
    if (state.gesture.kind === "world-ground") {
      setCursor("grabbing");
      const moveAt = telemetryNow();
      worldGround.move(event);
      perf.accumulateSince("gesture-move", moveAt);
      return;
    }
    // 镜头视锥拖动：只更新瞬时位姿预览，不做命中/悬停结算。
    if (state.gesture.kind === "world-camera") {
      setCursor("grabbing");
      const moveAt = telemetryNow();
      worldCamera.move(event);
      perf.accumulateSince("gesture-move", moveAt);
      return;
    }
    // 同一事件只读一次 canvas 外框（design D1 分段 + 任务 5.2）；world 换算与 hover 结算共用。
    const bounds = core.readBounds();
    const world = core.pointerWorld(event, bounds);
    state.lastPointerWorld = world;
    // pointer 热路径只查询 Rust interaction snapshot，不扫描全场景或构建渲染快照。
    const hitResult = core.queryPoint(world, core.activeViewport().zoom, state.hoveredEdgeId);
    core.settlePointerHover(
      hitResult,
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      core.surfaceSize()
    );
    if (state.gesture.kind === "none") {
      if (hitResult.ok) updateHoverCursor(event, world, hitResult.value);
      else setCursor("");
      return;
    }
    if (state.gesture.kind === "scene-area") {
      setCursor(state.gesture.intent === "move" ? "grabbing" : state.gesture.cursor ?? "nwse-resize");
    } else if (state.gesture.kind === "resize") {
      setCursor(state.gesture.cursor ?? "nwse-resize");
    } else if (state.gesture.kind === "drag") {
      setCursor("grabbing");
    } else if (state.gesture.kind === "pan") {
      setCursor("grabbing");
    } else {
      setCursor("");
    }
    // 移动段的计时起点：一次 pointermove 只读一次时钟，后续分支共用。
    const moveAt = telemetryNow();
    if (state.gesture.kind === "scene-area") {
      core.sceneAreaGestures()?.update({ x: event.clientX, y: event.clientY });
      perf.accumulateSince("gesture-move", moveAt);
      schedule();
      return;
    }
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
      updateResizePreview(world);
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
    if (state.gesture.kind === "scene-area") {
      // 权威 prepare/commit 是异步的：释放后让运行时完成准备与提交；失败经统一错误出口，
      // 手势本身在 finally 复位，不会卡住输入。
      const runtime = core.sceneAreaGestures();
      runtime?.update({ x: event.clientX, y: event.clientY });
      void runtime?.end().then(result => {
        if (!result.ok) options.onInteractionError?.(new Error(result.message));
      }).catch(error => options.onInteractionError?.(error));
    } else if (state.gesture.kind === "aggregate-connect") {
      // change: add-multi-select-aggregate-connect：正常释放批量提交，取消路径见 cancelAggregateConnect。
      aggregate.finish(world);
    } else if (state.gesture.kind === "world-ground") {
      // 释放才写一次 `nodeData.patch{sharedWorldInstance}`；已在 move 里清掉预览，避免
      // 与提交后的 working 位置叠加造成双倍位移。未越过阈值时不提交。
      worldGround.commit(event);
    } else if (state.gesture.kind === "world-camera") {
      // 释放才经权威 `world-camera-save` 提交一次位姿（带 expectedSettingsVersion）；
      // 预览同样先清掉，避免与提交后的规范位姿叠加。
      worldCamera.commit(event);
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
      updateResizePreview(world);
      if (state.gesture.moved && state.localSizes.size > 0) {
        const [nodeId, size] = [...state.localSizes][0];
        const preview = state.localPositions.get(nodeId);
        const current = workingCanvasOf(woohaa3CanvasStore.getState());
        const source = current?.document.nodes.find(node => node.id === nodeId);
        // Convert the absolute preview back to the node's canonical parent coordinates.
        const position = preview && source?.position && state.gesture.originPosition ? {
          x: source.position.x + preview.x - state.gesture.originPosition.x,
          y: source.position.y + preview.y - state.gesture.originPosition.y
        } : undefined;
        submit(planResizeNode({ nodeId, width: size.width, height: size.height, position }));
      }
      state.localSizes = new Map();
    } else if (state.gesture.kind === "connect") {
      const hitResult = core.queryPoint(world, core.activeViewport().zoom);
      const hit = hitResult.ok ? hitResult.value : null;
      const connectSourceId = state.gesture.source;
      // 连线落点同样按「卡片本体」判定：拍摄镜头预览内容区是真实媒体卡片，不能被当成空白。
      const connectTargetId = cardHitNodeId(hit);
      if (connectTargetId !== null && connectTargetId !== connectSourceId) {
        const source = state.gesture.side === "output" ? connectSourceId : connectTargetId;
        const target = state.gesture.side === "output" ? connectTargetId : connectSourceId;
        if (writable()) {
          // 预检连接合法性并把拒绝原因反馈给用户（任务 8.2）：镜头参考等被拒组合不再静默失败。
          const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
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
      const click = groundClick;
      groundClick = null;
      if (click && click.pointerId === event.pointerId && Math.hypot(event.clientX - click.x, event.clientY - click.y) < 5) {
        const next = (click.candidates.indexOf(state.selected.length === 1 ? state.selected[0]! : "") + 1) % click.candidates.length;
        setSelection([click.candidates[next]!]);
      } else {
        const gesture = state.gesture;
        const marqueeResult = core.queryMarquee({
          x: gesture.start.x,
          y: gesture.start.y,
          width: world.x - gesture.start.x,
          height: world.y - gesture.start.y
        });
        // 世界模型没有内容卡片，2D 框选拿不到它们；用同一屏幕矩形补一次模型 AABB 框选。
        const modelResult = core.queryModelMarquee({
          x: gesture.startClient.x,
          y: gesture.startClient.y,
          width: event.clientX - gesture.startClient.x,
          height: event.clientY - gesture.startClient.y
        });
        if (marqueeResult.ok || modelResult.ok) {
          setSelection(mergeMarqueeSelection(
            marqueeResult.ok ? marqueeResult.value : [],
            modelResult.ok ? modelResult.value : []
          ));
        }
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
      // 镜头提交是异步的：卡片位置预览保留到权威 save/卡片命令完成，避免释放瞬间
      // 先闪回旧位置再跳到新位置。镜头手势自己按 nodeId 清理。
      if (releasedKind !== "world-camera") state.localPositions = new Map();
      state.localSizes = new Map();
      setCursor("");
      // 手势结束必须"推进版本号"：覆盖层只在版本变化时重渲染，仅靠访问器返回空数组会留下旧线。
      setAlignmentGuides(state, []);
      schedule(releasedKind === "pan" ? "viewport" : "input");
      // 一次被消费的手势到此结束：未开门（被拒绝/横条动作/连线点空白）时是 no-op。
      finishPerfGesture();
    }
  };

  const cancelSceneAreaGesture = () => {
    const runtime = core.sceneAreaGestures();
    if (!runtime?.active()) return;
    runtime.cancel();
    finishPerfGesture("cancelled");
  };
  const { onPointerCancel, onBlur, onVisibilityChange } = createCancellationHandlers(
    core, () => { cancelDragGesture(); cancelSceneAreaGesture(); }, () => aggregate.cancel()
  );

  const onPointerLeave = (event: PointerEvent) => {
    core.forgetHoverPointer();
    canvas.title = "";
    setCursor("");
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
      worldCamera.cancel();
      core.sceneAreaGestures()?.cancel();
      setCursor("");
      // 卸载时结算未收尾的滚轮段（不丢事实，也不让定时器活到画布之外）。
      onWheel.flushPerfBurst();
    },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onContextMenu: contextMenu.handle,
    onPointerCancel: (event: PointerEvent) => { contextMenu.cancel(); setCursor(""); onPointerCancel(event); },
    onPointerLeave,
    onWheel,
    onBlur: () => { contextMenu.cancel(); setCursor(""); onBlur(); },
    onVisibilityChange: () => {
      setCursor("");
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
