/**
 * 画布 ↔ 矢量归约器的桥（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 画布本身只做坐标换算与指针捕获；本 hook 持有归约器状态、把命令按序提交，并把叠加层
 * 投影成 React 节点。这样 `photo-editor-canvas.tsx` 里没有第二套几何，也没有第二份节点编号。
 *
 * 三条不变量：
 * 1. **松手才提交**：拖动期间只建/改草稿，`up` 才产生命令（一次拖绘 = 一步历史）。
 * 2. **命令按序同步执行**：曲率钢笔的两条命令必须真的按顺序落到内核；任一失败即停止并提示。
 * 3. **读几何不写文档**：路径编辑的当前几何来自 `path.info`（只读），不靠前端重算贝塞尔。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import { isRecord } from "../shared/panels.js";
import { AnchorOverlay, PathOverlay, ShapeDragOverlay } from "./panels.js";
import { presetChoice } from "./preset-selection.js";
import { pathChoice, resolvePathTarget, subscribePathChoice } from "./path-selection.js";
import { requestShapeSize } from "./shape-options.js";
import {
  initialVectorGesture,
  isVectorToolGesture,
  reduceVectorGesture,
  reduceVectorKey,
  vectorTool,
  type VectorGestureOptions,
  type VectorGestureState,
  type VectorPointer,
} from "./vector-tools.js";
import type { EditablePath } from "./path-edit.js";
import type { PenPath } from "./pen-tools.js";

/** `path.info` 的返回（内核紧凑形态：`{name, path}`）。 */
function readPath(value: unknown): EditablePath | null {
  if (!isRecord(value) || !isRecord(value.path)) return null;
  const subpaths = value.path.subpaths;
  if (!Array.isArray(subpaths)) return null;
  const parsed = subpaths.flatMap((subpath) => {
    if (!isRecord(subpath) || !Array.isArray(subpath.knots)) return [];
    const knots = subpath.knots.flatMap((knot) => {
      if (!isRecord(knot)) return [];
      const point = (input: unknown) => Array.isArray(input) && input.length === 2 && input.every(entry => typeof entry === "number")
        ? [input[0], input[1]] as [number, number]
        : null;
      const anchor = point(knot.anchor);
      if (!anchor) return [];
      const incoming = point(knot.in);
      const outgoing = point(knot.out);
      return [{
        anchor,
        ...(incoming ? { in: incoming } : {}),
        ...(outgoing ? { out: outgoing } : {}),
        ...(knot.smooth === true ? { smooth: true } : {}),
      }];
    });
    return [{ closed: subpath.closed === true, knots }];
  });
  return parsed.length ? { subpaths: parsed } : null;
}

/**
 * `path.info` 形态 → 钢笔续接形态。
 *
 * 钢笔的 `PenKnot` 要求 `in`/`out` 必填（缺省表示手柄与锚点重合），因此这里把缺失的手柄
 * 补成锚点本身；不复制第二套路径表示，只是同一份几何的字段补齐。
 */
function readPenPath(value: unknown): PenPath | null {
  const path = readPath(value);
  if (!path) return null;
  return {
    subpaths: path.subpaths.map(subpath => ({
      closed: subpath.closed === true,
      knots: subpath.knots.map(knot => ({
        anchor: [knot.anchor[0], knot.anchor[1]],
        in: knot.in ? [knot.in[0], knot.in[1]] : [knot.anchor[0], knot.anchor[1]],
        out: knot.out ? [knot.out[0], knot.out[1]] : [knot.anchor[0], knot.anchor[1]],
        smooth: knot.smooth === true,
      })),
    })),
  };
}

/**
 * 当前路径编辑目标。
 *
 * 形状层与矢量蒙版都用 `name: "layer"` + 图层 id（内核同一实现）；工作/已存路径用名字。
 * 目标图层不是形状层也没有矢量蒙版时，`path.info` 会失败——此时不硬编造路径，直接不显示锚点。
 */
function pathTarget(layer: number | null, kind: string | undefined, hasMask: boolean, choice: string): { name: string; layer?: number } | { name: string } {
  return resolvePathTarget(choice, layer, layer !== null && (kind === "shape" || hasMask));
}

export type VectorCanvasBridge = {
  /** 叠加层节点（由 `renderOverlay` 插入画布）。 */
  overlay: (origin: { x: number; y: number }, zoom: number) => ReactNode;
  /** 指针入口；`samples` 只在自由钢笔拖动时使用。 */
  pointer: (pointer: VectorPointer, samples?: readonly (readonly [number, number])[]) => void;
  /** 键盘入口（Enter/Escape/Backspace/Delete）。返回 `true` 表示已消费。 */
  key: (key: "Enter" | "Escape" | "Backspace" | "Delete") => boolean;
  /** 是否有未完成的草稿/拖动（画布的 `hasGesture` 与 Esc 取消据此判断）。 */
  active: () => boolean;
  /** 取消草稿（工具切换、Esc、丢失指针捕获时调用）。 */
  cancel: () => void;
  /** 当前路径（供面板/测试只读查询）。 */
  path: EditablePath | null;
};

export function useVectorGesture(
  controller: EditorWorkspaceController,
  documentView: EditorViewModel["document"],
  tool: string,
  options: {
    /** 形状填充/描边（面板当前值）。 */
    fill: string | null;
    stroke?: Record<string, unknown> | null;
    /** 钢笔落点：工作路径/形状层/蒙版。 */
    penTarget: "work" | "shape" | "mask";
    /** 当前图层与尺寸（蒙版/形状目标的图层 id 与越界判定）。 */
    layer: number | null;
    canvas: readonly [number, number];
    zoom: number;
    /** 形状固定参数（圆角/边数/星形比例/线宽）。 */
    shapeOptions?: VectorGestureOptions["shapeOptions"];
    /** 只读时拒绝所有写入（读几何仍然允许）。 */
    readonly: boolean;
    onMessage: (message: string | null) => void;
  },
): VectorCanvasBridge {
  const enabled = isVectorToolGesture(tool);
  const [state, setState] = useState<VectorGestureState>(() => initialVectorGesture(tool));
  const stateRef = useRef(state);
  stateRef.current = state;
  const samples = useRef<[number, number][]>([]);
  const [path, setPath] = useState<EditablePath | null>(null);

  const layerKind = documentView?.layers.find(row => row.id === options.layer)?.kind;
  const activeLayerRow = documentView?.layers.find(row => row.id === options.layer);
  // 矢量蒙版与像素蒙版是两件事：`hasMask` 只表示像素蒙版，形状层的路径也算自身路径。
  const hasVectorPath = (activeLayerRow?.hasVectorMask ?? false) || layerKind === "shape";
  // 面板的路径目标（工作/当前图层/已存路径）参与解析：锚点编辑与钢笔落点必须与面板选的一致。
  const choice = useSyncExternalStore(
    useCallback(listener => subscribePathChoice(listener), []),
    useCallback(() => pathChoice(), []),
  );
  const target = pathTarget(options.layer, layerKind, hasVectorPath, choice);

  // 工具切换：丢弃上一件工具的草稿与叠加层（不产生命令）。
  useEffect(() => {
    setState(initialVectorGesture(tool));
    setPath(null);
    samples.current = [];
  }, [tool]);

  // 路径编辑的目标变化或文档修订变化后重读几何：命中必须基于**内核当前**路径。
  // 走 `handle.execute` 而不是 `dispatch`：`path.info` 是只读命令，不该触发 `afterWrite`
  // （不推进视图、不判定 dirty），读取几何与「写文档」必须分开。
  // 只读时也照读（只读采样不制造 dirty），这样锚点仍然可见；写入由 `pointer`/`key` 单独拒绝。
  // 钢笔也要读：续接要判断单击是否落在已有开放路径的末端。
  const revision = documentView?.revision ?? 0;
  const gesture = vectorTool(tool)?.gesture;
  useEffect(() => {
    if (gesture !== "path-edit" && gesture !== "pen") { setPath(null); return; }
    const handle = controller.editor();
    const result = handle?.execute("path.info", { name: target.name, ...(target.name === "layer" ? { layer: options.layer } : {}) });
    const next = result?.ok ? readPath(result.value) : null;
    setPath(next);
    // 选中路径工具后应当**立刻**看见锚点与手柄：否则用户必须先盲目点一下画布才知道路径在哪。
    // 只在还没进入拖动/草稿时投影，避免覆盖正在进行的交互状态。
    if (gesture === "path-edit" && next) {
      setState(current => current.dragging || current.overlay.kind === "pen"
        ? current
        : { ...current, overlay: { kind: "anchors", path: next, selection: current.selection ?? [], hover: null } });
    }
  }, [controller, tool, gesture, options.layer, target.name, revision]);

  const optionsFor = useCallback((): VectorGestureOptions => {
    const preset = presetChoice();
    // 钢笔的「续接」入口：工作路径或命名路径上已有几何时传进去，归约器只在终点一击时接上。
    const penTool = tool === "pen-freeform" || tool === "pen-curvature";
    const resumable = penTool && options.penTarget === "work" && target.name !== "layer" && path ? readPenPath({ path }) : null;
    return {
      canvas: options.canvas,
      zoom: options.zoom,
      fill: options.fill,
      ...(options.stroke ? { stroke: options.stroke } : {}),
      target: target.name === "layer" ? { name: "layer", layer: "layer" in target ? target.layer : null } : { name: target.name },
      path: vectorTool(tool)?.gesture === "path-edit" ? path : null,
      ...(options.shapeOptions ? { shapeOptions: options.shapeOptions } : {}),
      penTarget: options.penTarget,
      layer: options.layer,
      // 钢笔写「路径」时落到面板选的命名路径；`work`/`layer` 不是 `path.set` 的名字，
      // 图层自身路径由上面的 `penTarget` 通道处理，不能当路径名混传。
      ...(choice !== "work" && choice !== "layer" ? { pathName: choice } : {}),
      ...(resumable ? { continuePath: resumable } : {}),
      ...(preset ? { preset } : {}),
      ...(penTool ? { freehandPoints: samples.current } : {}),
      ...(tool === "path-select" ? { moveWholeSubpath: true } : {}),
    };
  }, [options, tool, path, target, choice]);

  /**
   * 提交一次手势产生的命令。
   *
   * 手势开始时捕获的文档代际令牌随每条命令回传：文档已切换/会话已重建时内核不被调用，
   * 晚到结果不会写进后来活动文档（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
   */
  const commit = useCallback((commands: { id: string; params: Record<string, unknown> }[]) => {
    const token = controller.token();
    for (const command of commands) {
      const result = controller.vectorCommand(command.id, command.params, token);
      if (!result.ok) { options.onMessage(result.message); return false; }
    }
    return true;
  }, [controller, options]);

  const pointer = useCallback((event: VectorPointer, collected?: readonly (readonly [number, number])[]) => {
    if (!enabled) return;
    if (event.type === "down") samples.current = [[event.point[0], event.point[1]]];
    else if (event.type === "move" && collected) samples.current.push(...collected.map(point => [point[0], point[1]] as [number, number]));
    const step = reduceVectorGesture(stateRef.current, event, optionsFor());
    setState(step.state);
    // 只读：选择/悬停这类纯界面状态照常更新（不写文档、不制造 dirty），
    // 但归约器产出的命令一律丢弃并明确提示，不能「先写后判只读」。
    if (options.readonly) {
      options.onMessage(step.result.commands.length ? "只读预览不允许修改" : step.result.message ?? null);
      return;
    }
    if (step.result.commands.length) commit(step.result.commands);
    options.onMessage(step.result.message ?? null);
    // 单击（零面积）= 打开尺寸输入，而不是留一条「什么都没发生」的提示（design D1）。
    if (step.result.sizeInput) requestShapeSize(step.result.sizeInput);
    // 形状/锚点提交后内核几何已变：重读路径，下一帧命中才不会用旧坐标。
    if (step.result.commands.length) {
      const handle = controller.editor();
      const result = handle?.execute("path.info", { name: target.name, ...(target.name === "layer" ? { layer: options.layer } : {}) });
      if (result?.ok) setPath(readPath(result.value));
    }
  }, [enabled, options, optionsFor, commit, controller, target]);

  const key = useCallback((pressed: "Enter" | "Escape" | "Backspace" | "Delete") => {
    if (!enabled) return false;
    const step = reduceVectorKey(stateRef.current, pressed, optionsFor());
    if (pressed === "Escape") { setState(step.state); options.onMessage(null); return true; }
    if (!step.result.commands.length) { setState(step.state); return true; }
    if (options.readonly) { options.onMessage("只读预览不允许修改"); return true; }
    setState(step.state);
    commit(step.result.commands);
    return true;
  }, [enabled, optionsFor, commit, options]);

  const cancel = useCallback(() => {
    setState(previous => ({ ...initialVectorGesture(previous.tool) }));
    samples.current = [];
  }, []);

  const active = useCallback(() => {
    const overlay = stateRef.current.overlay;
    return overlay.kind === "pen" || overlay.kind === "shape" || stateRef.current.dragging === true
      || (overlay.kind === "anchors" && (stateRef.current.selection?.length ?? 0) > 0);
  }, []);

  // 未结算的矢量草稿（形状拖绘中/钢笔未完成/锚点拖动）必须让保存、切标签与关闭看见，
  // 否则用户能在半截手势里保存或换文档。这里只登记「有/没有」，不复制手势状态。
  // 注意「选中了锚点」不算草稿：那只是选择，不影响保存。
  const drafting = state.overlay.kind === "pen" || state.overlay.kind === "shape" || state.dragging === true;
  useEffect(() => {
    controller.setVectorDraft(drafting);
  }, [controller, drafting]);
  useEffect(() => () => { controller.setVectorDraft(false); }, [controller]);

  const overlay = useCallback((origin: { x: number; y: number }, zoom: number) => {
    const gesture = stateRef.current.overlay;
    if (gesture.kind === "shape") {
      return <ShapeDragOverlay drag={gesture.drag} canvas={options.canvas} zoom={zoom} origin={origin}
        label={vectorTool(tool)?.label} />;
    }
    if (gesture.kind === "pen") {
      // 钢笔草稿：锚点 + 收回的手柄（与锚点重合时不画线）。
      const knots = gesture.draft.subpaths[gesture.draft.active]?.knots ?? [];
      return <PathOverlay points={knots.map(knot => knot.anchor)} closed={false} zoom={zoom} origin={origin}
        handles={knots.map(knot => ({ in: knot.in, out: knot.out }))} />;
    }
    if (gesture.kind === "anchors" && path) {
      return <AnchorOverlay path={path} zoom={zoom} origin={origin} selection={stateRef.current.selection ?? []}
        hover={stateRef.current.dragging ? null : gesture.hover} tolerance={6} />;
    }
    return null;
  }, [options.canvas, path, tool]);

  return useMemo(() => ({ overlay, pointer, key, active, cancel, path }), [overlay, pointer, key, active, cancel, path]);
}
