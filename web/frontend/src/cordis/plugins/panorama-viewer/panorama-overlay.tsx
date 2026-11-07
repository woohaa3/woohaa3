import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPanoramaView, type PanoramaViewHandle } from "./panorama-view.js";
import { isEquirectangular, type PanoramaStore } from "./panorama-store.js";
import { frameDelta, isPanoramaKey, SHORTCUT_ROWS } from "./panorama-keys.js";
import { PanoramaToolbar } from "./panorama-toolbar.js";

type LoadState = "loading" | "ready" | "error";

/** 截图长边（像素）。 */
const CAPTURE_LONG_EDGE = 2048;

export type PanoramaActions = {
  /** 把截图存成画布上的新图片节点；失败返回原因。 */
  saveScreenshot(blob: Blob, baseName: string, sourceNodeId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 下载原图。 */
  download(url: string, baseName: string): Promise<void>;
};

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2000,
  background: "rgba(0, 0, 0, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};
const modal: CSSProperties = {
  position: "relative",
  width: "85vw",
  height: "85vh",
  borderRadius: 12,
  overflow: "hidden",
  background: "#1c1c1c",
  boxShadow: "0 2px 4px rgba(0,0,0,0.25), 0 4px 20px rgba(0,0,0,0.15)"
};
const topBar: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10,
  height: 56,
  padding: "0 16px",
  display: "flex",
  alignItems: "center",
  pointerEvents: "none"
};
const pill: CSSProperties = {
  height: 36,
  padding: "0 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.4)",
  color: "#fff",
  fontSize: 16,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  pointerEvents: "auto",
  userSelect: "none"
};
const closeButton: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  border: 0,
  background: "rgba(0,0,0,0.4)",
  color: "#fff",
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
  pointerEvents: "auto"
};
const centerNote: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  pointerEvents: "none"
};
const flatNote: CSSProperties = {
  position: "absolute",
  top: 64,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "6px 14px",
  borderRadius: 999,
  background: "rgba(0,0,0,0.5)",
  color: "rgba(255,255,255,0.85)",
  fontSize: 12,
  pointerEvents: "none"
};
const shortcutPanel: CSSProperties = {
  position: "absolute",
  left: 16,
  bottom: 16,
  zIndex: 20,
  width: "clamp(300px, 30vw, 420px)",
  borderRadius: 16,
  background: "#1c1c1c",
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  padding: 24
};
const kbd: CSSProperties = {
  minWidth: 40,
  height: 40,
  padding: "0 8px",
  borderRadius: 12,
  background: "#333",
  color: "#fff",
  fontSize: 16,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  userSelect: "none"
};

function CloseIcon({ size = 20 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 全景查看浮层：居中弹窗（85vw × 85vh），球面环视，底部工具条与快捷键面板。 */
export function PanoramaOverlay({ store, actions }: { store: PanoramaStore; actions: PanoramaActions }) {
  const { nodeId, url, title } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!nodeId) return null;
  // 换节点就整体重挂：旧球面与贴图随卸载释放。
  return (
    <PanoramaStage
      key={`${nodeId}\n${url}`}
      nodeId={nodeId}
      url={url}
      title={title}
      actions={actions}
      onClose={() => store.close()}
    />
  );
}

type StageProps = { nodeId: string; url: string; title: string; actions: PanoramaActions; onClose: () => void };

function PanoramaStage({ nodeId, url, title, actions, onClose }: StageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<PanoramaViewHandle | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [flat, setFlat] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(true);
  const baseName = title || `panorama-${nodeId}`;

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    try {
      viewRef.current = createPanoramaView({
        container,
        url,
        onLoaded: ({ width, height }) => {
          setFlat(!isEquirectangular(width, height));
          setLoad("ready");
        },
        onError: () => setLoad("error")
      });
    } catch {
      // WebGL 不可用：不让异常冒泡成整页白屏。
      setLoad("error");
      return;
    }
    return () => {
      viewRef.current?.dispose();
      viewRef.current = null;
    };
  }, [url]);

  // Esc 关闭；Q/E/W/A/S/D 按住逐帧生效（输入框里不拦）。
  useEffect(() => {
    const held = new Set<string>();
    let raf = 0;
    const tick = (): void => {
      const delta = frameDelta(held);
      if (delta) {
        if (delta.dFov) viewRef.current?.zoomBy(delta.dFov);
        if (delta.dYaw || delta.dPitch) viewRef.current?.rotateBy(delta.dYaw, delta.dPitch);
      }
      raf = held.size > 0 ? requestAnimationFrame(tick) : 0;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!isPanoramaKey(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      held.add(event.code);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isPanoramaKey(event.code)) held.delete(event.code);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [onClose]);

  const capture = useCallback(
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const blob = await viewRef.current?.capture(CAPTURE_LONG_EDGE);
      if (!blob) return { ok: false, error: "截图失败" };
      return actions.saveScreenshot(blob, baseName, nodeId);
    },
    [actions, baseName, nodeId]
  );

  return (
    <div style={backdrop} onClick={onClose} data-testid="panorama-overlay">
      <div style={modal} role="dialog" aria-modal="true" aria-label="全景预览" onClick={(event) => event.stopPropagation()}>
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
        <div style={topBar}>
          <div style={{ flex: 1 }} />
          <div style={pill}>{title || "全景图"}</div>
          <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" style={closeButton} onClick={onClose} aria-label="关闭">
              <CloseIcon />
            </button>
          </div>
        </div>
        {load === "loading" ? <div style={centerNote}>加载中…</div> : null}
        {load === "error" ? <div style={centerNote}>全景图加载失败</div> : null}
        {load === "ready" && flat ? <div style={flatNote}>这张图宽高比不是 2:1，画面可能变形</div> : null}
        {load === "ready" ? (
          <PanoramaToolbar
            shortcutsOpen={showShortcuts}
            onToggleShortcuts={() => setShowShortcuts((value) => !value)}
            onScreenshot={capture}
            onReset={() => viewRef.current?.resetView()}
            onDownload={() => actions.download(url, baseName)}
          />
        ) : null}
        {showShortcuts ? (
          <div style={shortcutPanel}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <span style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>快捷键</span>
              <button
                type="button"
                aria-label="关闭快捷键"
                onClick={() => setShowShortcuts(false)}
                style={{ border: 0, background: "transparent", color: "rgba(255,255,255,0.6)", cursor: "pointer", padding: 2 }}
              >
                <CloseIcon />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {SHORTCUT_ROWS.map((row) => (
                <div key={row[0].key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 32 }}>
                  {row.map((item) => (
                    <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, whiteSpace: "nowrap" }}>{item.label}</span>
                      <kbd style={kbd}>{item.key}</kbd>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
