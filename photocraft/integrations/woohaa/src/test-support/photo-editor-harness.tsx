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

const canvasPort = vi.hoisted(() => ({ navigator:vi.fn(),navigate:vi.fn(),zoomTo:vi.fn(), view: vi.fn(), cancelGesture: vi.fn(() => false), hasGesture: vi.fn(() => false), selectionKey: vi.fn(() => false), props: null as PhotoCanvasProps | null }));
vi.mock("../../../../packages/editor/src/photo-editor-canvas.js", () => ({ PhotoCanvas: forwardRef(function StubCanvas(props: PhotoCanvasProps, ref) {
  canvasPort.props = props;
  useImperativeHandle(ref, () => canvasPort);
  return <div onClick={(event) => {const point={x:event.clientX,y:event.clientY};if(!props.selectionContains?.(point)) props.onSelectionClick?.(point);}} className="photo-editor-canvas" data-canvas="stub" data-tool={props.tool} data-selection={JSON.stringify(props.selectionOutline)}>{props.renderOverlay?.({x:0,y:0},0.5)}</div>;
}) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); localStorage.removeItem("woohaa.image-editor.panels.v1"); localStorage.removeItem("woohaa.image-editor.workspace-visibility.v1"); vi.unstubAllGlobals(); canvasPort.cancelGesture.mockReturnValue(false); canvasPort.hasGesture.mockReturnValue(false); canvasPort.selectionKey.mockReturnValue(false); });

export function setup(readonly = false, options: { hover?:import("@woohaa3/photocraft-editor").MoveHover; missingFonts?:string[]; hasSelection?: boolean; dirty?: boolean; onApply?: () => void; document?: Record<string, unknown>; maskCommands?: boolean; fillCommands?: boolean; dialogs?: DialogService; onDetailPreview?:(frame:import("@woohaa3/photocraft-editor").DetailFrame|null)=>void; zoom?:number; documents?:import("@woohaa3/photocraft-editor").EditorDocumentsMenu } = {}) {
  const view = decodeEditorState({ document: {
    width: 800, height: 600, activeLayer: 1, hasSelection: options.hasSelection ?? false, selectionOutline: [[10, 20, 50, 20], [50, 20, 50, 60], [50, 60, 10, 60], [10, 60, 10, 20]], canUndo: true, canRedo: true,
    history: ["打开", "新建图层", "画笔"], redoHistory: ["重命名", "蒙版"], layers: [
      { id: 1, name: "背景", kind: "raster", opacity: 1, blend: "Normal" }
    ], ...options.document
  } })!;
  const snapshot = { view, commands: new Map([["select.deselect", { enabled: true }], ["select.all", { enabled: true }]]), state: { phase: "editing", dirty: options.dirty ?? false, message: null } };
  if (options.maskCommands) for (const operation of ["revealAll","hideAll","revealSelection","hideSelection","apply","delete"]) snapshot.commands.set(`layer.layerMask.${operation}`, {enabled:true, allowed:true} as never);
  if (options.dialogs) snapshot.commands.set("layer.new.layer", {enabled:true, allowed:true} as never);
  if (options.fillCommands) for (const entry of FILL_SHORTCUTS) snapshot.commands.set(entry.id, {enabled:true,allowed:true} as never);
  const dispatch = vi.fn((_id:string,_params:unknown=null) => ({ ok: true, value: view }));
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
    checkpointText:vi.fn(()=>({ok:true,value:{layer:1,new:false,text:nativeText}})),
    commitText: vi.fn(()=>({ok:true,value:view})), cancelText:vi.fn()
  };
  const adjustmentPort={beginAdjustment:vi.fn(()=>({ok:true,value:{}})),previewAdjustment:vi.fn(()=>({ok:true,value:{}})),
    commitAdjustment:vi.fn(()=>({ok:true,value:view})),cancelAdjustment:vi.fn(),curveGeometry:()=>({ok:true,value:Array.from({length:256},(_,i)=>i)})};
  const region=vi.fn((r:{width:number;height:number})=>({ok:true,value:{width:r.width,height:r.height,pixels:new Uint8Array(r.width*r.height*4)}}));
  const strokePort={beginStroke:vi.fn((_params:unknown)=>({ok:true})),appendStroke:vi.fn(()=>({ok:true})),commitStroke:vi.fn(()=>({ok:true,value:view})),cancelStroke:vi.fn()};
  const clipboardBoundsPort=vi.fn(():import("@woohaa3/photocraft-editor").EditorResult<[number,number,number,number]|null>=>({ok:true,value:null}));
  const navigatorPort=vi.fn(()=>({ok:false as const,code:"unavailable",message:"导航预览不可用"}));
  const histogramPort=vi.fn(()=>({ok:true as const,value:{channels:Array.from({length:4},()=>({bins:Array.from({length:256},(_,i)=>i===0?1:0),mean:0,stdDev:0,median:0,samples:1})),pixels:480000,cacheLevel:3}}));
  const infoPort=vi.fn((_params:import("@woohaa3/photocraft-editor").InfoRequest)=>({ok:true,value:{rgb:[51,102,153],cmyk:[67,33,0,40],position:[4,5],selectionSize:null,documentSize:[800,600]}}));
  const samplePort=vi.fn((_x:number,_y:number,_options?:{size:number;sampleLayer:string})=>({ok:true,value:"#336699"}));
  const hoverPort=vi.fn(()=>({ok:true,value:options.hover??null}));
  const controller = {
    moveHoverAt:hoverPort,
    sampleColor:samplePort,
    missingFonts:()=>({ok:true,value:options.missingFonts??[]}),
    selectionContains:(x:number,y:number)=>({ok:true,value:!!view.document?.hasSelection && x>=10 && x<50 && y>=20 && y<60}),
    pickLayerAt:vi.fn(()=>({ok:true,value:1})),
    canDispatchCommands:()=>true,
    patternLibrary:()=>({ok:true,value:{presets:[]}}),
    renderRegion:region,
    // 与实现一致：宿主命名弹窗只在控制器空闲时提供可信 owner（change: 2026-10-18-fix-functional-audit-findings D01）。
    dialogOwner: () => ({ canvasId: "canvas-test", nodeId: "node-test", sessionId: "session-test" }),
    snapshot: () => snapshot, subscribe: () => () => undefined,
    clipboardBounds:clipboardBoundsPort,navigatorPreview:navigatorPort,histogram:histogramPort,infoReadout:infoPort,render: () => ({ ok: false }), dispatch, ...transform, ...textPort, ...adjustmentPort, ...strokePort
  } as unknown as EditorWorkspaceController;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (readonly: boolean) => act(() => root.render(<><PhotoEditorApp controller={controller} canvasView={{ contentSize:{width:800,height:600},viewport: { x: 0, y: 0, zoom: options.zoom??0.5 }, fitZoom: 0.5, transitioning: false, onChange: vi.fn() }} onPreview={vi.fn()} onDetailPreview={options.onDetailPreview} readonly={readonly} onApply={options.onApply} dialogs={options.dialogs} documents={options.documents} />{options.dialogs ? <DialogHost dialogs={options.dialogs} /> : null}</>));
  render(readonly);
  return { clipboardBoundsPort,navigatorPort,histogramPort,container, dispatch, transform, textPort, adjustmentPort, render, snapshot,region,strokePort,samplePort,hoverPort,infoPort,controller };
}

export function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event));
  return event;
}

export { canvasPort };
