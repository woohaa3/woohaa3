import { useEffect, useRef, useState } from "react";
import { Button, IconButton, CloseIcon, Popover, type CanvasGroupRun } from "@woohaa3/frontend/extension-api";

export type GroupRunActions = {
  onGroupAction?: (row: CanvasGroupRun, action: "stop" | "retry" | "refresh") => Promise<void>;
  onOpenGroupConversation?: (row: CanvasGroupRun) => void | Promise<void>;
  groupWritable?: () => boolean;
  resolveGroupTitle?: (nodeId: string) => string;
};

export function GroupRunRow(props: GroupRunActions & {
  row: CanvasGroupRun;
  selected: boolean;
  openRevision: number;
  onLocateNode: (nodeId: string) => void;
  onDismiss: () => void;
}) {
  const { row, selected } = props;
  const ref = useRef<HTMLLIElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const cancelClose = () => clearTimeout(closeTimer.current);
  const openDetails = () => {
    cancelClose();
    pinned.current = true;
    setPreview(true);
  };
  const leaveDetails = () => {
    cancelClose();
    if (!pinned.current && !busy) closeTimer.current = setTimeout(() => setPreview(false), 150);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (selected) {
      ref.current?.scrollIntoView?.({ block: "nearest" });
      pinned.current = true;
      setPreview(true);
    }
  }, [selected, props.openRevision]);
  const act = async (action: "stop" | "retry" | "refresh" | "open") => {
    if (busy) return;
    setBusy(action); setError("");
    try {
      if (action === "open") {
        if (!props.onOpenGroupConversation) throw new Error("对话详情暂不可用");
        await props.onOpenGroupConversation(row);
        pinned.current = false;
        setPreview(false);
      } else {
        if (!props.onGroupAction) throw new Error("运行状态服务不可用");
        await props.onGroupAction(row, action);
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : "操作未确认，请核对状态"); }
    finally { setBusy(""); }
  };
  const writable = props.groupWritable?.() ?? false;
  const title = props.resolveGroupTitle?.(row.creation.rootGroupId) || "节点搭建";
  return <li ref={ref} className="task-activity-feed__card" data-group-id={row.creation.rootGroupId} data-state={row.status} data-selected={selected || undefined}
    onMouseEnter={() => { cancelClose(); setPreview(true); }} onMouseLeave={leaveDetails}>
    <span className="task-activity-feed__dot" />
    <button type="button" className="task-activity-feed__primary" onClick={openDetails}>{title}</button>
    <span className="task-activity-feed__state">{row.label}</span>
    {!row.active ? <IconButton className="task-activity-feed__close" label="关闭该记录" size="sm" onClick={props.onDismiss}><CloseIcon /></IconButton> : null}
    {preview ? <Popover open onOpenChange={open => { cancelClose(); pinned.current = false; setPreview(open); }}
      anchor={<span style={{ position: "absolute", right: 0, top: 0, width: 0, height: 0 }} />}
      side="right" align="start" sideOffset={8} className="task-activity-feed__pop task-activity-feed__pop--group"
      dismissOnOutside dismissOnEscape restoreFocus={false} autoFocus={false}>
      <div className="task-activity-feed__hover" onMouseEnter={cancelClose} onMouseLeave={leaveDetails}>
        <strong>{title}</strong><span>{row.label}</span>
        {error || row.error ? <p>{error || row.error}</p> : null}
        <div className="task-activity-feed__group-actions">
          <Button size="sm" tone="ghost" onClick={() => props.onLocateNode(row.creation.rootGroupId)}>定位创作组</Button>
          {row.creation.conversationId && props.onOpenGroupConversation ? <Button size="sm" tone="ghost" disabled={!!busy} onClick={() => void act("open")}>{busy === "open" ? "正在打开…" : "查看对话"}</Button> : null}
          {["queued", "running", "committing", "unknown"].includes(row.status) && row.creation.conversationId ? <Button size="sm" tone="ghost" disabled={!!busy || !writable} onClick={() => void act("stop")}>{busy === "stop" ? "正在停止…" : "停止"}</Button> : null}
          {!row.creation.turnId && row.creation.error?.code !== "group-target-missing" ? <Button size="sm" tone="ghost" disabled={!!busy || !writable} onClick={() => void act("retry")}>{busy === "retry" ? "正在重试…" : "重试原请求"}</Button> : null}
          <Button size="sm" tone="ghost" disabled={!!busy} onClick={() => void act("refresh")}>{busy === "refresh" ? "正在核对…" : "核对状态"}</Button>
        </div>
      </div>
    </Popover> : null}
  </li>;
}
