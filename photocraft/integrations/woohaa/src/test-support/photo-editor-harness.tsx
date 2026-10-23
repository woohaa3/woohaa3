// 画布替换为空组件，只验证工具、只读门禁和历史命令；不采集渲染结果。
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, vi } from "vitest";
import { PhotoEditorApp } from "@woohaa3/photocraft-editor";
import { decodeEditorState } from "@woohaa3/photocraft-editor";
import type { EditorWorkspaceController } from "@woohaa3/photocraft-editor";
import type { PhotoCanvasProps } from "@woohaa3/photocraft-editor";
import { DialogService } from "@woohaa3/frontend/plugin-api";
import { DialogHost } from "@woohaa3/frontend/plugin-api";
import { FILL_SHORTCUTS } from "@woohaa3/photocraft-editor";

const canvasPort = vi.hoisted(() => ({ view: vi.fn(), cancelGesture: vi.fn(() => false), hasGesture: vi.fn(() => false), selectionKey: vi.fn(() => false), props: null as PhotoCanvasProps | null, all: [] as PhotoCanvasProps[] }));
vi.mock("../../../../packages/editor/src/photo-editor-canvas.js", () => ({ PhotoCanvas: forwardRef(function StubCanvas(props: PhotoCanvasProps, ref) {
  // 并排时同一组件会被渲染多次：`props` 留最后一个，`all` 保留每次的入参（用于核对「两块画布
  // 各自拿到自己的取景与输入归属」）。
  canvasPort.props = props;
  canvasPort.all.push(props);
  useImperativeHandle(ref, () => canvasPort);
  return <div onClick={(event) => props.onSelectionClick?.({ x: event.clientX, y: event.clientY })} data-canvas="stub" data-tool={props.tool} data-selection={JSON.stringify(props.selectionOutline)}>{props.renderOverlay?.({x:0,y:0},0.5)}</div>;
}) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); localStorage.removeItem("woohaa.image-editor.panels.v1"); vi.unstubAllGlobals(); canvasPort.cancelGesture.mockReturnValue(false); canvasPort.hasGesture.mockReturnValue(false); canvasPort.selectionKey.mockReturnValue(false); canvasPort.all.length = 0; canvasPort.props = null; });

export function setup(readonly = false, options: {
  hasSelection?: boolean; dirty?: boolean; onApply?: () => void; document?: Record<string, unknown>;
  maskCommands?: boolean; fillCommands?: boolean; dialogs?: DialogService;
  onDetailPreview?: (frame: import("@woohaa3/photocraft-editor").DetailFrame | null) => void;
  zoom?: number; documents?: import("@woohaa3/photocraft-editor").EditorDocumentsMenu;
  features?: Record<string, unknown>; selections?: Record<string, unknown>; viewAids?: Record<string, unknown>;
  onRequestDocumentSlot?: (input: { bytes: Uint8Array; name: string }) =>
    { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
} = {}) {
  const view = decodeEditorState({ document: {
    width: 800, height: 600, activeLayer: 1, hasSelection: options.hasSelection ?? false, selectionOutline: [[10, 20, 50, 20], [50, 20, 50, 60], [50, 60, 10, 60], [10, 60, 10, 20]], canUndo: true, canRedo: true,
    history: ["打开", "新建图层", "画笔"], redoHistory: ["重命名", "蒙版"], layers: [
      { id: 1, name: "背景", kind: "raster", opacity: 1, blend: "Normal" }
    ], ...options.document
  } })!;
  const snapshot = { view, commands: new Map([["select.deselect", { enabled: true }], ["select.all", { enabled: true }]]), state: { phase: "editing", dirty: options.dirty ?? false, message: null } };
  if (options.maskCommands) for (const operation of ["revealAll","hideAll","revealSelection","hideSelection","apply","delete"]) snapshot.commands.set(`layer.layerMask.${operation}`, {enabled:true, allowed:true} as never);
  // 蒙版在场时内核才允许切换叠加查看；`\` 的按键回归需要这条命令可见。
  if (options.maskCommands) snapshot.commands.set("layer.toggleMaskOverlay", {enabled:true, allowed:true} as never);
  if (options.dialogs) snapshot.commands.set("layer.new.layer", {enabled:true, allowed:true} as never);
  if (options.fillCommands) for (const entry of FILL_SHORTCUTS) snapshot.commands.set(entry.id, {enabled:true,allowed:true} as never);
  const dispatch = vi.fn(() => ({ ok: true, value: view }));
  const transform = { beginMove: vi.fn(() => ({ ok: true, value: true })), beginTransform: vi.fn(() => ({ ok: true })), previewTransform: vi.fn(() => ({ ok: true })),
    commitTransform: vi.fn(() => ({ ok: true })), cancelTransform: vi.fn() };
  let nativeText = "";
  const textPort = {
    beginText: vi.fn((_placement: unknown) => {
      nativeText=view.document?.layers.find((layer)=>layer.active)?.text ?? "";
      return {ok:true,value:{layer:1,new:false,text:nativeText,...options.document?.activeTextStyle as object}};
    }),
    previewText: vi.fn((params: {text:string}) => {nativeText=params.text;return {ok:true,value:{layer:1,new:false,text:nativeText}};}),
    textGeometry: vi.fn((_params: unknown) => ({ok:true,value:{caret:[[10,20],[10,50]],selection:[],hit:1,next:0}})),
    commitText: vi.fn(()=>({ok:true,value:view})), cancelText:vi.fn()
  };
  const adjustmentPort={beginAdjustment:vi.fn(()=>({ok:true,value:{}})),previewAdjustment:vi.fn(()=>({ok:true,value:{}})),
    commitAdjustment:vi.fn(()=>({ok:true,value:view})),cancelAdjustment:vi.fn(),curveGeometry:()=>({ok:true,value:Array.from({length:256},(_,i)=>i)})};
  const region=vi.fn((r:{width:number;height:number})=>({ok:true,value:{width:r.width,height:r.height,pixels:new Uint8Array(r.width*r.height*4)}}));
  const brushLibrary = { snapshot: () => ({ list: { groups: [], presets: [] }, message: null }), refresh: vi.fn(), restore: vi.fn(), subscribe: () => () => undefined, previewPreset: () => null };
  const controller = {
    // 文件域面板（新建/复制/File Info）经 `features.files` 取会话；替身只给本域用到的方法。
    brushLibrary: () => brushLibrary,
    patternLibrary:()=>({ok:true,value:{presets:[]}}),
    renderRegion:region,
    // 与实现一致：宿主命名弹窗只在控制器空闲时提供可信 owner（change: 2026-10-18-fix-functional-audit-findings D01）。
    dialogOwner: () => ({ canvasId: "canvas-test", nodeId: "node-test", sessionId: "session-test" }),
    snapshot: () => snapshot, subscribe: () => () => undefined,
    // 本域面板在挂载时读一次视图，用于判定「当前快照属于哪份文档」；
    // 真实控制器一直提供这个方法（`EditorWorkspaceController.currentView`）。
    currentView: () => view,
    render: () => ({ ok: false }), dispatch, ...transform, ...textPort, ...adjustmentPort,
    features: { files: {}, channels: { channelSnapshot: () => ({ ok: false, message: "测试未提供通道数据" }) }, animation: { timelineInfo: () => ({ ok: false, message: "测试未提供时间轴数据" }) }, vectors: { vectorPresets: () => ({ ok: true, value: { groups: [], custom: [] } }) }, ...options.features, ...(options.selections ? { selections: options.selections } : {}) },
    canDeliverFiles: () => false,
    setVectorDraft: vi.fn(), hasActiveDraft: vi.fn(() => false), setCanvasToolDraft: vi.fn(), token: () => ({ generation: 0, session: 0 }),
    // 视图辅助（并排/多视图）是可选端口：只有用例给了夹具才提供，其余用例保持「宿主没有该端口」。
    ...(options.viewAids
      ? {
          viewAids: () => ({ ok: true, value: options.viewAids }),
          setViewAids: vi.fn((patch: Record<string, unknown>) => ({ ok: true, value: { ...options.viewAids, ...patch } })),
          snapPoint: vi.fn(() => ({ ok: true, value: { point: null } })),
        }
      : {})
  } as unknown as EditorWorkspaceController;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // 宿主视口是可变状态：并排用例要能模拟「状态栏/手势平移了活动画布」。
  let viewport: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: options.zoom ?? 0.5 };
  // 重渲染要保持调用方最近一次的只读状态，否则模拟改取景会把只读宿主又渲染成可写。
  let currentReadonly = readonly;
  const onChange = vi.fn((next: { x: number; y: number; zoom: number }) => { viewport = next; render(currentReadonly); });
  const render = (readonly: boolean) => {
    currentReadonly = readonly;
    return act(() => root.render(<><PhotoEditorApp controller={controller} canvasView={{ contentSize:{width:800,height:600},viewport, fitZoom: 0.5, transitioning: false, onChange }} onPreview={vi.fn()} onDetailPreview={options.onDetailPreview} readonly={readonly} onApply={options.onApply} dialogs={options.dialogs} {...(options.documents ? { documents: options.documents } : {})} {...(options.onRequestDocumentSlot ? { onRequestDocumentSlot: options.onRequestDocumentSlot } : {})} />{options.dialogs ? <DialogHost dialogs={options.dialogs} {...(options.documents ? { documents: options.documents } : {})} {...(options.onRequestDocumentSlot ? { onRequestDocumentSlot: options.onRequestDocumentSlot } : {})} /> : null}</>));
  };
  render(readonly);
  /** 模拟宿主改取景（状态栏缩放、快捷键、空格拖拽都走这条）。 */
  const setViewport = (next: { x: number; y: number; zoom: number }) => { viewport = next; render(readonly); };
  return { container, dispatch, transform, textPort, adjustmentPort, render, snapshot, region, setViewport, onChange };
}

export function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event));
  return event;
}

export { canvasPort };
