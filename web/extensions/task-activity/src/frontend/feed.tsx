/**
 * TaskActivityFeed overlay
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 3.2 / 3.3 / 3.4 / design D4 / D5；
 *  change: adopt-radix-lucide-canvas-ui 任务 5.1/5.2：迁移到 Collapsible / ScrollArea /
 *  IconButton / Tooltip / 受控 Popover 与 Lucide facade）。
 *
 * 左下角透明、左对齐的紧凑 activity feed：状态灯在左，单行显示任务名与状态/进度。
 * 组内 AI 创作沿用同一活动列表，组节点右上角状态可展开对应记录。
 * 模型、失败原因与结果悬停/聚焦可见；标题打开作品生成历史弹窗，终态关闭在 hover/focus 或触屏时可达。
 * 全部活动按开始时间从新到旧交错排列；终态项 10 秒后向下滑出并移除，也可手动关闭。
 * 成功项在 hover/focus 时以受控
 * 媒体浮层预览：图片/视频海报经同源 storageKey、音频只显示类型/时长且**不自动播放**、
 * 文本悬停显示有界安全摘要。所有 URL 只经 `resolveMediaUrl`（Media Remote）。
 *
 * items 始终从 TaskActivityStore snapshot 读取；primitive 不监听任务事件、不保存记录，
 * 也不改变 store 的合并顺序（design D6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  isActiveTaskState,
  isTerminalTaskState,
  type BackgroundActivityJob,
  type CanvasTaskActivity,
  type TaskResultSummary
} from "@woohaa3/contracts";
import type { ActivityFeedItem, TaskActivityStore } from "./store.js";
import { ACTIVITY_EXIT_DURATION_MS } from "./store.js";
import { GroupRunRow, type GroupRunActions } from "./group-run-row.js";
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

export type TaskActivityFeedProps = GroupRunActions & {
  store: TaskActivityStore;
  /** 稳定 storageKey → 同源受控 URL（Media Remote）。绝不接受 provider/签名 URL。 */
  resolveMediaUrl: (storageKey: string) => string;
  /** 定位到权威节点（selection 由宿主处理）。 */
  onLocateNode: (nodeId: string) => void;
  /** 打开宿主已有的作品生成历史弹窗，绝不导航至全局监控页。 */
  onOpenHistory?: (item?: ActivityFeedItem) => void;
  /**
   * 活动中的 Agent 记录：按确切的领域运行关联打开同一 Agent 详情
   * （change: 2026-10-12-add-agent-conversation-panel，任务 5.7 / design D7）。
   *
   * 返回 `true` 表示已由宿主定位到确切 request/run 的 Agent 详情；返回 `false` 表示该 run
   * 没有 Agent 回合关联，调用方保留原任务详情（普通 Task 不伪造对话）。只在提供时优先尝试。
   */
  onOpenAgentDetail?: (item: ActivityFeedItem) => Promise<boolean>;
  /**
   * 主/次行展示解析（change: 2026-10-09-improve-canvas-workflow，任务 5.1）。
   * 缺省时按 modelKey 简单展示，保持既有 story 可用。
   */
  resolveDisplay?: (item: ActivityFeedItem) => { primary: string; secondary: string; locatable: boolean; locateReason: string | null };
};

const STATE_LABELS: Record<CanvasTaskActivity["state"], string> = {
  queued: "排队中",
  pending: "准备中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const JOB_STATE_LABELS: Record<BackgroundActivityJob["status"], string> = {
  queued: "排队中",
  running: "录制中",
  succeeded: "已录制",
  failed: "失败",
  cancelled: "已取消"
};

const JOB_KIND_LABELS: Record<BackgroundActivityJob["kind"], string> = {
  "shot-reference-recording": "录制镜头参考"
};

function isActiveJob(job: BackgroundActivityJob): boolean {
  return job.status === "queued" || job.status === "running";
}

export function TaskActivityFeed({ store, resolveMediaUrl, resolveDisplay, onLocateNode, onOpenHistory, onOpenAgentDetail, ...groupActions }: TaskActivityFeedProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // 统一按活动开始时间排序；状态和种类都不改变位置，进度更新不会让记录跳动。
  const entries = [
    ...snapshot.items.map((item) => ({ kind: "task" as const, key: `task:${item.runId}`, time: item.createdAt, item })),
    ...snapshot.jobs.map((job) => ({ kind: "job" as const, key: `job:${job.id}`, time: job.createdAt, job })),
    ...snapshot.groups.map((row) => ({ kind: "group" as const, key: `group:${row.creation.requestId}`, time: row.createdAt, row }))
  ].sort((a, b) => b.time.localeCompare(a.time) || a.key.localeCompare(b.key));
  const total = entries.length;
  // 初始展开状态取决于启动时是否已有记录；后续新项由 effect 自动展开（SSR/静态渲染
  // 不执行 effect，因此这里必须按首帧快照决定）。
  const [expanded, setExpanded] = useState(() => {
    const first = store.getSnapshot();
    return first.items.length + first.jobs.length > 0 || first.groups.some(row => row.active);
  });
  const previousCount = useRef(total);
  const previousGroups = useRef(new Set(snapshot.groups.map(row => row.requestId)));

  // 有新项时自动展开；清空后收起。后台录制随画布加载自动开始，不因它的首条记录抢开面板。
  useEffect(() => {
    const tasks = snapshot.items.length;
    const jobs = snapshot.jobs.length;
    const count = tasks + jobs + snapshot.groups.length;
    if ((tasks > 0 && previousCount.current === 0) || snapshot.groups.some(row => row.active && !previousGroups.current.has(row.requestId))) setExpanded(true);
    if (count === 0) setExpanded(false);
    previousCount.current = count;
    previousGroups.current = new Set(snapshot.groups.map(row => row.requestId));
  }, [snapshot.items.length, snapshot.jobs.length, snapshot.groups]);
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

  const hasTerminal = snapshot.items.some((item) => isTerminalTaskState(item.state)) || snapshot.jobs.some((job) => !isActiveJob(job)) || snapshot.groups.some(row => !row.active);

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
              {entries.map((entry) => entry.kind === "group" ? (
                <GroupRunRow key={entry.key} row={entry.row} selected={snapshot.selectedGroupId === entry.row.creation.rootGroupId} openRevision={snapshot.openRevision} onLocateNode={onLocateNode} onDismiss={() => store.dismissGroup(entry.row.creation.requestId)} {...groupActions} />
              ) : entry.kind === "job" ? (
                <JobRow key={entry.key} job={entry.job} exiting={snapshot.exitingKeys.includes(entry.key)} store={store} onLocateNode={onLocateNode} />
              ) : (
                <ActivityRow
                  key={entry.key}
                  item={entry.item}
                  exiting={snapshot.exitingKeys.includes(entry.key)}
                  store={store}
                  resolveMediaUrl={resolveMediaUrl}
                  {...(onOpenHistory ? { onOpenHistory } : {})}
                  {...(onOpenAgentDetail ? { onOpenAgentDetail } : {})}
                  {...(resolveDisplay ? { resolveDisplay } : {})}
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

function ActivityRow(props: {
  item: ActivityFeedItem;
  exiting: boolean;
  store: TaskActivityStore;
  resolveMediaUrl: (storageKey: string) => string;
  onOpenHistory?: (item?: ActivityFeedItem) => void;
  onOpenAgentDetail?: (item: ActivityFeedItem) => Promise<boolean>;
  resolveDisplay?: (item: ActivityFeedItem) => { primary: string; secondary: string; locatable: boolean; locateReason: string | null };
}) {
  const { item, store, resolveMediaUrl } = props;
  const [preview, setPreview] = useState(false);
  const rowRef = useRef<HTMLLIElement | null>(null);
  const terminal = isTerminalTaskState(item.state);

  /**
   * 打开该记录：Agent 记录优先定位**确切** request/run 详情；无 Agent 关联（普通 Task）保留
   * 原任务详情（change: 2026-10-12-add-agent-conversation-panel，任务 5.7）。绝不按 nodeId
   * 跳到同节点较新会话，也不为普通 Task 伪造对话。
   */
  const openRecord = useCallback(() => {
    const openAgent = props.onOpenAgentDetail;
    if (openAgent) {
      void openAgent(item).then((opened) => {
        if (!opened) props.onOpenHistory?.(item);
      });
      return;
    }
    props.onOpenHistory?.(item);
  }, [item, props.onOpenAgentDetail, props.onOpenHistory]);

  // 标题是画布上唯一的任务描述；模型和完整原因只在悬停层显示。
  const display = props.resolveDisplay?.(item) ?? {
    primary: labelForModel(item),
    secondary: "",
    locatable: true,
    locateReason: null
  };

  // hover/focus 显示信息，不抢占焦点或要求点击。
  const openPreview = useCallback(() => {
    if (rowRef.current) setPreview(true);
  }, []);

  const closePreview = useCallback(() => setPreview(false), []);

  const progressText =
    isActiveTaskState(item.state) && item.progress !== undefined
      ? ` · ${Math.round(Math.max(0, Math.min(1, item.progress)) * 100)}%`
      : "";

  return (
    <li
      ref={rowRef}
      className="task-activity-feed__card"
      data-exiting={props.exiting || undefined}
      data-state={item.state}
      data-optimistic={item.optimistic || undefined}
      data-local-failure={item.localFailure || undefined}
      onMouseEnter={openPreview}
      onMouseLeave={closePreview}
      onFocus={openPreview}
      onBlur={closePreview}
      aria-label={`${display.primary}：${STATE_LABELS[item.state]}${progressText}`}
    >
      <span className="task-activity-feed__dot" aria-hidden="true" />
      <button
        type="button"
        className="task-activity-feed__primary"
        aria-label={`${display.primary}：${STATE_LABELS[item.state]}${progressText}，查看任务`}
        onClick={() => openRecord()}
      >
        {display.primary}
      </button>
      <span className="task-activity-feed__state">{STATE_LABELS[item.state]}{progressText}</span>
      {terminal ? (
        <Tooltip content="关闭">
          <IconButton
            className="task-activity-feed__close"
            label="关闭该记录"
            size="sm"
            onClick={() => store.dismiss(item.taskKey)}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      ) : null}

      {preview && !props.exiting ? (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) closePreview();
          }}
          anchor={<span aria-hidden="true" style={{ position: "absolute", right: 0, top: 0, width: 0, height: 0 }} />}
          side="right"
          align="start"
          sideOffset={8}
          className="task-activity-feed__pop"
          dismissOnOutside={false}
          dismissOnEscape={false}
          restoreFocus={false}
          autoFocus={false}
        >
          <div className="task-activity-feed__hover">
            <strong>{display.primary}</strong>
            <span>{display.secondary || item.modelKey || "模型信息暂不可用"}</span>
            <span>{STATE_LABELS[item.state]}{progressText}</span>
            {item.state === "failed" ? <p>{item.error?.message || "任务未能完成，请检查输入后重试。"}</p> : null}
            {item.state === "succeeded" && item.result ? <>
              <PreviewBody result={item.result} resolveMediaUrl={resolveMediaUrl} />
              {item.result.mediaKind === "text" ? <p>{truncate(item.result.text ?? "", 200)}</p> : null}
              {item.result.mediaKind === "audio" ? <span>音频{item.result.durationSeconds !== undefined ? ` · ${formatDuration(item.result.durationSeconds)}` : ""}</span> : null}
            </> : null}
          </div>
        </Popover>
      ) : null}
    </li>
  );
}

/**
 * 后台活动行（扩展发布的非任务活动）：
 *
 * 只表达状态与进度，可定位所属画布节点，但**不**打开任务历史或 Agent 详情；
 * 失败原因放在与普通任务一致的悬停详情中，不挤占单行布局。
 */
function JobRow(props: {
  job: BackgroundActivityJob;
  exiting: boolean;
  store: TaskActivityStore;
  onLocateNode: (nodeId: string) => void;
}) {
  const { job, store, onLocateNode } = props;
  const [preview, setPreview] = useState(false);
  const active = isActiveJob(job);
  const progressText =
    active && job.progress !== undefined
      ? ` · ${Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%`
      : "";
  const primary = `${JOB_KIND_LABELS[job.kind]} · ${job.title}`;
  const state = `${JOB_STATE_LABELS[job.status]}${progressText}`;
  return (
    <li
      className="task-activity-feed__card"
      data-exiting={props.exiting || undefined}
      data-state={job.status}
      data-kind={job.kind}
      onMouseEnter={() => setPreview(true)}
      onMouseLeave={() => setPreview(false)}
      aria-label={`${primary}：${state}${job.detail ? `，${job.detail}` : ""}`}
    >
      <span className="task-activity-feed__dot" aria-hidden="true" />
      {job.nodeId ? (
        <button
          type="button"
          className="task-activity-feed__primary"
          aria-label={`${primary}：${state}，定位节点`}
          onClick={() => onLocateNode(job.nodeId!)}
        >
          {primary}
        </button>
      ) : (
        <span className="task-activity-feed__primary">{primary}</span>
      )}
      <span className="task-activity-feed__state">{state}</span>
      {preview && !props.exiting ? (
        <Popover
          open
          onOpenChange={setPreview}
          anchor={<span aria-hidden="true" style={{ position: "absolute", right: 0, top: 0, width: 0, height: 0 }} />}
          side="right"
          align="start"
          sideOffset={8}
          className="task-activity-feed__pop"
          dismissOnOutside={false}
          dismissOnEscape={false}
          restoreFocus={false}
          autoFocus={false}
        >
          <div className="task-activity-feed__hover">
            <strong>{primary}</strong>
            <span>{state}</span>
            {job.detail ? <p>{job.detail}</p> : job.status === "failed" ? <p>镜头录制失败，未返回具体原因。</p> : null}
          </div>
        </Popover>
      ) : null}
      {active ? null : (
        <Tooltip content="关闭">
          <IconButton className="task-activity-feed__close" label="关闭该记录" size="sm" onClick={() => store.dismissJob(job.id)}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      )}
    </li>
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

function labelForModel(item: CanvasTaskActivity): string {
  if (item.modelKey) return item.modelKey;
  if (item.modelType) return MODEL_TYPE_LABELS[item.modelType];
  return "任务";
}

const MODEL_TYPE_LABELS: Record<NonNullable<CanvasTaskActivity["modelType"]>, string> = {
  language: "文本",
  image: "图片",
  video: "视频",
  audio: "音频"
};

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
