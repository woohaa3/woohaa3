/**
 * TaskActivityFeed overlay
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 3.2 / 3.3 / 3.4 / design D4 / D5；
 *  change: adopt-radix-lucide-canvas-ui 任务 5.1/5.2：迁移到 Collapsible / ScrollArea /
 *  IconButton / Tooltip / 受控 Popover 与 Lucide facade；
 *  change: 2026-10-22-unify-task-activity-rows，任务 3.1–3.3 / design D4：
 *  **单行渲染器**——生成任务、扩展后台活动与组创作共用 `ActivityListRow`，差异只来自
 *  `ActivityRow.actions` 与 `ActivityRow.source`，不再有按种类的行组件）。
 *
 * 左下角透明、左对齐的紧凑 activity feed：状态灯在左，单行显示主行文案与状态/进度。
 * 组内 AI 创作沿用同一活动列表，组节点右上角状态可展开对应记录。
 * 模型、失败原因与结果悬停/聚焦可见；标题打开详情，终态关闭在 hover/focus 或触屏时可达。
 * 全部活动按开始时间从新到旧交错排列；终态记录统一停留时长后向下滑出并移除，也可手动关闭。
 * 成功项在 hover/focus 时以受控媒体浮层预览：图片/视频海报经同源 storageKey、音频只显示
 * 类型/时长且**不自动播放**、文本悬停显示有界安全摘要。所有 URL 只经 `resolveMediaUrl`。
 *
 * rows 始终从 TaskActivityStore snapshot 读取；primitive 不监听任务事件、不保存记录，也不改变
 * store 的合并与排序（design D6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { TaskResultSummary } from "@woohaa3/contracts";
import type { ActivityRow, ActivityRowActions } from "./rows.js";
import { ACTIVITY_EXIT_DURATION_MS, type TaskActivityStore } from "./store.js";
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
  ScrollArea,
  Button,
  IconButton,
  Tooltip,
  Popover,
  ChevronDownIcon,
  CloseIcon,
  MenuListIcon
} from "@woohaa3/frontend/extension-api";

export type TaskActivityFeedProps = {
  store: TaskActivityStore;
  /** 稳定 storageKey → 同源受控 URL（Media Remote）。绝不接受 provider/签名 URL。 */
  resolveMediaUrl: (storageKey: string) => string;
  /** 打开宿主已有的作品生成历史弹窗，绝不导航至全局监控页。 */
  onOpenHistory?: () => void;
};

export function TaskActivityFeed({ store, resolveMediaUrl, onOpenHistory }: TaskActivityFeedProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rows = snapshot.rows;
  const total = rows.length;

  // 初始展开状态取决于启动时是否已有记录；后续新项由 effect 自动展开（SSR/静态渲染
  // 不执行 effect，因此这里必须按首帧快照决定）。只有已结算的组记录不抢开面板。
  const [expanded, setExpanded] = useState(() =>
    store.getSnapshot().rows.some((row) => row.kind !== "group" || row.active)
  );
  const previousRows = useRef({ count: rows.length, groupKeys: new Set(rows.filter((row) => row.kind === "group").map((row) => row.key)) });

  // 有新项时自动展开；清空后收起。后台录制随画布加载自动开始，不因它的首条记录抢开面板。
  useEffect(() => {
    const tasks = rows.filter((row) => row.kind === "task").length;
    const previous = previousRows.current;
    const newlyActiveGroup = rows.some((row) => row.kind === "group" && row.active && !previous.groupKeys.has(row.key));
    if ((tasks > 0 && previous.count === 0) || newlyActiveGroup) setExpanded(true);
    if (rows.length === 0) setExpanded(false);
    previousRows.current = {
      count: rows.length,
      groupKeys: new Set(rows.filter((row) => row.kind === "group").map((row) => row.key))
    };
  }, [rows]);
  useEffect(() => {
    if (snapshot.openRevision > 0) setExpanded(true);
  }, [snapshot.openRevision]);

  const openFeed = useCallback(() => {
    setExpanded(true);
    store.markRead();
  }, [store]);

  const label = useMemo(
    () => (total > 0 ? `任务活动（${total}）` : "任务活动"),
    [total]
  );

  if (!expanded) {
    return (
      <Tooltip content="任务活动">
        <button
          type="button"
          className="task-activity-feed__entry"
          aria-label={label}
          aria-expanded={false}
          onClick={openFeed}
        >
          <span className="task-activity-feed__entry-icon" aria-hidden="true">
            <MenuListIcon />
          </span>
          <span className="task-activity-feed__entry-label">{label}</span>
          {snapshot.unread > 0 ? (
            <span className="task-activity-feed__badge" aria-label={`${snapshot.unread} 条未读`}>
              {snapshot.unread}
            </span>
          ) : null}
        </button>
      </Tooltip>
    );
  }

  const hasTerminal = rows.some((row) => !row.active);

  return (
    <CollapsibleRoot
      className="task-activity-feed"
      style={{ "--activity-exit-duration": `${ACTIVITY_EXIT_DURATION_MS}ms` } as CSSProperties}
      open
      onOpenChange={(next) => {
        if (!next) setExpanded(false);
      }}
      aria-label="任务活动"
      data-has-active={snapshot.hasActive}
    >
      <CollapsibleContent className="task-activity-feed__collapse-content">
        {snapshot.groupError ? <p className="task-activity-feed__empty">状态更新失败：{snapshot.groupError}（保留上次状态）</p> : null}
        {total === 0 ? (
          <p className="task-activity-feed__empty">暂无任务</p>
        ) : (
          <ScrollArea className="task-activity-feed__scroll" label="任务活动列表">
            <ul className="task-activity-feed__list">
              {rows.map((row) => (
                <ActivityListRow
                  key={row.key}
                  row={row}
                  exiting={snapshot.exitingKeys.includes(row.key)}
                  openRevision={snapshot.openRevision}
                  store={store}
                  resolveMediaUrl={resolveMediaUrl}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </CollapsibleContent>
      <footer className="task-activity-feed__footer">
        <CollapsibleTrigger asChild>
          <IconButton className="task-activity-feed__collapse" label="收起任务活动" size="sm">
            <ChevronDownIcon />
          </IconButton>
        </CollapsibleTrigger>
        {hasTerminal ? (
          <Button size="sm" tone="ghost" className="task-activity-feed__clear" onClick={() => store.clearTerminal()}>
            清除已结束
          </Button>
        ) : null}
        {onOpenHistory ? (
          <Button size="sm" tone="ghost" className="task-activity-feed__history" onClick={() => onOpenHistory()}>
            作品生成历史
          </Button>
        ) : null}
      </footer>
    </CollapsibleRoot>
  );
}

/** 组记录详情保留的交互延迟：离开 150ms 后关闭，允许鼠标在行与浮层之间移动。 */
const GROUP_PREVIEW_CLOSE_DELAY_MS = 150;

/**
 * 单行渲染器：主行结构（状态灯、主行文案、状态文案、关闭按钮）对全部来源共用，
 * 差异只有两处——`ActivityRow.actions` 决定可点动作，`ActivityRow.source` 决定详情内容。
 */
function ActivityListRow(props: {
  row: ActivityRow;
  exiting: boolean;
  openRevision: number;
  store: TaskActivityStore;
  resolveMediaUrl: (storageKey: string) => string;
}) {
  const { row, store, resolveMediaUrl } = props;
  const actions = row.actions;
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const rowRef = useRef<HTMLLIElement | null>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  /** 组记录的详情可交互（点击锁定、内部按钮可点）；任务/后台活动的详情只是只读预览。 */
  const interactive = actions.pinOnOpen === true;

  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const openPreview = useCallback(() => {
    cancelClose();
    if (rowRef.current) setPreview(true);
  }, [cancelClose]);

  const closePreview = useCallback(() => {
    cancelClose();
    // 可交互详情在锁定或执行动作期间保持打开（离开后短暂延迟，允许指针在行与浮层之间移动）；
    // 只读预览（任务 / 后台活动）离开即关闭。
    if (!interactive) {
      setPreview(false);
      return;
    }
    if (pinned.current || busy) return;
    closeTimer.current = setTimeout(() => setPreview(false), GROUP_PREVIEW_CLOSE_DELAY_MS);
  }, [busy, cancelClose, interactive]);

  /** 点击主行锁定详情（组记录）；只读记录立刻显示预览。 */
  const openDetails = useCallback(() => {
    cancelClose();
    pinned.current = true;
    setPreview(true);
  }, [cancelClose]);

  // 组节点入口选中该记录时展开详情并滚动到可视区（change: 2026-10-22，design D4 保留项）。
  useEffect(() => {
    if (!interactive || !row.selected) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
    pinned.current = true;
    setPreview(true);
  }, [interactive, row.selected, props.openRevision]);

  const act = useCallback(async (action: "stop" | "retry" | "verify" | "openConversation") => {
    if (busy) return;
    const run = action === "openConversation" ? actions.openConversation : actions[action];
    if (!run) {
      setError(action === "openConversation" ? "对话详情暂不可用" : "运行状态服务不可用");
      return;
    }
    setBusy(action);
    setError("");
    try {
      await run();
      if (action === "openConversation") {
        pinned.current = false;
        setPreview(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未确认，请核对状态");
    } finally {
      setBusy("");
    }
  }, [actions, busy]);

  const progressText = row.progress !== undefined
    ? ` · ${Math.round(row.progress * 100)}%`
    : "";
  const stateText = `${row.status}${progressText}`;

  /** 主行点击：组记录锁定详情；有详情能力时打开详情；否则退回节点定位（后台活动）。 */
  const activatePrimary = () => {
    if (interactive) return openDetails();
    if (actions.openDetail) return actions.openDetail();
    actions.locate?.();
  };
  /**
   * 任务行始终保留可点击主行（历史行为：打开详情，缺省无副作用）；组行可锁定详情；
   * 后台活动仅在可定位时才是按钮。
   */
  const primaryInteractive = interactive || row.kind === "task" || actions.locate !== undefined;
  /** 主行动作文案：锁定详情 / 打开详情 / 定位节点，与真实点击行为一致。 */
  const primaryActionLabel = interactive || actions.openDetail ? "查看详情" : "定位节点";

  return (
    <li
      ref={rowRef}
      className="task-activity-feed__card"
      data-exiting={props.exiting || undefined}
      data-state={row.state}
      data-tone={row.tone}
      data-kind={row.kind}
      {...(row.kind === "group" ? { "data-group-id": row.nodeId } : {})}
      {...(row.selected ? { "data-selected": true } : {})}
      {...(row.source.kind === "task" && row.source.item.optimistic ? { "data-optimistic": true } : {})}
      {...(row.source.kind === "task" && row.source.item.localFailure ? { "data-local-failure": true } : {})}
      onMouseEnter={openPreview}
      onMouseLeave={closePreview}
      onFocus={openPreview}
      onBlur={closePreview}
      aria-label={`${row.title}：${stateText}`}
    >
      <span className="task-activity-feed__dot" aria-hidden="true" />
      {primaryInteractive ? (
        <button
          type="button"
          className="task-activity-feed__primary"
          aria-label={`${row.title}：${stateText}，${primaryActionLabel}`}
          onClick={activatePrimary}
        >
          {row.title}
        </button>
      ) : (
        <span className="task-activity-feed__primary">{row.title}</span>
      )}
      <span className="task-activity-feed__state">{stateText}</span>
      {actions.close ? (
        <Tooltip content="关闭">
          <IconButton
            className="task-activity-feed__close"
            label="关闭该记录"
            size="sm"
            onClick={() => store.dismissRow(row.key)}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      ) : null}

      {preview && !props.exiting ? (
        <Popover
          open
          onOpenChange={(next) => {
            cancelClose();
            if (interactive) pinned.current = false;
            setPreview(next);
          }}
          anchor={<span aria-hidden="true" style={{ position: "absolute", right: 0, top: 0, width: 0, height: 0 }} />}
          side="right"
          align="start"
          sideOffset={8}
          className={interactive ? "task-activity-feed__pop task-activity-feed__pop--group" : "task-activity-feed__pop"}
          dismissOnOutside={interactive}
          dismissOnEscape={interactive}
          restoreFocus={false}
          autoFocus={false}
        >
          <div
            className="task-activity-feed__hover"
            {...(interactive ? { onMouseEnter: cancelClose, onMouseLeave: closePreview } : {})}
          >
            <strong>{row.title}</strong>
            {row.secondary ? <span>{row.secondary}</span> : null}
            <span>{stateText}</span>
            <RowDetail row={row} resolveMediaUrl={resolveMediaUrl} />
            {row.detail || error ? <p>{error || row.detail}</p> : null}
            {row.kind === "group" ? (
              <GroupRunActionsPanel actions={actions} busy={busy} onActivate={(action) => void act(action)} />
            ) : null}
          </div>
        </Popover>
      ) : null}
    </li>
  );
}

/** 来源详情：只有这里按 `source.kind` 分支，且只读。 */
function RowDetail(props: { row: ActivityRow; resolveMediaUrl: (storageKey: string) => string }) {
  const { row, resolveMediaUrl } = props;
  switch (row.source.kind) {
    case "task": {
      const item = row.source.item;
      if (item.state === "failed") {
        return <p>{item.error?.message || "任务未能完成，请检查输入后重试。"}</p>;
      }
      const result = item.result;
      if (item.state !== "succeeded" || !result) return null;
      return (
        <>
          <PreviewBody result={result} resolveMediaUrl={resolveMediaUrl} />
          {result.mediaKind === "text" ? <p>{truncate(result.text ?? "", 200)}</p> : null}
          {result.mediaKind === "audio" ? (
            <span>音频{result.durationSeconds !== undefined ? ` · ${formatDuration(result.durationSeconds)}` : ""}</span>
          ) : null}
        </>
      );
    }
    case "job":
      // 后台活动的失败原因已由适配器放进 `row.detail`，与任务一致地显示在统一详情里。
      return null;
    case "group":
      return null;
  }
}

/** 组创作的动作集合：只由记录声明的动作决定，不再从组件 props 逐层透传。 */
function GroupRunActionsPanel(props: {
  actions: ActivityRowActions;
  busy: string;
  onActivate: (action: "stop" | "retry" | "verify" | "openConversation") => void;
}) {
  const { actions, busy, onActivate } = props;
  const writable = actions.writable !== false;
  if (!actions.locate && !actions.stop && !actions.retry && !actions.verify && !actions.openConversation) return null;
  return (
    <div className="task-activity-feed__group-actions">
      {actions.locate ? <Button size="sm" tone="ghost" onClick={() => actions.locate!()}>定位创作组</Button> : null}
      {actions.openConversation ? (
        <Button size="sm" tone="ghost" disabled={!!busy} onClick={() => onActivate("openConversation")}>
          {busy === "openConversation" ? "正在打开…" : "查看对话"}
        </Button>
      ) : null}
      {actions.stop ? (
        <Button size="sm" tone="ghost" disabled={!!busy || !writable} onClick={() => onActivate("stop")}>
          {busy === "stop" ? "正在停止…" : "停止"}
        </Button>
      ) : null}
      {actions.retry ? (
        <Button size="sm" tone="ghost" disabled={!!busy || !writable} onClick={() => onActivate("retry")}>
          {busy === "retry" ? "正在重试…" : "重试原请求"}
        </Button>
      ) : null}
      {actions.verify ? (
        <Button size="sm" tone="ghost" disabled={!!busy} onClick={() => onActivate("verify")}>
          {busy === "verify" ? "正在核对…" : "核对状态"}
        </Button>
      ) : null}
    </div>
  );
}

function PreviewBody(props: { result: TaskResultSummary; resolveMediaUrl: (storageKey: string) => string }) {
  const { result, resolveMediaUrl } = props;
  if (result.mediaKind === "image" && result.storageKey) {
    return <img className="task-activity-feed__preview" src={resolveMediaUrl(result.storageKey)} alt="生成图片预览" />;
  }
  if (result.mediaKind === "video" && result.poster?.storageKey) {
    return (
      <div className="task-activity-feed__video">
        <img className="task-activity-feed__preview" src={resolveMediaUrl(result.poster.storageKey)} alt="视频海报" />
        {typeof result.durationSeconds === "number" ? (
          <span className="task-activity-feed__duration">{formatDuration(result.durationSeconds)}</span>
        ) : null}
      </div>
    );
  }
  return null;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${total}s`;
}
