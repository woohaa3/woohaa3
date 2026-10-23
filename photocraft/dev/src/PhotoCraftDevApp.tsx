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
  PhotoEditorApp,
  type EditorPreview,
  type EditorViewport
} from "@woohaa3/photocraft-editor";
import {
  emptyRecentFileStore,
  recordRecentFile,
  removeRecentFile,
  type RecentFileEntry,
  type RecentFileStore
} from "@woohaa3/photocraft-protocol";
import { OPEN_RASTER_ACCEPT } from "@woohaa3/photocraft-protocol";
import { DevDialogPort, DevDialogHost } from "./dev-dialogs.js";
import { DevDocumentSession } from "./dev-session.js";
import { createDevController } from "./dev-controller.js";
import { devDocumentsMenu } from "./dev-documents.js";
import { DevWorkspace, type DevDocumentSlot } from "./dev-workspace.js";
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
  const sessions = useMemo(() => ({ A: new DevDocumentSession(), B: new DevDocumentSession() }), []);
  const dialogs = useMemo(() => new DevDialogPort(), []);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [viewport, setViewport] = useState<EditorViewport>({ x: 0, y: 0, zoom: 1 });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fitPending, setFitPending] = useState(false);
  /** 「文件 ▸ 打开文件…」复用顶部的图片输入框，不另开一个入口。 */
  const imageInput = useRef<HTMLInputElement>(null);

  // A/B 双文档：两个独立内核实例 + 一个工作区级剪贴板（见 `dev-workspace.ts`）。
  // 控制器先建、工作区后建（工作区要持有控制器），而保存/导出要读文档名——用 ref 打破这个环。
  const workspaceRef = useRef<DevWorkspace | null>(null);
  const controllers = useMemo(() => ({
    A: makeController(sessions.A, "A"),
    B: makeController(sessions.B, "B")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessions]);
  const workspace = useMemo(() => {
    const created = new DevWorkspace(controllers);
    workspaceRef.current = created;
    return created;
  }, [controllers]);
  const [activeSlot, setActiveSlot] = useState<DevDocumentSlot>("A");
  const controller = controllers[activeSlot];
  /**
   * 最近文件（U04）：只用于开发宿主验证接线。
   *
   * 索引只存身份与大小；字节单独放在 `recentBytes` 里，与正式宿主的分工一致
   * （浏览器不授予路径权限，记录可以跨会话保留而字节不能——这里干脆不落盘）。
   */
  const [recent, setRecent] = useState<RecentFileStore>(() => emptyRecentFileStore());
  const recentBytes = useRef(new Map<string, Uint8Array>());

  /** 记录一次真实打开（尺寸取自内核视图，视图未就绪时不记录）。 */
  function rememberRecent(slot: DevDocumentSlot, name: string, bytes: Uint8Array) {
    const document = controllers[slot].currentView().document;
    if (!document) return;
    const id = `dev-${crypto.randomUUID()}`;
    recentBytes.current.set(id, bytes);
    setRecent((store) => recordRecentFile(store, {
      id, name, width: document.width, height: document.height,
      byteLength: bytes.length, savedAt: Date.now()
    }));
  }

  /** 重开：只为验证「记录 + 字节 → 真的打开」，找不到字节就如实说需重新选择。 */
  function reopenRecent(entry: RecentFileEntry): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bytes = recentBytes.current.get(entry.id);
    if (!bytes) return Promise.resolve({ ok: false, reason: "该文件的字节已被释放，请重新导入" });
    const target = (["A", "B"] as const).find((slot) => !controllers[slot].editor());
    if (!target) return Promise.resolve({ ok: false, reason: "两个文档槽位都已被占用，请先关闭一个" });
    setBusy(true);
    return (async () => {
      try {
        const isProject = entry.name.toLowerCase().endsWith(".pcraft");
        const opened = isProject
          ? await controllers[target].openProject({ bytes, baseAssetId: `dev-${crypto.randomUUID()}` })
          : await controllers[target].openImage({ name: entry.name, assetId: `dev-${crypto.randomUUID()}`, bytes });
        if (!opened.ok) return { ok: false as const, reason: opened.message };
        workspace.setDocumentName(target, entry.name);
        workspace.activate(target);
        setActiveSlot(target);
        setFitPending(true);
        return { ok: true as const };
      } finally {
        setBusy(false);
      }
    })();
  }

  function makeController(session: DevDocumentSession, slot: DevDocumentSlot) {
    // 端口装配集中在 `dev-controller.ts`：那里可断言 `fileDelivery` 真的注入
    // （缺了它「文件 ▸ 导出 PNG…」会恒失败，菜单却看起来可用）。
    return createDevController({
      session,
      slot,
      download,
      // 保存的文件名按文档名（与「导出 PNG…」同一套推导），不再固定 `photocraft-A.*`。
      documentName: () => workspaceRef.current?.documentName(slot) ?? ""
    });
  }

  useEffect(() => () => { controllers.A.dispose(); controllers.B.dispose(); }, [controllers]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller])
  );
  const workspaceState = useSyncExternalStore(
    useCallback((listener) => workspace.subscribe(listener), [workspace]),
    useCallback(() => workspace.snapshot(), [workspace])
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
    // 打开前先问本域预检：暂缓格式（EXR/HDR…）与超预算/损坏字节必须给出内核的真实原因，
    // 而不是让共享解码链抛一句底层 codec 错误。预检不建文档、不改当前文档。
    // 预检需要内核句柄，因此先确保内核就绪（与 openImage 走同一条加载路径，不会重复加载）。
    const ready = await controller.ensureEditor();
    if (!ready.ok) return ready;
    const io = controller.features.io;
    if (typeof io.inspectOpenRaster === "function") {
      const inspected = io.inspectOpenRaster(bytes);
      if (!inspected.ok) return { ok: false, message: inspected.message };
    }
    workspace.setDocumentName(activeSlot, file.name);
    const opened = await controller.openImage({ name: file.name, assetId: `dev-${crypto.randomUUID()}`, bytes });
    if (opened.ok) rememberRecent(activeSlot, file.name, bytes);
    return opened;
  });
  const importProject = async (file: File) => run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    workspace.setDocumentName(activeSlot, file.name);
    const opened = await controller.openProject({ bytes, baseAssetId: `dev-${crypto.randomUUID()}` });
    if (opened.ok) rememberRecent(activeSlot, file.name, bytes);
    return opened;
  });
  const apply = async () => {
    const outcome = await controller.save();
    if (!outcome.ok) throw new Error(outcome.message);
  };

  const status = sessions[activeSlot].status();

  return (
    <div className="dev-shell">
      <header className="dev-header">
        <strong>PhotoCraft 独立开发宿主</strong>
        <label className="dev-file">
          导入图片
          <input ref={imageInput} type="file" accept={OPEN_RASTER_ACCEPT} disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importImage(file); }} />
        </label>
        <label className="dev-file">
          导入工程
          <input type="file" accept=".pcraft,application/octet-stream" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importProject(file); }} />
        </label>
        <span className="dev-documents" data-dev-documents="true">
          {(["A", "B"] as const).map((slot) => {
            const entry = workspaceState.slots.find((candidate) => candidate.slot === slot);
            return (
              <button key={slot} type="button" data-dev-document={slot} aria-pressed={activeSlot === slot}
                disabled={busy || (slot !== activeSlot && !entry?.open)}
                onClick={() => {
                  if (workspace.activate(slot)) {
                    setActiveSlot(slot);
                    setPreview(null);
                    setFitPending(true);
                  } else {
                    setMessage(workspace.currentMessage());
                  }
                }}>
                {slot} · {entry?.open ? `${entry.name || "未命名"}${entry.dirty ? " *" : ""} · rev ${entry.revision}` : "空"}
              </button>
            );
          })}
          <button type="button" data-dev-copy="true" disabled={busy || !document} onClick={() => {
            if (!workspace.copy()) setMessage(workspace.currentMessage());
            else setMessage(workspace.currentMessage());
          }}>复制到工作区</button>
          <button type="button" data-dev-paste="true" disabled={busy || !workspaceState.clipboard || !document}
            onClick={() => {
              if (!workspace.paste(false)) setMessage(workspace.currentMessage());
              else setMessage(workspace.currentMessage());
            }}>粘贴</button>
          <button type="button" data-dev-paste-in-place="true" disabled={busy || !workspaceState.clipboard || !document}
            onClick={() => {
              if (!workspace.paste(true)) setMessage(workspace.currentMessage());
              else setMessage(workspace.currentMessage());
            }}>原位粘贴</button>
        </span>
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
              key={activeSlot}
              controller={controller}
              documents={devDocumentsMenu({
                controller,
                documentName: document?.name,
                // 文件菜单（change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）：
                // 打开/保存/导出走同一个文档会话；导出与 Save for Web 由共享 App 接到本域面板。
                // 装配在 `dev-documents.ts`，菜单回调因此可在 node 下断言（不必点浏览器）。
                save: apply,
                openFile: () => imageInput.current?.click(),
                slots: workspaceState.slots,
                activeSlot,
                activate: id => {
                  if (!workspace.activate(id)) return false;
                  setActiveSlot(id);
                  setPreview(null);
                  return true;
                },
                report: setMessage,
                transfer: {enabled: !busy, onSelect: id => {
                  if (id === "edit.layerTransferCopy") workspace.copy();
                  else workspace.paste(id === "edit.layerTransferPasteInPlace");
                  setMessage(workspace.currentMessage());
                }}
              })}
              canvasView={canvasView}
              dialogs={dialogs}
              onPreview={onPreview}
              onApply={apply}
              renderCanvasBackground={(origin, zoom) => (
                <PreviewCanvas value={preview} origin={origin} zoom={zoom} />
              )}
              onRequestDocumentSlot={async ({ bytes, name }) => {
                // 宿主侧只落地字节：把新文档放进另一个空槽位，当前文档保持不变。
                const target = (["A", "B"] as const).find((slot) => !workspace.snapshot().slots.find((entry) => entry.slot === slot)?.open);
                if (!target) return { ok: false as const, reason: "两个文档槽位都已被占用，请先关闭一个" };
                setBusy(true);
                try {
                  const opened = await workspace.controller(target).openProject({ bytes, baseAssetId: `dev-${crypto.randomUUID()}` });
                  if (!opened.ok) return { ok: false as const, reason: opened.message };
                  workspace.setDocumentName(target, name);
                  // U04：新建的文档也进入最近文件（与导入走同一条记录路径）。
                  rememberRecent(target, `${name}.pcraft`, bytes);
                  workspace.activate(target);
                  setActiveSlot(target);
                  setFitPending(true);
                  return { ok: true as const };
                } finally {
                  setBusy(false);
                }
              }}
              recentFiles={recent}
              onReopenRecent={reopenRecent}
              onRemoveRecent={(id) => {
                recentBytes.current.delete(id);
                setRecent((store) => removeRecentFile(store, id));
              }}
              hasRecentBytes={(entry) => recentBytes.current.has(entry.id)}
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
