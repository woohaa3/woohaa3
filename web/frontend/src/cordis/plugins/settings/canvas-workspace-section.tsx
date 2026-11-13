import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasWorkspaceSettings, WorkspaceMigration } from "@woohaa3/contracts";
import { Button } from "@woohaa3/ui/primitives";
import { getAppPublicFetch } from "../../services/app-base-path.js";
import { workspaceFolder } from "../../../desktop/workspace-folders.js";
import type { SettingsEditSession } from "./edit-session.js";
import "./canvas-workspace-section.css";

const PHASES: Record<WorkspaceMigration["phase"], string> = { validating: "校验新位置", "waiting-for-idle": "等待助手任务完成", copying: "复制文件", verifying: "校验文件", switching: "切换工作目录", completed: "迁移完成", failed: "迁移失败", recovering: "恢复迁移", cancelled: "已取消迁移" };
const active = (m?: WorkspaceMigration) => !!m && !["completed", "failed", "cancelled"].includes(m.phase);
type Move = { operationId: string; targetPath: string; expectedRootRevision: number };

export function CanvasWorkspaceSection({ canManage, canvasId, editSession }: { canManage: boolean; canvasId?: string; editSession?: SettingsEditSession }) {
  const [snapshot, setSnapshot] = useState<CanvasWorkspaceSettings>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<Move>();
  const mounted = useRef(true), working = useRef(false);
  const refreshSequence = useRef(0);
  const report = useRef<ReturnType<SettingsEditSession["register"]>>();
  const request = useCallback(async (suffix = "", body?: unknown) => {
    const response = await getAppPublicFetch()(`/api/settings/agent-workspaces${suffix}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? "工作目录操作失败");
    return value;
  }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++refreshSequence.current;
    const value = await request() as CanvasWorkspaceSettings;
    if (mounted.current && sequence === refreshSequence.current) setSnapshot(value);
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    report.current = editSession?.register({ id: "canvas-agent-workspace" });
    void refresh().catch(cause => { if (mounted.current) setError(String(cause.message ?? cause)); });
    return () => { mounted.current = false; refreshSequence.current++; report.current?.dispose(); };
  }, [editSession, refresh]);
  const migration = snapshot?.migration, migrating = active(migration);
  useEffect(() => {
    if (!migrating && !migration?.cleanupPending) return;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void refresh().catch(cause => { if (mounted.current) setError(String(cause.message ?? cause)); }).finally(() => { reading = false; });
    }, 1200);
    return () => clearInterval(timer);
  }, [refresh, migrating, migration?.cleanupPending]);
  const act = async (operation: () => Promise<void>) => {
    if (working.current || !canManage) return;
    working.current = true; setPending(true); setError(""); setNotice("");
    report.current?.report({ dirty: false, pending: true });
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      working.current = false;
      if (mounted.current) { setPending(false); report.current?.report({ dirty: false, pending: false }); }
    }
  };
  const move = async (input: Move) => {
    if (mounted.current) setRetry(input);
    await request("/migrate", input);
    if (mounted.current) setRetry(undefined);
    await refresh();
  };
  const choose = () => act(async () => {
    if (!snapshot || migrating) return;
    const { path } = await workspaceFolder({ action: "pick" });
    if (!path || !mounted.current || path === snapshot.rootPath) return;
    if (!window.confirm(`将全部画布的助手工作文件迁移到：\n${path}\n\n已有助手任务会继续运行，迁移会等待它们完成。`)) return;
    await move({ operationId: crypto.randomUUID(), targetPath: path, expectedRootRevision: snapshot.rootRevision });
  });
  const disabled = pending || !canManage;
  return <div className="settings-page__list settings-agent-workspace">
    {error ? <p className="settings-page__error">{error}</p> : null}
    {!snapshot ? <p>{error ? "暂时无法读取工作目录。" : "正在读取工作目录…"}</p> : <>
      <section className="settings-page__item">
        <strong>工作目录位置</strong>
        <p className="settings-agent-workspace__path">{snapshot.rootPath}</p>
        <div className="settings-agent-workspace__actions">
          <Button tone="neutral" disabled={disabled || migrating} onClick={() => void choose()}>选择文件夹</Button>
          <Button tone="neutral" disabled={disabled} onClick={() => void act(async () => { await workspaceFolder({ action: "open", path: snapshot.rootPath }); })}>打开目录</Button>
          {retry ? <Button tone="neutral" disabled={disabled || migrating} onClick={() => void act(() => move(retry))}>重试更换</Button> : null}
        </div>
      </section>
      {migration ? <section className="settings-page__item">
        <strong>{PHASES[migration.phase]}{migration.cleanupPending ? " · 旧副本待清理" : ""}</strong>
        <p className="settings-agent-workspace__path">{migration.target}</p>
        {migration.error ? <p className="settings-page__error">{migration.error}</p> : null}
        {active(migration) && migration.phase !== "switching" ? <Button tone="neutral" disabled={disabled} onClick={() => void act(async () => { await request("/cancel-migration", { operationId: migration.operationId }); await refresh(); })}>取消迁移</Button> : null}
      </section> : null}
      {canvasId ? <div className="settings-agent-workspace__actions">
        <Button tone="neutral" disabled={disabled || migrating} onClick={() => void act(async () => { const location = await request(`/location?canvasId=${encodeURIComponent(canvasId)}`); await workspaceFolder({ action: "open", path: location.path }); })}>打开当前画布目录</Button>
        <Button tone="neutral" disabled={disabled || migrating} onClick={() => void act(async () => {
          if (!window.confirm("清理当前画布已结束回合的临时文件？共享文件、运行中和状态未知的回合文件会保留。")) return;
          const result = await request("/clean", { canvasId });
          if (mounted.current) setNotice(`已清理 ${result.removed.length} 个回合${result.retained.length ? `，保留 ${result.retained.length} 个回合` : ""}。`);
        })}>清理临时文件</Button>
      </div> : null}
      {notice ? <p>{notice}</p> : null}
    </>}
  </div>;
}
