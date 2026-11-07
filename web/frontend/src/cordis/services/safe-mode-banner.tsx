/**
 * 安全模式提示条（change: 2026-10-21-harden-extension-fault-isolation，design D7 / 任务 5.4）。
 *
 * 读 `/api/settings` 快照的 `safeMode`；非 null 时顶部常驻一条提示：已暂停的扩展数、原因、最近一次
 * 失败摘要，以及「退出安全模式并重启」（经 `POST /api/host/restart` 带 `exitSafeMode: true`）。
 * 请求受理后交给宿主连通性进入重连遮罩，恢复后无需手动刷新。
 *
 * 读取失败（未授权 / 不可达）时不显示：提示条不是权威状态，不替代设置面里的扩展状态。
 */
import { useEffect, useState } from "react";
import type { HostSafeModeView, SettingsSnapshot } from "@woohaa3/contracts";
import { Button } from "@woohaa3/ui/primitives";
import type { HostConnectivityService } from "./host-connectivity.js";
import { createHostRestartRemote, type HostRestartRemote } from "./host-restart-remote.js";
import { createSettingsRemote, type SettingsRemote } from "./settings-remote.js";

/** 从设置快照取安全模式（契约 `SettingsSnapshot.safeMode`）；缺省、null 或形状不对视为未进入。 */
export function readSafeMode(snapshot: SettingsSnapshot): HostSafeModeView | null {
  const value = snapshot.safeMode;
  if (!value || typeof value !== "object" || typeof value.suspendedCount !== "number") return null;
  return value;
}

export function safeModeReasonText(view: HostSafeModeView): string {
  return view.reason === "forced" ? "由 WOOHAA3_SAFE_MODE 强制开启" : "连续多次启动失败";
}

export function SafeModeBanner({
  connectivity,
  settingsRemote,
  restartRemote
}: {
  connectivity: HostConnectivityService;
  settingsRemote?: SettingsRemote;
  restartRemote?: HostRestartRemote;
}) {
  const [view, setView] = useState<HostSafeModeView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每次回到在线都重读一次：重启后安全模式可能已退出。
  const [online, setOnline] = useState(() => connectivity.getSnapshot().phase !== "reconnecting");
  useEffect(() => connectivity.subscribe(() => setOnline(connectivity.getSnapshot().phase !== "reconnecting")), [connectivity]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    const remote = settingsRemote ?? createSettingsRemote();
    void remote.fetchSnapshot().then((result) => {
      if (cancelled) return;
      setView(result.ok ? readSafeMode(result.snapshot) : null);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [online, settingsRemote]);

  if (!view) return null;
  const exit = async () => {
    setPending(true);
    setError(null);
    const result = await (restartRemote ?? createHostRestartRemote()).restart({ reason: "exit-safe-mode", exitSafeMode: true });
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    connectivity.expectRestart();
  };
  return (
    <div className="safe-mode-banner" role="status" data-testid="safe-mode-banner">
      <strong>安全模式</strong>
      <span>
        已暂停 {view.suspendedCount} 个扩展（{safeModeReasonText(view)}）
      </span>
      {view.lastFailure ? <span className="safe-mode-banner__detail" title={view.lastFailure}>{view.lastFailure}</span> : null}
      {error ? <span className="safe-mode-banner__detail">{error}</span> : null}
      <Button tone="primary" disabled={pending} onClick={() => void exit()}>
        {pending ? "正在重启…" : "退出安全模式并重启"}
      </Button>
    </div>
  );
}
