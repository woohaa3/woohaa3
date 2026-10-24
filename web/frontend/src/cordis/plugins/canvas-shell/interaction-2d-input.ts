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
import { bevyKindForNodeType, explainWoohaa3CanvasConnectionBlock, normalizeWoohaa3CanvasGroupSelection } from "@woohaa3/contracts";
import { nodeSize, type Point } from "./hit-test.js";
import { planAggregateConnect, planConnectEdge, planResizeNode } from "../../../extension-api/command-planner.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { createWheelViewport } from "./interaction-viewport.js";
import { resizeTarget as resizeTargetHelper, scopeResizeTarget, SCOPE_HANDLE_ORDER } from "./interaction-2d-helpers.js";
import { createDragAttachState, isDragAttachConnectable } from "./drag-attach.js";
import { createDragGestureFamily } from "./drag-gesture.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { createAggregateConnectFamily } from "./aggregate-connect.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import { createInteractionRecorder, defaultBuildIdentity, instrumentPointerHandlers, type InteractionRelease } from "./interaction-performance.js";
import { createInputSegments } from "./interaction-input-segments.js";
import { createWheelEntryHandler } from "./input/wheel-entry.js";
/** 右键位移阈值：小于它视为短点击（开菜单），达到则进入平移并抑制菜单。 */
const RIGHT_CLICK_PAN_THRESHOLD_PX = 10;

export function create2dInputFamily(core: InteractionCore) {
  const { options, canvas, writable, state, model, setSelection, submit, schedule } = core;
  const recorder = import.meta.env.DEV ? createInteractionRecorder(core.target, {
    identity: defaultBuildIdentity,
    resources: () => options.getRuntime()?.getResourceDiagnostics?.(),
    refreshDiagnostics: () => options.getRuntime()?.refreshWorkDiagnostics?.(),
    backgroundDiagnostics: () => options.getRuntime()?.backgroundWorkDiagnostics?.() ?? false,
    surface: () => {
      const size = core.surfaceSize();
      return { width: size.width, height: size.height };
    }
  }) : undefined;
  const viewport = createWheelViewport(core, recorder);
  const aggregate = createAggregateConnectFamily(core);
  const history = createHistoryClick(core);

  // 单次事件分段：pointer 按下与 wheel 进入各自 reset，互不污染（design D1）。
  const segments = createInputSegments(recorder);
  const { measure } = segments;
  let release: InteractionRelease | undefined;
  let commandId: number | undefined;
  const drag = createDragGestureFamily(core, measure, outcome => { release = outcome; }, (result, outcome) => { commandId = recorder?.observeCommand(result, outcome); });

  const resizeTarget = (    gesture: Extract<Gesture, { kind: "resize" }>,
    world: Point
  ): { width: number; height: number; position?: Point } | null =>
    gesture.mode === "scope" && gesture.handle && gesture.anchor
      ? scopeResizeTarget(
          { handle: gesture.handle, anchor: gesture.anchor, originCenter: gesture.originCenter, originWidth: gesture.originWidth, originHeight: gesture.originHeight },
          world
        )
      : resizeTargetHelper(gesture, world);

  const commitDragGesture = drag.commit;
  const cancelDragGesture = drag.cancel;

  const onPointerDown = (event: PointerEvent) => {
    contextMenu.begin();
    segments.reset();
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
    const world = measure("coordinatesMs", () => core.pointerWorld(event));
    state.lastPointerWorld = world;
    if (event.button !== undefined && event.button > 1 && !isRight) return;
    // 平移手势只用视口，不依赖命中几何：在任何查询之前处理。
    if (event.button === 1 || state.spacePressed) {
      beginGesture();
      state.gesture = { kind: "pan", pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    // 命中由 Rust interaction snapshot 计算（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    const hitResult = measure("hitQueryMs", () =>
      core.queryPoint(world, core.activeViewport().zoom, pressedHoveredEdgeId)
    );
    if (!hitResult.ok) {
      // 几何不可用/过期：不开始新手势（design D3）。
      return;
    }    const hit = hitResult.value;

    if (modelPreviewPointerDown(core, event, hit)) return;

    if (isRight) {
      const nodeId = hit && "nodeId" in hit ? hit.nodeId : null;
      if (nodeId && !state.selected.includes(nodeId)) setSelection([nodeId]);
      beginGesture();
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
      state.gesture = { kind: "connect", pointerId: event.pointerId, source: hit.nodeId, side: hit.side };
      state.draft = { source: hit.nodeId, side: hit.side, x: world.x, y: world.y };
      canvas.setPointerCapture?.(event.pointerId);
      schedule();
      return;
    }

    if (hit && hit.kind === "resize") {
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      const entry = canvasState?.document.nodes.find((node) => node.id === hit.nodeId);
      if (entry) {
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
        beginGesture();
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
          ...(anchorPoint ? { anchor: { x: anchorPoint[0], y: anchorPoint[1] } } : {})
        };
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    // 未选中的模型预览与普通卡片一样，先选择并拖动节点；Shift 保留选择操作。
    // 片场范围命中同样选择并整体拖动（change: 2026-10-08-make-film-set-model-only）。
    if (hit && (hit.kind === "node" || hit.kind === "model-preview" || hit.kind === "film-scope")) {
      if (event.shiftKey) {
        setSelection(
          state.selected.includes(hit.nodeId)
            ? state.selected.filter((id) => id !== hit.nodeId)
            : [...state.selected, hit.nodeId]
        );
      } else if (!state.selected.includes(hit.nodeId)) {
        setSelection([hit.nodeId]);
      }
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      const active = state.selected.includes(hit.nodeId) ? state.selected : [hit.nodeId];
      // 结构/位置索引按 working 身份缓存（design D5）：selection/pan 不失效，pending/远端
      // 结构与位置变化会产生新对象并重建。避免每次按下复制带 data 的整表节点数组。
      const index = sharedCanvasNodeIndex(canvasState);
      // selection/gesture 初始化与绝对 origin 解析（design D1 分段）。
      const origins = measure("selectionMs", () => {
        const starts = new Map<string, { x: number; y: number }>();
        const moving = new Set(active);
        for (const id of active) for (const childId of options.compositeAssets?.dragAlongNodeIds(canvasState, id) ?? []) moving.add(childId);
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
            const start = index?.absolutePosition(related);
            if (start) starts.set(related, start);
          }
        }
        return starts;
      });
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
    state.gesture = { kind: "marquee", pointerId: event.pointerId, start: world, current: world };
    canvas.setPointerCapture?.(event.pointerId);
    schedule();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (history.move(event)) return;
    segments.reset();
    if (modelPreviewPointerMove(core, event)) return;
    if (model.active) {
      model.moveFocusPointer(event);
      return;
    }
    // 同一事件只读一次 canvas 外框（design D1 分段 + 任务 5.2）；world 换算与 hover 结算共用。
    const bounds = measure("domRectMs", () => core.readBounds());
    const world = measure("coordinatesMs", () => core.pointerWorld(event, bounds));
    state.lastPointerWorld = world;
    // pointer 热路径只查询 Rust interaction snapshot，不扫描全场景或构建渲染快照。
    // 卡片外的片场模型 picking 仍驱动原有 hover 播放。
    const hitResult = core.queryPoint(world, core.activeViewport().zoom, state.hoveredEdgeId);
    core.settlePointerHover(
      hitResult,
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      core.surfaceSize()
    );
    if (state.gesture.kind === "none") return;
    if (state.gesture.kind === "right-press") {
      const distance = Math.hypot(event.clientX - state.gesture.startScreen.x, event.clientY - state.gesture.startScreen.y);
      if (distance >= RIGHT_CLICK_PAN_THRESHOLD_PX) {
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
      schedule("viewport");
      return;
    }
    if (state.gesture.kind === "drag") {
      const dx = world.x - state.gesture.start.x;
      const dy = world.y - state.gesture.start.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) state.gesture.moved = true;
      state.localPositions = new Map();
      for (const [id, origin] of state.gesture.origins) state.localPositions.set(id, { x: origin.x + dx, y: origin.y + dy });
      // 先更新位置覆盖，再基于包含覆盖的最新轻量 scene 求值接触（design D3）。
      const changedAttach = drag.evaluate();
      schedule(changedAttach ? "input" : "position-preview");
      return;
    }
    if (state.gesture.kind === "resize") {
      const target = resizeTarget(state.gesture, world);
      if (target) {
        state.gesture.moved = true;
        state.localSizes = new Map([[state.gesture.nodeId, { width: target.width, height: target.height }]]);
        // 地面范围左/上方向拖动同时改变中心：预览也提交 position，避免释放时跳变（design D6）。
        state.localPositions = target.position
          ? new Map([[state.gesture.nodeId, target.position]])
          : new Map();
      } else {
        state.localSizes = new Map();
        state.localPositions = new Map();
      }
      schedule();
      return;
    }
    if (state.gesture.kind === "connect") {
      state.draft = { source: state.gesture.source, side: state.gesture.side, x: world.x, y: world.y };
      schedule();
      return;
    }
    if (state.gesture.kind === "aggregate-connect") {
      aggregate.move(world);
      return;
    }
    if (state.gesture.kind === "marquee") {
      state.gesture.current = world;
      schedule();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    contextMenu.end(event);
    if (history.up(event)) return;
    commandId = undefined;
    release = state.gesture.kind === "drag" && state.gesture.moved ? "no-change" : "click";
    segments.reset();
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
        const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
        const parent = index?.parentAbsolutePosition(nodeId) ?? { x: 0, y: 0 };
        const relativePosition = position ? { x: position.x - parent.x, y: position.y - parent.y } : undefined;
        submit(planResizeNode({ nodeId, width: size.width, height: size.height, ...(relativePosition ? { position: relativePosition } : {}) }));
      }
      state.localSizes = new Map();
      state.localPositions = new Map();
    } else if (state.gesture.kind === "connect") {
      const hitResult = core.queryPoint(world, core.activeViewport().zoom);
      const hit = hitResult.ok ? hitResult.value : null;
      const connectSourceId = state.gesture.source;
      if (hit && (hit.kind === "node" || hit.kind === "model-preview") && hit.nodeId !== connectSourceId) {
        const source = state.gesture.side === "output" ? connectSourceId : hit.nodeId;
        const target = state.gesture.side === "output" ? hit.nodeId : connectSourceId;
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
      if (releasedKind === "drag") release = "release-error";
      options.onInteractionError?.(error);
    } finally {
      // 无论提交/回调是否抛错，都必须复位指针捕获与手势，避免拖拽状态卡死
      // （change: 2026-10-09-improve-canvas-workflow，任务 1.7 回归）。
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // 指针可能已释放。
      }
      state.gesture = { kind: "none" };
      state.localPositions = new Map();
      state.localSizes = new Map();
      schedule(releasedKind === "pan" ? "viewport" : "input");
    }
  };

  const { onPointerCancel, onBlur, onVisibilityChange } = createCancellationHandlers(
    core, cancelDragGesture, () => aggregate.cancel()
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

  const onWheel = createWheelEntryHandler(core, recorder, viewport, segments);
  const contextMenu = createContextMenuFallback(core, onPointerUp);
  const family = {
    dispose: () => {
      recorder?.dispose();
      drag.cancel();
      aggregate.cancel();
    },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onContextMenu: contextMenu.handle,
    onPointerCancel: (event: PointerEvent) => { contextMenu.cancel(); onPointerCancel(event); },
    onPointerLeave,
    onWheel,
    onBlur: () => { contextMenu.cancel(); onBlur(); },
    onVisibilityChange,
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
  // 采集只在开发构建注入（生产无 recorder，instrumentPointerHandlers 直接透传）。
  return import.meta.env.DEV ? instrumentPointerHandlers(family, recorder, () => state.gesture, () => model.active, segments.current, () => release, () => commandId) : family;
}
