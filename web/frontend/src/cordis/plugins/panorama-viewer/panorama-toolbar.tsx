import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CameraIcon, DownloadIcon, KeyboardIcon, RotateIcon } from "@woohaa3/ui/icons";

type Props = {
  shortcutsOpen: boolean;
  onToggleShortcuts: () => void;
  onScreenshot: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReset: () => void;
  onDownload: () => Promise<void>;
};

const bar: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "clamp(10px, 2.2vh, 16px)",
  zIndex: 10,
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none"
};
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 4, pointerEvents: "auto" };
const menu: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  right: 0,
  marginBottom: 4,
  minWidth: 180,
  borderRadius: 16,
  background: "#1c1c1c",
  padding: 12,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  zIndex: 30
};
const note: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  left: "50%",
  transform: "translateX(-50%)",
  marginBottom: 8,
  padding: "6px 12px",
  borderRadius: 999,
  background: "rgba(0,0,0,0.7)",
  color: "#fff",
  fontSize: 12,
  whiteSpace: "nowrap"
};

function IconButton(props: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        border: 0,
        display: "grid",
        placeItems: "center",
        color: "#fff",
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
        background: props.active ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.4)"
      }}
    >
      {props.children}
    </button>
  );
}

/** 工具栏图标统一 20px、1.5 线宽（与原自绘一致）。 */
const ICON = { size: 20, strokeWidth: 1.5 } as const;

/** 底部居中的四个图标按钮：快捷键开关 / 截图 / 复位 / 下载。 */
export function PanoramaToolbar({ shortcutsOpen, onToggleShortcuts, onScreenshot, onReset, onDownload }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = (text: string): void => {
    setMessage(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 2500);
  };

  const screenshot = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await onScreenshot();
    setBusy(false);
    flash(result.ok ? "截图已保存到画布" : result.error);
  };

  return (
    <div style={bar}>
      <div style={{ ...row, position: "relative" }}>
        {message ? <div style={note}>{message}</div> : null}
        <IconButton label="快捷键" active={shortcutsOpen} onClick={onToggleShortcuts}>
          <KeyboardIcon {...ICON} />
        </IconButton>
        <IconButton label="截图" disabled={busy} onClick={() => void screenshot()}>
          <CameraIcon {...ICON} />
        </IconButton>
        <IconButton label="复位视角" onClick={onReset}>
          <RotateIcon {...ICON} />
        </IconButton>
        <div ref={menuRef} style={{ position: "relative" }}>
          <IconButton label="下载" active={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <DownloadIcon {...ICON} />
          </IconButton>
          {menuOpen ? (
            <div style={menu}>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void onDownload().catch(() => flash("下载失败"));
                }}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", border: 0, borderRadius: 8, background: "transparent", color: "#fff", fontSize: 15, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                下载 PNG
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
