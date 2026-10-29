/**
 * 生成溯源 / 任务详情正文（纯展示组件）
 * （自 `pages/task-monitor/detail-panel.tsx` 抽出，change: 生成溯源改为画布内浮窗）。
 *
 * 同一份正文同时服务**独立任务监控页**的详情侧栏与**画布内**「生成溯源」浮窗：只接收纯数据与
 * 回调，不读 URL、不读 Cordis、不持有打开/关闭身份（那由调用方拥有）。
 *
 * 信息层级按「这次生成到底做了什么」组织：摘要 → 请求与参数（默认展开）→ 结果缩略/错误
 * → 生命周期时间线 → 耗时与时间 → 技术信息（默认展开，上游任务号与产物存储键置顶）。
 */
import { useState, type ReactNode } from "react";
import { isTerminalTaskState, type TaskExecutionDetail, type TaskRequestInput } from "@woohaa3/contracts";
import { AudioPlayer } from "@woohaa3/ui/media";
import { Button, IconButton } from "@woohaa3/ui";
import { CheckIcon, CopyIcon, LocateIcon } from "@woohaa3/ui";
import { actorLabel, copyToClipboard, effectiveTotalMs, formatDuration, formatLocalTime, sourceLabel, stageLabel, stateLabel } from "./format.js";
import { formatClockRange, groupTimeline } from "./timeline.js";
import "./task-trace.css";

export type TaskTraceBodyProps = {
  detail: TaskExecutionDetail | null;
  error: string | null;
  loading: boolean;
  /** 当前时间（在途耗时本地递增）；缺省按渲染时刻取值。 */
  nowMs?: number;
  /**
   * 受控媒体地址解析。第二个参数是这次详情所属画布：组件会把 `detail.canvasId` 传下去，
   * 让画布内读请求带 `?canvas=` 提示（独立监控页也据此按画布路由）。
   */
  resolveMediaUrl?: (storageKey: string, canvasId?: string) => string;
  /**
   * 「返回画布」入口：仅独立页面需要（浮窗本身已在画布上，不传即不渲染）。
   */
  onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void;
};

export function TaskTraceBody({
  detail,
  error,
  loading,
  nowMs,
  resolveMediaUrl,
  onOpenCanvas
}: TaskTraceBodyProps): ReactNode {
  // 请求摘要与技术信息是排障的主要事实，默认展开；用户仍可折叠。
  const [requestOpen, setRequestOpen] = useState(true);
  const [technicalOpen, setTechnicalOpen] = useState(true);
  const clock = nowMs ?? Date.now();
  const totalMs = detail ? effectiveTotalMs(detail.timing, detail.state, clock) : undefined;
  // 详情带画布身份时，正文里的媒体地址统一追加画布提示；与页面/浮窗由谁打开无关。
  const canvasId = detail?.canvasId;
  const resolveUrl = resolveMediaUrl && canvasId
    ? (storageKey: string) => resolveMediaUrl(storageKey, canvasId)
    : resolveMediaUrl;
  // 轮询会把「执行中」刷成几十行；连续同阶段归并成一段，保留起止与次数。
  const timelineRows = detail ? groupTimeline(detail.events) : [];
  const identities = detail ? technicalIdentities(detail) : [];
  const technicalCopyText = detail ? technicalCopyLines(detail, identities) : [];
  return (
    <div className="task-trace" data-testid="task-trace-body">
      {detail && onOpenCanvas && detail.canvasId ? (
        <div className="task-trace__actions">
          <Button
            size="sm"
            tone="primary"
            icon={<LocateIcon />}
            onClick={() => onOpenCanvas({ canvasId: detail.canvasId!, ...(detail.nodeId ? { nodeId: detail.nodeId } : {}) })}
          >
            返回画布
          </Button>
        </div>
      ) : null}

      {loading ? <p className="task-monitor__muted" role="status">正在加载详情…</p> : null}
      {error ? (
        <p role="alert" className="task-monitor__error">
          {error}
        </p>
      ) : null}

      {detail ? (
        <div className="task-monitor__detail-body">
          <dl className="task-monitor__summary">
            {summaryCells(detail).map((cell) => (
              <SummaryCell key={cell.label} label={cell.label} value={cell.value} />
            ))}
          </dl>

          {/* 信息层级第一段：这次生成提交了什么（提示词 / 参数 / 参考输入），默认展开。 */}
          {detail.request ? (
            <section className="task-monitor__section" aria-label="请求与参数">
              <button type="button" className="task-monitor__collapse-trigger" aria-expanded={requestOpen} onClick={() => setRequestOpen((value) => !value)}>
                请求摘要（提示词与参数）
              </button>
              {requestOpen ? (
                <div className="task-monitor__request">
                  <div>
                    <span className="task-monitor__label">提示词{detail.request.promptTruncated ? "（已截断）" : ""}</span>
                    <pre className="task-monitor__prompt">{detail.request.prompt || "—"}</pre>
                  </div>
                  <div>
                    <span className="task-monitor__label">参数{detail.request.parametersTruncated ? "（已裁剪）" : ""}</span>
                    <pre>{JSON.stringify(detail.request.parameters ?? {}, null, 2)}</pre>
                  </div>
                  {detail.request.inputs && detail.request.inputs.length > 0 ? (
                    <div>
                      <span className="task-monitor__label">参考输入 · {detail.request.inputs.length} 张</span>
                      <ul className="task-trace__refs">
                        {detail.request.inputs.map((input, index) => (
                          <ReferenceInput key={`${input.role}:${index}`} input={input} resolveMediaUrl={resolveUrl} />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* 产物只是「请求的结果」：缩略图限高，点击再放大，不占满首屏。 */}
          {detail.state === "succeeded" || detail.state === "cancelled" || !isTerminalTaskState(detail.state) ? (
            <section className="task-monitor__section" aria-label="执行结果">
              {detail.state === "succeeded" && detail.result ? (
                <ResultPreview result={detail.result} resolveMediaUrl={resolveUrl} />
              ) : null}
              {detail.state === "succeeded" && !detail.result ? <p className="task-monitor__muted">成功，但无产物摘要。</p> : null}
              {!isTerminalTaskState(detail.state) ? (
                <div className="task-monitor__running">
                  {detail.progress !== undefined ? (
                    <progress max={1} value={Math.max(0, Math.min(1, detail.progress))} aria-label="执行进度" />
                  ) : (
                    <span className="task-monitor__muted">阶段未知</span>
                  )}
                  <span className="task-monitor__muted">更新时间 {formatLocalTime(detail.updatedAt)}</span>
                </div>
              ) : null}
              {detail.state === "cancelled" ? <p className="task-monitor__muted">任务已取消，无产物。</p> : null}
            </section>
          ) : null}

          {detail.state === "failed" && detail.error ? (
            <section className="task-monitor__section" aria-label="错误">
              <h3>错误</h3>
              <div className="task-monitor__error-block" role="alert">
                <strong>{detail.error.name ?? "Error"}</strong>
                <p>{detail.error.message}</p>
                {detail.error.status !== undefined || detail.error.code ? (
                  <p className="task-monitor__muted">
                    {detail.error.status !== undefined ? `上游状态 ${detail.error.status}` : null}
                    {detail.error.status !== undefined && detail.error.code ? " · " : null}
                    {detail.error.code ? `错误码 ${detail.error.code}` : null}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="task-monitor__section">
            <div className="task-trace__section-head">
              <h3>生命周期时间线</h3>
              {timelineRows.length > 0 ? (
                <span className="task-trace__section-meta">
                  {timelineRows.length < detail.events.length
                    ? `${timelineRows.length} 段 / ${detail.events.length} 条`
                    : `${timelineRows.length} 条`}
                </span>
              ) : null}
            </div>
            {detail.eventsTruncated ? <p className="task-monitor__muted" role="note">事件时间线已裁剪，仅显示最新片段。</p> : null}
            {timelineRows.length === 0 ? (
              <p className="task-monitor__muted">无事件</p>
            ) : (
              <ol className="task-trace__timeline">
                {timelineRows.map((row) => (
                  <li key={row.key} className="task-trace__timeline-row" data-kind={row.kind}>
                    <time
                      className="task-trace__timeline-time"
                      dateTime={row.firstAt}
                      title={
                        row.count > 1
                          ? `${formatLocalTime(row.firstAt)} → ${formatLocalTime(row.lastAt)}（${row.count} 次）`
                          : formatLocalTime(row.firstAt)
                      }
                    >
                      {formatClockRange(row)}
                    </time>
                    <span className="task-trace__timeline-marker" aria-hidden="true" />
                    <span className="task-trace__timeline-stage">{stageLabel(row.stage)}</span>
                    {row.count > 1 ? <span className="task-trace__timeline-count">×{row.count}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* 耗时与时间单独成段：顶部摘要只留身份/上下文，避免 14 格「未知」噪音。 */}
          <section className="task-monitor__section" aria-label="耗时与时间">
            <h3>耗时与时间</h3>
            <dl className="task-monitor__summary task-monitor__summary--timing">
              {timingCells(detail, totalMs).map((cell) => (
                <SummaryCell key={cell.label} label={cell.label} value={cell.value} />
              ))}
            </dl>
          </section>

          <section className="task-monitor__section" aria-label="技术信息">
            <div className="task-monitor__technical-head">
              <button type="button" className="task-monitor__collapse-trigger" aria-expanded={technicalOpen} onClick={() => setTechnicalOpen((value) => !value)}>
                技术信息
              </button>
              {technicalOpen && technicalCopyText.length > 0 ? <CopyAllButton lines={technicalCopyText} /> : null}
            </div>
            {technicalOpen ? (
              <div className="task-monitor__technical">
                <p className="task-monitor__muted task-monitor__technical-intro">
                  这些编号用于在任务监控或上游控制台对账、排障，日常不需要关注。
                </p>
                {/* 上游任务号是去 Provider 控制台对账的唯一钥匙：置顶、加定位色、可复制。 */}
                {detail.upstreamTaskId ? (
                  <div className="task-monitor__upstream">
                    <span className="task-monitor__label">上游任务号</span>
                    <CopyField value={detail.upstreamTaskId} label="上游任务号" />
                  </div>
                ) : null}
                {detail.result?.storageKey ? (
                  <div>
                    <span className="task-monitor__label">产物存储键</span>
                    <CopyField value={detail.result.storageKey} label="产物存储键" />
                    {detail.result.size !== undefined || detail.result.checksum ? (
                      <p className="task-monitor__muted">
                        {detail.result.size !== undefined ? `大小 ${formatFileSize(detail.result.size)}` : null}
                        {detail.result.size !== undefined && detail.result.checksum ? " · " : null}
                        {detail.result.checksum ? `校验和 ${shortenChecksum(detail.result.checksum)}` : null}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {identities.length > 0 ? (
                  <dl className="task-monitor__ids">
                    {identities.map((identity) => (
                      <div key={identity.label} className="task-monitor__id-row">
                        <dt>{identity.label}</dt>
                        <dd>
                          <CopyField value={identity.value} label={identity.label} />
                          {identity.note ? <span className="task-monitor__id-note">{identity.note}</span> : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** 顶部摘要：只回答「谁、用什么、在哪跑、试了几次」；无值的单元格不进网格。 */
function summaryCells(detail: TaskExecutionDetail): Array<{ label: string; value: string }> {
  const cells: Array<{ label: string; value: string | number | undefined }> = [
    { label: "状态", value: stateLabel(detail.state) },
    { label: "Provider", value: detail.providerName ?? detail.providerId },
    { label: "模型", value: detail.modelTitle ?? detail.modelKey },
    { label: "来源", value: detail.source ? `${sourceLabel(detail.source)}${detail.extensionId ? ` · ${detail.extensionId}` : ""}` : undefined },
    // 使用人缺失即不渲染：actor 未写入时「未知」只是噪音。
    { label: "使用人", value: detail.actor ? actorLabel(detail.actor) : undefined },
    { label: "画布", value: detail.canvasTitle ?? detail.canvasId },
    // 摘要用可读标题：没有标题时宁可就叫「未命名节点」，也不把原始节点 id 摆在主视图。
    { label: "节点", value: detail.nodeTitle ?? (detail.nodeId ? "未命名节点" : undefined) },
    { label: "尝试", value: detail.attempt }
  ];
  return cells
    .filter((cell): cell is { label: string; value: string | number } => cell.value !== undefined && cell.value !== "" && cell.value !== "未知")
    .map((cell) => ({ label: cell.label, value: String(cell.value) }));
}

/** 耗时与时间：底层事实缺失的项整格不渲染（后端尚未计算的耗时不为「未知」占位）。 */
function timingCells(detail: TaskExecutionDetail, totalMs: number | undefined): Array<{ label: string; value: string }> {
  const timing = detail.timing;
  const startedAt = timing?.firstStartedAt ?? detail.startedAt;
  const cells: Array<{ label: string; value: string | undefined }> = [
    { label: "总耗时", value: totalMs === undefined ? undefined : formatDuration(totalMs) },
    { label: "排队耗时", value: timing?.queueMs === undefined ? undefined : formatDuration(timing.queueMs) },
    { label: "执行耗时", value: timing?.executionMs === undefined ? undefined : formatDuration(timing.executionMs) },
    { label: "状态驻留", value: timing?.stateMs === undefined ? undefined : formatDuration(timing.stateMs) },
    { label: "受理时间", value: formatLocalTime(timing?.admittedAt ?? detail.createdAt) },
    { label: "首次开始", value: startedAt === undefined ? undefined : formatLocalTime(startedAt) },
    { label: "状态变化", value: formatLocalTime(timing?.stateChangedAt ?? detail.updatedAt) },
    { label: "完成时间", value: detail.finishedAt === undefined ? undefined : formatLocalTime(detail.finishedAt) }
  ];
  return cells.filter((cell): cell is { label: string; value: string } => cell.value !== undefined && cell.value !== "未知");
}

/** 摘要单元格（调用方已过滤缺失值，这里只负责结构）。 */
function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** 产物文件大小（排障时判断「是不是这个文件」的辅助信息）。 */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 校验和摘要：只保留可辨认的头尾，完整值留在存储键/后端记录里。 */
function shortenChecksum(checksum: string): string {
  return checksum.length > 24 ? `${checksum.slice(0, 12)}…${checksum.slice(-8)}` : checksum;
}

/** 角色 → 可读标签（未知角色回退原名）。 */
const INPUT_ROLE_LABELS: Record<string, string> = {
  reference_image: "参考图",
  reference_image_1: "参考图 1",
  reference_image_2: "参考图 2",
  first_frame: "首帧",
  last_frame: "尾帧",
  reference_video: "参考视频",
  reference_audio: "参考音频",
  style_image: "风格图"
};

function inputRoleLabel(role: string): string {
  return INPUT_ROLE_LABELS[role] ?? role;
}

/**
 * 参考输入卡片：能解析到媒体地址就显示缩略图。
 *
 * 只靠 assetId/storageKey 这种字符串没法判断「用了哪张图」，所以有 storageKey 且宿主提供
 * media 解析时一律出图；解析不到（旧记录、缺 media 能力）才退化成文本。
 */
function ReferenceInput({
  input,
  resolveMediaUrl
}: {
  input: TaskRequestInput;
  resolveMediaUrl?: (storageKey: string) => string;
}) {
  const [failed, setFailed] = useState(false);
  const url = input.storageKey && resolveMediaUrl ? resolveMediaUrl(input.storageKey) : null;
  const kind = input.mediaKind ?? "file";
  const reference = requestInputReference(input);
  return (
    <li className="task-trace__ref" data-media={kind} title={reference}>
      <div className="task-trace__ref-thumb">
        {url && !failed ? (
          kind === "video" ? (
            <video src={url} muted playsInline preload="metadata" onError={() => setFailed(true)} />
          ) : kind === "image" || kind === "file" ? (
            <img src={url} alt={inputRoleLabel(input.role)} loading="lazy" onError={() => setFailed(true)} />
          ) : (
            <span aria-hidden="true" className="task-trace__ref-nomedia">音频</span>
          )
        ) : (
          <span aria-hidden="true" className="task-trace__ref-nomedia">
            {kind === "image" ? "无预览" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "文本"}
          </span>
        )}
      </div>
      <div className="task-trace__ref-meta">
        <span className="task-trace__ref-role">{inputRoleLabel(input.role)}</span>
        <span className="task-trace__ref-sub">{requestInputMedia(input)}</span>
      </div>
    </li>
  );
}

/** 参考输入的媒体描述（kind · type；缺失部分不补占位）。 */
function requestInputMedia(input: TaskRequestInput): string {
  return [input.mediaKind, input.mediaType].filter((value): value is string => typeof value === "string" && value !== "").join(" · ") || "—";
}

/**
 * 参考输入的稳定引用：优先 assetId，其次 storageKey 摘要。
 *
 * storageKey 通常是长路径/校验名，列表中只保留可辨认的头尾，避免撑开侧栏。
 */
function requestInputReference(input: TaskRequestInput): string {
  if (input.assetId) return input.assetId;
  if (!input.storageKey) return "—";
  const name = input.storageKey.split("/").pop() ?? input.storageKey;
  return name.length > 24 ? `${name.slice(0, 10)}…${name.slice(-8)}` : name;
}

type TechnicalIdentity = { label: string; value: string; note?: string };

/**
 * 技术信息里的人话标识：同一个值只解释一次（taskKey 与 runId 相同时合并成一行），
 * 画布/节点优先带上可读标题，让「这串 id 是什么」不需要靠猜。
 */
function technicalIdentities(detail: TaskExecutionDetail): TechnicalIdentity[] {
  const rows: TechnicalIdentity[] = [];
  if (detail.runId && detail.runId !== detail.taskKey) {
    rows.push({ label: "任务号", value: detail.taskKey, note: "在任务监控里定位这次生成" });
    rows.push({ label: "运行号", value: detail.runId, note: "一次执行实例；重试会产生新的运行号" });
  } else {
    rows.push({
      label: "任务 / 运行",
      value: detail.taskKey,
      note: detail.runId ? "任务号与运行号相同" : "在任务监控里定位这次生成"
    });
  }
  if (detail.canvasId) {
    rows.push({
      label: "画布 ID",
      value: detail.canvasId,
      note: detail.canvasTitle ? `画布「${detail.canvasTitle}」` : "画布唯一标识"
    });
  }
  if (detail.nodeId) {
    rows.push({
      label: "画布节点 ID",
      value: detail.nodeId,
      note: detail.nodeTitle ? `节点「${detail.nodeTitle}」` : "画布内生成节点的标识"
    });
  }
  return rows;
}

/** 「复制全部」的纯文本：带标签的编号清单，便于直接贴给开发或上游排查。 */
function technicalCopyLines(detail: TaskExecutionDetail, identities: readonly TechnicalIdentity[]): string[] {
  const lines: string[] = [];
  if (detail.upstreamTaskId) lines.push(`上游任务号: ${detail.upstreamTaskId}`);
  for (const identity of identities) lines.push(`${identity.label}: ${identity.value}`);
  if (detail.result?.storageKey) lines.push(`产物存储键: ${detail.result.storageKey}`);
  return lines;
}

/** 「复制全部」：一次拿到带标签的编号清单，排障时不用逐行点复制。 */
function CopyAllButton({ lines }: { lines: readonly string[] }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  return (
    <button
      type="button"
      className="task-monitor__copy-all"
      aria-label="复制全部技术信息"
      onClick={() => {
        void copyToClipboard(lines.join("\n")).then((ok) => setStatus(ok ? "copied" : "error"));
      }}
    >
      {status === "copied" ? "已复制" : status === "error" ? "复制失败" : "复制全部"}
    </button>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  return (
    <span className="task-monitor__copy" role="group" aria-label={`${label} ${value}`}>
      <code>{value}</code>
      <IconButton
        size="sm"
        label={`复制${label}`}
        onClick={() => {
          void copyToClipboard(value).then((ok) => setStatus(ok ? "copied" : "error"));
        }}
      >
        {status === "copied" ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
      <span role="status" aria-live="polite" className="visually-hidden">
        {status === "copied" ? "已复制" : status === "error" ? "复制失败" : ""}
      </span>
    </span>
  );
}

function ResultPreview({
  result,
  resolveMediaUrl
}: {
  result: NonNullable<TaskExecutionDetail["result"]>;
  resolveMediaUrl?: (storageKey: string) => string;
}) {
  const [failed, setFailed] = useState(false);
  // 缩略图 → 放大：只在本面板内展开/收起，不新开弹层，Esc 仍只负责关闭详情。
  const [zoomed, setZoomed] = useState(false);
  const toggleZoom = () => setZoomed((value) => !value);
  if (result.mediaKind === "text") {
    return (
      <div className="task-monitor__result" data-media="text">
        {result.textTruncated ? <p className="task-monitor__muted">文本摘要已截断</p> : null}
        <pre>{result.text ?? "—"}</pre>
      </div>
    );
  }
  if (!result.storageKey || !resolveMediaUrl) return <p className="task-monitor__muted">结果（无可用预览）</p>;
  const url = resolveMediaUrl(result.storageKey);
  const zoomable = result.mediaKind === "image" || result.mediaKind === "video";
  return (
    <div className="task-monitor__result" data-media={result.mediaKind} data-zoomed={zoomed ? "true" : undefined}>
      {failed ? (
        <p role="alert" className="task-monitor__error">
          结果无法读取
          <Button size="sm" tone="ghost" onClick={() => setFailed(false)}>重试</Button>
        </p>
      ) : result.mediaKind === "image" ? (
        <button
          type="button"
          className="task-monitor__thumb"
          aria-label={zoomed ? "缩小结果预览" : "放大结果预览"}
          aria-pressed={zoomed}
          onClick={toggleZoom}
        >
          <img src={url} alt="任务结果图片" loading="lazy" onError={() => setFailed(true)} />
        </button>
      ) : result.mediaKind === "video" ? (
        <video controls preload="metadata" src={url} poster={result.poster?.storageKey ? resolveMediaUrl(result.poster.storageKey) : undefined} onError={() => setFailed(true)} />
      ) : (
        <AudioPlayer url={url} />
      )}
      {zoomable || result.durationSeconds !== undefined ? (
        <div className="task-monitor__result-actions">
          {zoomable ? (
            <Button size="sm" tone="ghost" onClick={toggleZoom}>
              {zoomed ? "缩小预览" : "放大预览"}
            </Button>
          ) : null}
          {result.durationSeconds !== undefined ? <span className="task-monitor__muted">时长 {result.durationSeconds}s</span> : null}
        </div>
      ) : null}
    </div>
  );
}
