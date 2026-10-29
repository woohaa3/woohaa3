import { CopyField } from "@woohaa3/ui/feedback";
import { AudioPlayer } from "@woohaa3/ui/media";
/**
 * 任务历史详情（change: improve-task-history-experience，任务 4.4–4.7、5.2–5.4）。
 *
 * 统一顺序：状态摘要 → 产物/错误/运行阶段 → 生命周期时间线 → 请求摘要 → 技术信息。
 * 成功优先产物、失败优先错误、运行中优先进度；请求/技术默认折叠；媒体受控同源读取，
 * 不自动播放，失败有局部反馈且不改变任务终态。Escape 只在详情内处理一次并恢复触发元素焦点。
 */
import { useEffect, useRef, useState } from "react";
import { isTerminalTaskState, type TaskExecutionDetail, type TaskExecutionState } from "@woohaa3/contracts";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { Collapsible } from "@woohaa3/ui/primitives";
import { CloseIcon, CollapseIcon, ExpandIcon, LocateIcon } from "@woohaa3/ui/icons";
import { STATE_LABELS, formatDuration, formatLocalTime, sourceLabel, stageLabel } from "./history-format.js";

export type HistoryDetailProps = {
  detail: TaskExecutionDetail | null;
  error: string | null;
  /** auto 由 CSS 按宽度降级；Showcase 可显式指定。 */
  layout?: "auto" | "side" | "overlay" | "fullscreen";
  /** 第二参数是详情所属画布：媒体地址按画布路由读取。 */
  resolveMediaUrl: (storageKey: string, canvasId?: string) => string;
  copyText: (value: string) => Promise<boolean | void>;
  onClose: () => void;
  onOpenCanvas?: (input: { canvasId: string; nodeId: string }) => void;
  previousTaskKey?: string;
  nextTaskKey?: string;
  onSelect?: (taskKey: string) => void;
};

/** 详情：按状态摘要 → 产物/错误/运行阶段 → 时间线 → 请求 → 技术信息组织。 */
export function HistoryDetail({
  detail,
  error,
  layout = "auto",
  resolveMediaUrl,
  copyText,
  onClose,
  onOpenCanvas,
  previousTaskKey,
  nextTaskKey,
  onSelect
}: HistoryDetailProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    closeRef.current?.focus?.();
    return () => {
      previousFocus.current?.focus?.();
    };
  }, []);

  const layoutClass = layout === "auto" ? "" : ` task-history__detail--${layout}`;
  // 详情带画布身份时，结果媒体统一追加画布提示（不改变持久化引用）。
  const canvasId = detail?.canvasId;
  const resolveUrl = canvasId ? (storageKey: string) => resolveMediaUrl(storageKey, canvasId) : resolveMediaUrl;
  return (
    <aside
      className={`task-history__detail${layoutClass}`}
      role="dialog"
      aria-modal={layout === "overlay" || layout === "fullscreen" ? true : undefined}
      aria-label="执行详情"
      data-testid="task-history-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="task-history__detail-top">
        <div className="task-history__detail-heading">
          <h2>{detail ? detail.modelTitle ?? detail.modelKey ?? detail.taskKey : "执行详情"}</h2>
          {detail ? <TaskStateBadge state={detail.state} /> : null}
        </div>
        <div className="task-history__detail-actions">
          {detail && onOpenCanvas && detail.canvasId && detail.nodeId ? (
            <Button
              size="sm"
              tone="ghost"
              icon={<LocateIcon />}
              onClick={() => {
                const { canvasId, nodeId } = detail;
                if (canvasId && nodeId) onOpenCanvas({ canvasId, nodeId });
              }}
            >
              定位画布
            </Button>
          ) : null}
          <IconButton ref={closeRef} label="关闭详情" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      {error ? (
        <p className="task-history__error" role="alert">
          {error}
        </p>
      ) : null}

      {detail ? (
        <div className="task-history__detail-body">
          {/* 状态摘要 */}
          <dl className="task-history__summary-grid">
            <div>
              <dt>状态</dt>
              <dd>{STATE_LABELS[detail.state]}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{detail.providerName ?? detail.providerId}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{detail.modelTitle ?? detail.modelKey ?? "—"}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatLocalTime(detail.createdAt)}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{formatLocalTime(detail.startedAt)}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{formatLocalTime(detail.finishedAt)}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{formatDuration(detail.durationMs)}</dd>
            </div>
            <div>
              <dt>尝试</dt>
              <dd>{detail.attempt ?? "—"}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>
                {sourceLabel(detail.source)}
                {detail.source === "extension" && detail.extensionId ? ` · ${detail.extensionId}` : ""}
              </dd>
            </div>
          </dl>

          {/* 状态相关内容：成功优先产物，失败优先错误，运行中优先进度。 */}
          <section className="task-history__section" aria-label="执行结果">
            {detail.state === "succeeded" && detail.result ? (
              <MediaResultPreview result={detail.result} resolveMediaUrl={resolveUrl} />
            ) : null}
            {detail.state === "failed" ? (
              detail.error ? (
                <div className="task-history__error-block" role="alert">
                  <strong>{detail.error.name ?? "Error"}</strong>
                  <p>{detail.error.message}</p>
                </div>
              ) : (
                <p className="task-history__muted">无错误摘要</p>
              )
            ) : null}
            {!isTerminalTaskState(detail.state) ? (
              <div className="task-history__running">
                {detail.progress !== undefined ? (
                  <progress className="task-history__progress" max={1} value={Math.max(0, Math.min(1, detail.progress))} aria-label="执行进度" />
                ) : (
                  <span>阶段未知</span>
                )}
                <span>更新时间 {formatLocalTime(detail.updatedAt)}</span>
              </div>
            ) : null}
            {detail.state === "cancelled" ? <p className="task-history__muted">任务已取消，无产物。</p> : null}
          </section>

          {/* 生命周期时间线 */}
          <section className="task-history__section">
            <h3>生命周期时间线</h3>
            {detail.eventsTruncated ? (
              <p className="task-history__truncated" role="note">
                事件时间线已裁剪，仅显示最新有界片段。
              </p>
            ) : null}
            <ol className="task-history__events">
              {detail.events.map((event) => (
                <li key={event.sequence}>
                  <span className="task-history__event-time">{formatLocalTime(event.occurredAt)}</span>
                  <span className="task-history__event-stage">{stageLabel(event.stage)}</span>
                </li>
              ))}
              {detail.events.length === 0 ? <li className="task-history__muted">无事件</li> : null}
            </ol>
          </section>

          {/* 请求摘要（默认折叠；截断有标记） */}
          {detail.request ? (
            <section className="task-history__section">
              <Collapsible
                trigger={<span>请求摘要（提示词与参数）</span>}
                triggerClassName="task-history__collapsible-trigger"
                forceMount
              >
                <div className="task-history__request">
                  <div>
                    <span className="task-history__request-label">提示词</span>
                    {detail.request.promptTruncated ? <span className="task-history__truncated">（已截断）</span> : null}
                    <pre>{detail.request.prompt || "—"}</pre>
                  </div>
                  <div>
                    <span className="task-history__request-label">参数</span>
                    {detail.request.parametersTruncated ? <span className="task-history__truncated">（已裁剪）</span> : null}
                    <pre>{JSON.stringify(detail.request.parameters, null, 2)}</pre>
                  </div>
                </div>
              </Collapsible>
            </section>
          ) : null}

          {/* 技术信息（默认折叠；保留安全原 stage 与 ID） */}
          <section className="task-history__section">
            <Collapsible trigger={<span>技术信息</span>} triggerClassName="task-history__collapsible-trigger" forceMount>
              <div className="task-history__technical">
                <CopyField value={detail.taskKey} label="taskKey" copyText={copyText} />
                {detail.runId ? <CopyField value={detail.runId} label="runId" copyText={copyText} /> : null}
                {detail.canvasId ? <CopyField value={detail.canvasId} label="canvasId" copyText={copyText} /> : null}
                {detail.nodeId ? <CopyField value={detail.nodeId} label="nodeId" copyText={copyText} /> : null}
                <p className="task-history__admission">
                  受理版本：catalog{" "}
                  {detail.admission?.catalogRevision ?? "未记录"} · schema{" "}
                  {detail.admission?.schemaRevision ?? "未记录"} · config{" "}
                  {detail.admission?.configVersion ?? "未记录"} · plugin{" "}
                  {detail.admission?.extensionConfigVersion ?? "未记录"}
                </p>
                <pre>{JSON.stringify(detail.events.map((event) => ({ sequence: event.sequence, stage: event.stage })), null, 2)}</pre>
              </div>
            </Collapsible>
          </section>
        </div>
      ) : null}

      {onSelect && (previousTaskKey || nextTaskKey) ? (
        <footer className="task-history__detail-nav">
          <Button size="sm" tone="ghost" disabled={!previousTaskKey} onClick={() => previousTaskKey && onSelect(previousTaskKey)}>
            上一条
          </Button>
          <Button size="sm" tone="ghost" disabled={!nextTaskKey} onClick={() => nextTaskKey && onSelect(nextTaskKey)}>
            下一条
          </Button>
        </footer>
      ) : null}
    </aside>
  );
}

export function TaskStateBadge({ state }: { state: TaskExecutionState }) {
  return (
    <span className={`task-history__state is-${state}`} data-state={state}>
      <span className="task-history__state-glyph" aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
  );
}

/** 结果媒体预览：受控同源读取；不自动播放；失败有局部反馈，不改任务终态。 */
function MediaResultPreview({
  result,
  resolveMediaUrl
}: {
  result: NonNullable<TaskExecutionDetail["result"]>;
  resolveMediaUrl: (storageKey: string) => string;
}) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  if (result.mediaKind === "image") {
    if (!result.storageKey) return <p className="task-history__muted">图片（无稳定对象）</p>;
    const url = resolveMediaUrl(result.storageKey);
    return (
      <div className="task-history__media" data-media="image">
        {failed ? (
          <div className="task-history__media-failure" role="alert">
            <span>图片无法读取</span>
            <button type="button" onClick={() => setFailed(false)}>
              重试
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`task-history__media-zoom${zoom ? " is-zoom" : ""}`}
            onClick={() => setZoom((value) => !value)}
            aria-pressed={zoom}
            aria-label={zoom ? "缩小图片" : "放大图片"}
          >
            <img src={url} alt="任务结果图片" loading="lazy" onError={() => setFailed(true)} />
            <span className="task-history__media-zoom-icon" aria-hidden="true">
              {zoom ? <CollapseIcon /> : <ExpandIcon />}
            </span>
          </button>
        )}
        <dl className="task-history__media-meta">
          <div>
            <dt>storageKey</dt>
            <dd>{result.storageKey}</dd>
          </div>
          {result.size !== undefined ? (
            <div>
              <dt>大小</dt>
              <dd>{result.size} bytes</dd>
            </div>
          ) : null}
        </dl>
      </div>
    );
  }
  if (result.mediaKind === "video") {
    if (!result.storageKey) return <p className="task-history__muted">视频（无稳定对象）</p>;
    return (
      <div className="task-history__media" data-media="video">
        <video
          className="task-history__result-media"
          controls
          preload="metadata"
          src={resolveMediaUrl(result.storageKey)}
          poster={result.poster?.storageKey ? resolveMediaUrl(result.poster.storageKey) : undefined}
          onError={() => setFailed(true)}
        />
        {failed ? (
          <p className="task-history__media-failure" role="alert">
            视频无法读取
          </p>
        ) : null}
        {result.durationSeconds !== undefined ? <p className="task-history__muted">时长 {result.durationSeconds}s</p> : null}
        <dl className="task-history__media-meta">
          <div>
            <dt>storageKey</dt>
            <dd>{result.storageKey}</dd>
          </div>
        </dl>
      </div>
    );
  }
  if (result.mediaKind === "audio") {
    if (!result.storageKey) return <p className="task-history__muted">音频（无稳定对象）</p>;
    return (
      <div className="task-history__media" data-media="audio">
        <AudioPlayer url={resolveMediaUrl(result.storageKey)} />
        {failed ? (
          <p className="task-history__media-failure" role="alert">
            音频无法读取
          </p>
        ) : null}
        {result.durationSeconds !== undefined ? <p className="task-history__muted">时长 {result.durationSeconds}s</p> : null}
        <dl className="task-history__media-meta">
          <div>
            <dt>storageKey</dt>
            <dd>{result.storageKey}</dd>
          </div>
        </dl>
      </div>
    );
  }
  return (
    <div className="task-history__media" data-media="text">
      {result.textTruncated ? <p className="task-history__truncated">文本摘要已截断</p> : null}
      <pre className="task-history__result-text">{result.text ?? "—"}</pre>
    </div>
  );
}

