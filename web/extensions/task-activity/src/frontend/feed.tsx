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
import { SKILL_STATE_LABELS, displayedProgressPercent, type ActivityRow, type ActivityRowCapabilities } from "./rows.js";
import { ACTIVITY_EXIT_DURATION_MS, type TaskActivityStore } from "./store.js";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger, ScrollArea, Button, IconButton, Tooltip, Popover } from "@woohaa3/ui/primitives";
import { ChevronDownIcon, CloseIcon, MenuListIcon } from "@woohaa3/ui/icons";

export type TaskActivityFeedProps = {
  store: TaskActivityStore;
  /** 稳定 storageKey → 同源受控 URL（Media Remote）。绝不接受 provider/签名 URL。 */
  resolveMediaUrl: (storageKey: string) => string;
  /** 打开宿主已有的作品生成历史弹窗，绝不导航至全局监控页。 */
  onOpenHistory?: () => void;
  /**
   * 行能力（与 store 装配一致）：面板渲染时要用它解析节点类型来估算进度时长
   * （change: 2026-10-31-unify-node-and-activity-progress）。
   */
  capabilities?: ActivityRowCapabilities;
};

export function TaskActivityFeed({ store, resolveMediaUrl, onOpenHistory, capabilities }: TaskActivityFeedProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rows = snapshot.rows;
  const total = rows.length;
  /**
   * 进度文案的刷新时钟（change: 2026-10-31-unify-node-and-activity-progress）。
   *
   * 面板与画布节点用同一套「按种类的经过时间估算」，因此需要像渲染器那样逐秒推进。整块面板
   * 共用一个时钟，只在存在进行中的生成任务时挂定时器；终态/无记录时不空转。
   */
  const now = useProgressClock(needsProgressClock(rows));

  // 初始展开状态取决于启动时是否已有记录；后续新项由 effect 自动展开（SSR/静态渲染
  // 不执行 effect，因此这里必须按首帧快照决定）。只有已结算的组/Skill 记录不抢开面板。
  const [expanded, setExpanded] = useState(() =>
    store.getSnapshot().rows.some((row) => (row.kind !== "skill") || row.active)
  );
  const previousRows = useRef({
    count: rows.length,
    pollingKeys: new Set(rows.filter((row) => row.kind === "skill").map((row) => row.key))
  });

  // 有新项时自动展开；清空后收起。后台录制随画布加载自动开始，不因它的首条记录抢开面板。
  useEffect(() => {
    const tasks = rows.filter((row) => row.kind === "task").length;
    const previous = previousRows.current;
    const newlyActivePolling = rows.some((row) =>
      row.kind === "skill" && row.active && !previous.pollingKeys.has(row.key)
    );
    if ((tasks > 0 && previous.count === 0) || newlyActivePolling) setExpanded(true);
    if (rows.length === 0) setExpanded(false);
    previousRows.current = {
      count: rows.length,
      pollingKeys: new Set(rows.filter((row) => row.kind === "skill").map((row) => row.key))
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
                  now={now}
                  capabilities={capabilities}
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
 * 进度文案刷新间隔（毫秒），与渲染器逐帧取整的可见变化节奏一致。
 *
 * 估算按「经过秒数 × 100 / 种类时长」推进，1s 步进对 45s/180s 这类时长已是 1–2 个百分点的
 * 粒度；更快的 tick 只会产生同样的整数结果。
 */
const PROGRESS_TICK_MS = 1_000;

/**
 * 仅在需要时逐秒推进的时钟；`enabled` 为 false 时不挂定时器、返回首帧时间。
 *
 * 服务端渲染（无 effect）下退化为渲染时刻，不引入额外状态。面板整体只有一个时钟，
 * 行只读取它的值，避免每条记录各挂一个定时器。
 */
function useProgressClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** 面板内是否有任何需要逐秒推进进度的记录（进行中的生成任务）。 */
function needsProgressClock(rows: readonly ActivityRow[]): boolean {
  return rows.some((row) => row.active && row.kind === "task");
}

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
  /** 面板共享的进度时钟（毫秒时间戳）；行本身不挂定时器。 */
  now: number;
  /** 行能力：解析节点类型以估算进度时长。 */
  capabilities?: ActivityRowCapabilities;
}) {
  const { row, store, resolveMediaUrl, now, capabilities } = props;
  const actions = row.actions;
  const [preview, setPreview] = useState(false);
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
    if (pinned.current) return;
    closeTimer.current = setTimeout(() => setPreview(false), GROUP_PREVIEW_CLOSE_DELAY_MS);
  }, [cancelClose, interactive]);

  /** 点击主行锁定详情（组记录）；只读记录立刻显示预览。 */
  const openDetails = useCallback(() => {
    cancelClose();
    pinned.current = true;
    setPreview(true);
  }, [cancelClose]);

  const progressPercent = displayedProgressPercent(row, now, capabilities);
  const progressText = progressPercent !== undefined ? ` · ${progressPercent}%` : "";
  const stateText = `${row.status}${progressText}`;

  /** 主行点击：有详情能力时打开详情；否则退回节点定位（后台活动）。 */
  const activatePrimary = () => {
    if (interactive) return openDetails();
    if (actions.openDetail) return actions.openDetail();
    actions.locate?.();
  };
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
          className={interactive ? "task-activity-feed__pop" : "task-activity-feed__pop"}
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
            {row.detail ? <p>{row.detail}</p> : null}
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
      return null;
    case "skill": {
      /**
       * 旧尝试历史入口（任务 5.2）：只有这里展开完整尝试历史，主行状态始终只取
       * `currentAttempt`。提示词属于 owner 可见的历史快照（事件与 MCP 输出已 redact）。
       */
      const step = row.source.step;
      return (
        <div className="task-activity-feed__skill">
          <span>
            当前尝试 第 {step.currentAttempt} 次 · 提示词 r{step.promptRevision}
          </span>
          {step.latestSuccessfulRunId ? <span>最近成功 run：{step.latestSuccessfulRunId}</span> : null}
          <ul className="task-activity-feed__skill-attempts">
            {step.attempts.map((attempt) => (
              <li
                key={attempt.attempt}
                data-state={attempt.state}
                {...(attempt.attempt === step.currentAttempt ? { "data-current": true } : {})}
              >
                <span>
                  第 {attempt.attempt} 次 · {SKILL_STATE_LABELS[attempt.state]}
                  {attempt.superseded ? " · 已替代" : ""}
                </span>
                {attempt.modelKey ? <span>{attempt.modelKey}</span> : null}
                {attempt.prompt ? <span>{truncate(attempt.prompt, 80)}</span> : null}
                {attempt.supersededByRunId ? <span>由 {attempt.supersededByRunId} 替代</span> : null}
                {attempt.error ? <span>{attempt.error}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }
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
