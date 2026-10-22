/**
 * PhotoCraft 独立开发宿主
 * （change: 2026-10-21-extract-photocraft-subproject，任务 4.3 / design D3/D6）。
 *
 * 只依赖子项目包和浏览器 API：真实 WASM 内核 → RGBA 预览 → Canvas 呈现。可导入图片或
 * `.pcraft` 工程、做基础编辑，并把同一修订的工程 + PNG 成对下载后重新打开。
 * 不启动 Woohaa backend、Canvas 服务或 Tauri，也不写入任何持久状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  EditorWorkspaceController,
  PhotoEditorApp,
  type EditorPreview,
  type EditorViewport
} from "@woohaa3/photocraft-editor";
import { DevDialogPort, DevDialogHost } from "./dev-dialogs.js";
import { DevDocumentSession } from "./dev-session.js";

function download(bytes: Uint8Array, name: string, type: string): void {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // 下载已由浏览器接管；释放 URL 不撤销正在进行的下载。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type PreviewState = { preview: EditorPreview; documentWidth: number; documentHeight: number };

function PreviewCanvas({ value, origin, zoom }: { value: PreviewState | null; origin: { x: number; y: number }; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    canvas.width = value.preview.width;
    canvas.height = value.preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    // 内核的预览是同一修订的 RGBA 字节；dev 宿主不做任何额外合成或色彩管理。
    context.putImageData(new ImageData(new Uint8ClampedArray(value.preview.pixels), value.preview.width, value.preview.height), 0, 0);
  }, [value]);
  return value ? (
    <canvas
      ref={canvasRef}
      className="dev-preview"
      data-dev-preview="true"
      style={{
        position: "absolute",
        left: origin.x,
        top: origin.y,
        width: value.documentWidth * zoom,
        height: value.documentHeight * zoom
      }}
    />
  ) : null;
}

export function PhotoCraftDevApp() {
  const session = useMemo(() => new DevDocumentSession(), []);
  const dialogs = useMemo(() => new DevDialogPort(), []);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [viewport, setViewport] = useState<EditorViewport>({ x: 0, y: 0, zoom: 1 });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fitPending, setFitPending] = useState(false);

  const controller = useMemo(() => new EditorWorkspaceController({
    session,
    dialogOwner: () => ({ canvasId: "dev", nodeId: "dev-image", sessionId: "dev-session" }),
    // dev 的 public 根是 `photocraft/assets`：字体在 `/fonts/...`，不是宿主的 `/assets/fonts/...`。
    assetUrl: (path) => path.replace(/^\/assets\//, "/"),
    save: async ({ artifacts, isCurrent }) => {
      if (!isCurrent()) return { ok: false, code: "closed", message: "编辑会话已结束", retriable: false };
      download(artifacts.project, "photocraft.pcraft", "application/octet-stream");
      download(artifacts.output, "photocraft.png", "image/png");
      return { ok: true };
    }
  }), [session]);

  useEffect(() => () => controller.dispose(), [controller]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller])
  );
  const document = snapshot.view.document;
  const documentWidth = document?.width ?? 0;
  const documentHeight = document?.height ?? 0;

  const onPreview = useCallback((next: EditorPreview, size: { width: number; height: number }) => {
    setPreview({ preview: next, documentWidth: size.width, documentHeight: size.height });
  }, []);

  // 打开后按容器尺寸做一次适合窗口；之后取景完全由用户手势决定。
  useEffect(() => {
    if (!fitPending || !documentWidth || !documentHeight) return;
    const fit = Math.min(1, (window.innerWidth - 420) / documentWidth, (window.innerHeight - 220) / documentHeight);
    setViewport({ x: 0, y: 0, zoom: Math.max(0.05, Number.isFinite(fit) ? fit : 1) });
    setFitPending(false);
  }, [fitPending, documentWidth, documentHeight]);

  const canvasView = useMemo(() => ({
    contentSize: { width: documentWidth, height: documentHeight },
    viewport,
    fitZoom: 1,
    transitioning: false,
    onChange: setViewport
  }), [documentWidth, documentHeight, viewport]);

  const run = async (operation: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await operation();
      if (!result.ok) setMessage(result.message ?? "操作失败");
      else setFitPending(true);
    } finally {
      setBusy(false);
    }
  };

  const importImage = async (file: File) => run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return controller.openImage({ name: file.name, assetId: `dev-${crypto.randomUUID()}`, bytes });
  });
  const importProject = async (file: File) => run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return controller.openProject({ bytes, baseAssetId: `dev-${crypto.randomUUID()}` });
  });
  const apply = async () => {
    const outcome = await controller.save();
    if (!outcome.ok) throw new Error(outcome.message);
  };

  const status = session.status();

  return (
    <div className="dev-shell">
      <header className="dev-header">
        <strong>PhotoCraft 独立开发宿主</strong>
        <label className="dev-file">
          导入图片
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importImage(file); }} />
        </label>
        <label className="dev-file">
          导入工程
          <input type="file" accept=".pcraft,application/octet-stream" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importProject(file); }} />
        </label>
        <span className="dev-status" data-dev-status={status.phase}>
          {busy ? "处理中…" : status.phase === "failed" ? "保存失败" : status.dirty ? "有未保存修改" : "已同步"}
          {document ? ` · ${document.width}×${document.height} · ${document.layers.length} 层 · rev ${document.revision}` : " · 未打开文档"}
          {status.baseline ? ` · 基线 ${status.baseline.slice(0, 8)}` : ""}
        </span>
      </header>
      {message ? <div className="dev-error" role="alert">{message}</div> : null}
      {snapshot.state.message && snapshot.state.phase === "unavailable" ? (
        <div className="dev-error" role="alert">
          {snapshot.state.message}（若为内核缺失，请先在子项目运行 <code>pnpm run wasm</code>）
        </div>
      ) : null}
      <main className="dev-main">
        <div className="dev-stage">
          {document ? (
            <PhotoEditorApp
              controller={controller}
              canvasView={canvasView}
              dialogs={dialogs}
              onPreview={onPreview}
              onApply={apply}
              renderCanvasBackground={(origin, zoom) => (
                <PreviewCanvas value={preview} origin={origin} zoom={zoom} />
              )}
            />
          ) : (
            <div className="dev-empty">
              <h1>导入一张图片或一个 .pcraft 工程开始编辑</h1>
              <p>这个宿主直接加载子项目的真实 WASM 内核，不连接任何后端服务。</p>
            </div>
          )}
        </div>
      </main>
      <DevDialogHost port={dialogs} />
    </div>
  );
}
