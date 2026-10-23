import { useRef, useEffect, useCallback, useSyncExternalStore, useState, useMemo } from "react";
import { PhotoEditorApp } from "../../photo-editor-app.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorPreview } from "../../editor-wasm.js";
import { Button } from "../../ui/Button.js";
// 子文档作用域内的样式：把宿主定位规则还原成正常流，避免嵌套编辑器被裁切。
import "./smart-child.css";

function SmartChildPreviewCanvas({ preview, origin, zoom }: { preview: EditorPreview | null; origin: { x: number; y: number }; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !preview) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0);
  }, [preview]);
  return preview ? <canvas ref={ref} className="photo-editor__smart-child-preview" style={{ left: origin.x, top: origin.y, width: preview.width * zoom, height: preview.height * zoom }} /> : null;
}

/** 以弹层自身尺寸适配子文档；测不到尺寸（首帧/测试环境）时退回窗口估算。 */
function fitZoom(host: HTMLElement | null, width: number, height: number): number {
  const availableWidth = host && host.clientWidth > 0 ? host.clientWidth - 32 : window.innerWidth - 520;
  const availableHeight = host && host.clientHeight > 0 ? host.clientHeight - 96 : window.innerHeight - 300;
  const fit = Math.min(1, availableWidth / width, availableHeight / height);
  return Math.max(0.05, Number.isFinite(fit) ? fit : 1);
}

export function SmartChildEditor({ parent, child, onChanged }: { parent: EditorWorkspaceController; child: EditorWorkspaceController; onChanged: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const snapshot = useSyncExternalStore(
    useCallback((listener) => child.subscribe(listener), [child]),
    useCallback(() => child.snapshot(), [child])
  );
  const document = snapshot.view.document;
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  useEffect(() => {
    if (!document) return;
    const rendered = child.render(2048);
    if (rendered.ok) setPreview(rendered.value);
    setViewport({ x: 0, y: 0, zoom: fitZoom(host.current, document.width, document.height) });
  }, [child, document?.revision, document?.width, document?.height]);
  const canvasView = useMemo(() => ({
    contentSize: { width: document?.width ?? 0, height: document?.height ?? 0 },
    viewport,
    fitZoom: 1,
    transitioning: false,
    onChange: setViewport
  }), [document?.height, document?.width, viewport]);
  const updateParent = () => {
    const result = parent.updateSmartParentFromChild(`ui-child-${document?.revision ?? 0}`);
    if (result.ok) onChanged();
  };
  return <div ref={host} className="photo-editor__smart-child" data-smart-child-editor="true">
    <header className="photo-editor__smart-child-header">
      <strong>智能对象子文档</strong>
      <span>{snapshot.state.dirty ? "有未保存修改" : "已载入"}</span>
      <Button size="sm" disabled={!document || !snapshot.state.dirty} onClick={updateParent}>更新父文档</Button>
      <Button size="sm" tone="ghost" onClick={() => parent.closeSmartChild()}>关闭子文档</Button>
    </header>
    <p className="photo-editor__smart-child-hint">正在编辑嵌入源；只有「更新父文档」才回写父对象，其他共享实例随之更新。</p>
    {document ? <PhotoEditorApp controller={child} canvasView={canvasView} onPreview={setPreview}
      renderCanvasBackground={(origin, zoom) => <SmartChildPreviewCanvas preview={preview} origin={origin} zoom={zoom} />} />
      : <p className="photo-editor__smart-child-loading">正在打开子文档…</p>}
  </div>;
}
