/**
 * 节点生成历史面板（非模态 Web）
 * （change: add-canvas-node-generation-history，任务 3.2 / 3.3 / 4.2 / design D4/D7）。
 *
 * 通过 `canvas.overlay` 挂载；拥有加载/空/错误/加载更多/选中/当前/恢复 busy/失败状态。
 * 面板自身消费 pointer/wheel，打开与关闭不改变节点 selection、不提交 Canvas 命令。
 *
 * 模型列表项使用受控缓存缩略图；不创建实时 renderer。只读/syncing/offline 会话允许浏览
 * 与预览，但禁用「设为当前」。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { NodeHistoryController } from "./controller.js";
import { CURRENT_PRESENTATION_ID } from "./controller.js";
import { HistoryPreview } from "./preview.js";
import type { ModelThumbnailRenderer } from "./model-thumbnail-render.js";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { Tooltip } from "@woohaa3/ui/primitives";
import { CloseIcon } from "@woohaa3/ui/icons";

export type NodeHistoryPanelProps = {
  controller: NodeHistoryController;
  /** 当前会话是否可写；false 时禁用「设为当前」。 */
  writable: boolean;
  /**
   * 覆盖打开模式；缺省统一为右侧 `drawer`（所有类型的历史面板位置一致）。
   * 仅测试/嵌入场景需要固定为 `panel` 时才显式传入。
   */
  variant?: "panel" | "drawer";
  /** 右侧实际占用宽度（供 content rect 投影）；drawer 模式调用。 */
  onWidthChange?: (width: number) => void;
  /**
   * 关闭入口（change: fix-model-focus-navigation-and-camera-parity，task 2.4）。
   * UI 只提交 Navigation intent；controller `close()` 仅由 route cleanup 调用。
   */
  onClose?: () => void;
  /**
   * 页面内模型缩略图渲染器
   * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
   */
  renderModelThumbnail?: ModelThumbnailRenderer;
  /**
   * 刷新固定当前首项的草稿状态（change: 2026-10-27-add-image-history-to-photocraft-focus）。
   *
   * 图片编辑器与 drawer 并排时可继续编辑，而编辑不会推进画布回流；面板打开期间按短周期
   * 重读宿主能力，保证「设为当前」的禁用状态与「当前版本 · 未保存」文案及时更新。
   */
  onRefreshCurrent?: () => void;
};

export function NodeHistoryPanel({ controller, writable, variant, onWidthChange, onClose, renderModelThumbnail, onRefreshCurrent }: NodeHistoryPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 统一右侧抽屉：五类节点的历史面板位置一致（模型以外的类型同样贴右）。
  const isDrawer = (variant ?? "drawer") === "drawer";

  // 草稿状态不是 canonical 回流的一部分：面板打开期间短周期重读，避免用户并排编辑后
  // 「设为当前」仍按旧的 saved 状态可点。回调自身按值去重，不会触发无谓 emit。
  useEffect(() => {
    if (!onRefreshCurrent) return undefined;
    onRefreshCurrent();
    const timer = setInterval(onRefreshCurrent, 500);
    return () => clearInterval(timer);
  }, [onRefreshCurrent, state?.nodeId]);

  // 投影实际占用宽度（ResizeObserver）；不改变 canonical 状态。
  useEffect(() => {
    const element = rootRef.current;
    if (!element || !onWidthChange || !isDrawer) return undefined;
    const observer = new ResizeObserver(() => onWidthChange(element.getBoundingClientRect().width));
    observer.observe(element);
    onWidthChange(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [onWidthChange, isDrawer]);

  if (!state) return null;

  const title = kindLabel(state.kind);
  const applying = state.applyingEntryId !== null;

  // Escape 收起抽屉（A10）。
  //
  // 抽屉盖住右侧与顶栏的一部分；用户最自然的动作是按 Esc 收起。此前 Esc 只会被画布键盘层
  // 消费（退出整个聚焦），抽屉本身不响应，看起来像「收不掉」。
  //
  // 实现按对话框语义走：打开时把焦点交给抽屉本身，Escape 由**抽屉元素**消费并停止冒泡。
  // 不挂 document 级监听：焦点/Tab/Escape 契约归 Radix 适配层（dialogs 架构审计），
  // 抽屉不抢焦点也就没有键盘归属 —— 两者一起解决。
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    element.focus({ preventScroll: true });
    return undefined;
  }, [state?.nodeId]);
  useEffect(() => {
    if (!onClose) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const element = rootRef.current;
    element?.addEventListener("keydown", onKeyDown);
    return () => element?.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={`node-history ${isDrawer ? "node-history--drawer" : "node-history--panel"}`}
      role="dialog"
      aria-label={`${title}节点版本`}
      // 抽屉自己接键盘（Esc 收起）：需要焦点才能收到按键，因此可聚焦。
      tabIndex={-1}
      data-node-history-panel="true"
      // 面板自身消费 pointer/wheel：阻止驱动画布相机/视口。
      onPointerDown={(event) => { event.stopPropagation(); }}
      onWheel={(event) => { event.stopPropagation(); }}
    >
      <header className="node-history__header">
        <span className="node-history__title">{title}节点版本</span>
        <div className="node-history__header-actions">
          {/* 清空入口只对可写会话、且确实存在历史版本时提供（当前版本不算历史）。 */}
          {writable && state.canClear && state.items.length > 0 ? (
            <ClearHistoryAction controller={controller} clearing={state.clearing} />
          ) : null}
          <Tooltip content="关闭节点版本">
            <IconButton
              className="node-history__close"
              label="关闭节点版本"
              size="sm"
              onClick={() => onClose?.()}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div className="node-history__body" data-node-history-status={state.status}>
        {state.status === "loading" ? <div className="node-history__state" role="status">正在加载节点版本…</div> : null}
        {state.error ? (
          <div className="node-history__state node-history__state--error" role="alert">{state.error ?? "节点版本加载失败"}</div>
        ) : null}

        {/* 固定「当前版本」首项：身份独立于 entryId，不参与 cursor/total/容量（design D8）。 */}
        <ul className="node-history__list node-history__list--current">
          <NodeHistoryCurrentCard
            current={state.current}
            // 当前版本的缩略图取「被标记为 current 的已归档条目」的受控预览：当前内容就是
            // 那条归档写出来的。没有匹配条目（从未归档）时才回退到空占位（A3：之前固定是空白格）。
            preview={state.items.find((item) => item.current)?.preview ?? null}
            selected={state.selectedEntryId === CURRENT_PRESENTATION_ID}
            onSelect={() => void controller.select(CURRENT_PRESENTATION_ID)}
            {...(renderModelThumbnail ? { renderModelThumbnail } : {})}
          />
        </ul>

        {state.status === "empty" && state.presentations.length === 0 ? <div className="node-history__state" role="status">还没有历史记录</div> : null}
        {state.error || state.presentations.some(item => item.state === "succeeded" && !item.entryId) ? <Button size="sm" onClick={() => void controller.refresh()}>刷新历史</Button> : null}

        {state.presentations.length > 0 ? (
          <ul className="node-history__list">
            {[...state.presentations].reverse().map((record) => record.history ? (
              <NodeHistoryCard
                key={record.presentationId}
                item={record.history}
                selected={state.selectedEntryId === record.entryId || state.selectedEntryId === record.presentationId}
                applying={state.applyingEntryId === record.entryId || state.pendingCurrentEntryId === record.entryId}
                writable={writable && state.current.draftState === "saved"}
                controller={controller}
                {...(renderModelThumbnail ? { renderModelThumbnail } : {})}
              />
            ) : (
              <li key={record.presentationId} className={`node-history__card${state.selectedEntryId === record.presentationId ? " node-history__card--selected" : ""}`}>
                <Button onClick={() => void controller.select(record.presentationId)}>
                  {record.localFailure ? "提交未受理" : ({ queued: "排队中", running: "执行中", succeeded: "历史保存中", failed: "失败", cancelled: "已取消", interrupted: "已中断", partial: "部分完成" })[record.state]}
                  {record.progress !== undefined && (record.state === "queued" || record.state === "running") ? ` · ${record.progress}%` : ""}
                </Button>
                {record.error ? <p className="node-history__state node-history__state--error">{record.error}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {state.nextCursor && state.status === "ready" ? (
          <Button className="node-history__more" disabled={state.loadingMore} onClick={() => void controller.loadMore()}>
            {state.loadingMore ? "加载中…" : "加载更多"}
          </Button>
        ) : null}

        {state.selectedEntryId && state.selectedEntryId !== CURRENT_PRESENTATION_ID && state.detail ? (
          <NodeHistoryDetail state={state} />
        ) : null}

        {state.applyError ? <div className="node-history__state node-history__state--error" role="alert">{state.applyError}</div> : null}
        {state.clearError ? <div className="node-history__state node-history__state--error" role="alert">{state.clearError}</div> : null}
        {applying ? <div className="node-history__applying" role="status">正在恢复…</div> : null}
        {state.clearing ? <div className="node-history__applying" role="status">正在清空历史…</div> : null}
      </div>
    </div>
  );
}

/**
 * 清空历史入口：两步确认，避免误删全部版本。
 *
 * 历史条目本身不可撤销（只删索引，不回滚画布），因此必须显式二次确认；
 * 取消或失焦都回到未确认态。
 */
function ClearHistoryAction({ controller, clearing }: { controller: NodeHistoryController; clearing: boolean }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), 8000);
    return () => clearTimeout(timer);
  }, [confirming]);
  if (!confirming) {
    return (
      <Button
        className="node-history__clear"
        tone="danger"
        size="sm"
        disabled={clearing}
        onClick={() => setConfirming(true)}
      >
        {clearing ? "清空中…" : "清空历史"}
      </Button>
    );
  }
  return (
    <span className="node-history__clear-confirm" data-clear-confirm="true">
      <span className="node-history__clear-warning">清空后无法恢复这些版本</span>
      <Button
        className="node-history__clear"
        tone="danger"
        size="sm"
        disabled={clearing}
        onClick={() => { setConfirming(false); void controller.clear(); }}
      >
        确认清空
      </Button>
      <Button className="node-history__clear-cancel" size="sm" onClick={() => setConfirming(false)}>
        取消
      </Button>
    </span>
  );
}

function NodeHistoryCurrentCard({ current,
  preview,
  selected,
  onSelect,
  renderModelThumbnail
}: {
  current: import("./controller.js").NodeHistoryCurrentPresentation;
  /** 当前内容对应的受控预览（取「被标记为 current 的已归档条目」）；无则只显示空占位。 */
  preview?: import("@woohaa3/contracts").NodeHistoryPreview | null;
  selected: boolean;
  onSelect: () => void;
  renderModelThumbnail?: ModelThumbnailRenderer;
}) {
  const draftLabel =
    current.draftState === "unsaved" ? "当前版本 · 未保存"
    : current.draftState === "saving" ? "当前版本 · 保存中"
    : current.draftState === "history-pending" ? "当前版本 · 历史保存中"
    : current.draftState === "error" ? "当前版本 · 保存失败"
    : "当前版本";
  const unavailable = !current.hasOutput;
  return (
    <li
      className={`node-history__card node-history__card--current${selected ? " node-history__card--selected" : ""}`}
      data-current-entry="true"
    >
      <button type="button" className="node-history__select" aria-label="选择当前版本" onClick={onSelect}>
        {preview && !unavailable
          ? <HistoryPreview preview={preview} {...(renderModelThumbnail ? { renderModelThumbnail } : {})} />
          : <div className="node-history__thumb node-history__thumb--current" data-preview-kind="empty">
              <span className="node-history__thumb-fallback">当前</span>
            </div>}
        <div className="node-history__meta">
          <span className="node-history__time">{draftLabel}</span>
          <span className="node-history__source">{unavailable ? "当前暂无输出" : "节点当前内容"}</span>
        </div>
      </button>
      <div className="node-history__badges">
        <span className="node-history__badge node-history__badge--current">当前版本</span>
      </div>
    </li>
  );
}

function NodeHistoryCard({
  item,
  selected,
  applying,
  writable,
  controller,
  renderModelThumbnail
}: {
  item: NodeGenerationHistoryListItem;
  selected: boolean;
  applying: boolean;
  writable: boolean;
  controller: NodeHistoryController;
  renderModelThumbnail?: ModelThumbnailRenderer;
}) {
  const preview = item.preview;
  return (
    <li
      className={`node-history__card${selected ? " node-history__card--selected" : ""}${item.current ? " node-history__card--current" : ""}`}
      data-entry-id={item.entryId}
      data-current={item.current ? "true" : "false"}
      data-recoverable={item.recoverable ? "true" : "false"}
    >
      <button
        type="button"
        className="node-history__select"
        aria-label={`选择版本 ${item.entryId}`}
        onClick={() => void controller.select(item.entryId)}
      >
        <div className="node-history__thumb" data-preview-kind={preview.kind}>
          <HistoryPreview preview={preview} {...(renderModelThumbnail ? { renderModelThumbnail } : {})} />
        </div>
        <div className="node-history__meta">
          <span className="node-history__time">{formatTime(item.createdAt)}</span>
          <span className="node-history__source">{item.source.label}</span>
        </div>
      </button>

      <div className="node-history__badges">
        {item.current ? <span className="node-history__badge node-history__badge--current">当前版本</span> : null}
        {item.outcome && item.outcome !== "succeeded" ? (
          <span className="node-history__badge node-history__badge--failure" data-outcome={item.outcome}>
            {OUTCOME_LABELS[item.outcome]}
          </span>
        ) : null}
        {!item.recoverable ? <span className="node-history__badge node-history__badge--unrecoverable">不可恢复</span> : null}
        {applying ? <span className="node-history__badge node-history__badge--applying">恢复中</span> : null}
      </div>

      <Button
        className="node-history__apply"
        tone="primary"
        size="sm"
        disabled={!writable || !item.recoverable || item.current || applying}
        title={!writable ? "只读会话无法应用" : undefined}
        onClick={() => void controller.apply(item.entryId)}
      >
        设为当前
      </Button>
    </li>
  );
}

/** 非成功版本的展示标签（change: 2026-10-12-unify-generation-history-strip，design D3）。 */
const OUTCOME_LABELS: Record<string, string> = {
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  partial: "部分成功"
};

function NodeHistoryDetail({ state }: { state: NonNullable<ReturnType<NodeHistoryController["getState"]>> }) {
  const detail = state.detail;
  if (!detail) return null;
  return (
    <div className="node-history__detail" data-node-history-detail={detail.kind}>
      {detail.kind === "text" ? <pre className="node-history__detail-text">{detail.text}</pre> : null}
      {detail.kind === "model" ? (
        <>
          {detail.placement ? (
            <span className="node-history__detail-placement" data-node-history-placement="true">
              摆放：位移 ({fmt(detail.placement.offset.x)}, {fmt(detail.placement.offset.y)}, {fmt(detail.placement.offset.z)}) · 缩放 {fmt(detail.placement.scale)} · 旋转 {fmt(detail.placement.yaw)} rad
            </span>
          ) : null}
          <pre className="node-history__detail-script">{detail.modelScript}</pre>
        </>
      ) : null}
      {(detail.kind === "image" || detail.kind === "video" || detail.kind === "audio") ? (
        <span className="node-history__detail-meta">{detail.contentType} · {detail.size} B</span>
      ) : null}
      {detail.kind === "failure" ? (
        <div className="node-history__detail-failure" data-node-history-failure="true">
          <span className="node-history__detail-reason">失败原因：{detail.message}</span>
          {detail.code ? <span className="node-history__detail-code">错误码：{detail.code}</span> : null}
          {detail.inputSummary ? <span className="node-history__detail-input">输入摘要：{detail.inputSummary}</span> : null}
          {detail.baseline?.entryId ? (
            <span className="node-history__detail-baseline">
              可恢复执行前内容：{detail.baseline.entryId}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function kindLabel(kind: NodeGenerationHistoryListItem["kind"]): string {
  switch (kind) {
    case "text":
      return "文本";
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "model":
      return "模型";
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** 摆放数值：最多两位小数，去掉多余的 0。 */
function fmt(value: number): string {
  return Number.parseFloat(value.toFixed(2)).toString();
}
