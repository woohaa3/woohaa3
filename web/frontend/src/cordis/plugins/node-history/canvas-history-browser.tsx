/**
 * 画布「全部生成历史」弹窗（只读）
 * （change: add-canvas-generation-history-dialog）。
 *
 * 左侧种类筛选 + 列表，右侧选中项类型化预览与元信息。交互形态对齐参考实现，但数据源是
 * 服务端画布级历史读模型，且**刻意移除所有写入动作**（无「设为当前」「添加到画布」）。
 *
 * 通过 Dialog primitives 渲染，焦点/Escape/inert/输入隔离由 Dialog Host 统一拥有。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NodeGenerationKind } from "@woohaa3/contracts";
import type { ModelThumbnailRenderer } from "./model-thumbnail-render.js";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { Button, SegmentedControl } from "@woohaa3/ui";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import { HistoryPreview } from "./preview.js";
import { CanvasHistoryController, type CanvasHistoryClient, type CanvasHistoryFilter } from "./canvas-history-controller.js";

const FILTERS: Array<{ id: CanvasHistoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "text", label: "文本" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "motion", label: "动作" },
  { id: "model", label: "模型" }
];

const KIND_LABELS: Record<NodeGenerationKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  motion: "动作",
  model: "模型"
};

/** 纯展示组件（无 Context 依赖；state 为 null 时不渲染，可独立预览/测试）。 */
export function CanvasHistoryBrowser({
  controller,
  onClose,
  onOpenNodeVersion,
  canOpenNodeVersion,
  embedded = false,
  active = true,
  renderModelThumbnail
}: {
  embedded?: boolean;
  active?: boolean;
  controller: CanvasHistoryController;
  onClose: () => void | boolean;
  /**
   * 显式「前往节点查看版本」（change: 2026-10-09-improve-canvas-workflow，任务 6.3）。
   * 缺省时不显示该入口（独立预览/测试用）；实际恢复仍在节点版本面板完成，总览只负责跳转。
   */
  onOpenNodeVersion?: (item: { nodeId: string; entryId: string }) => void;
  /** 目标是否可跳转；返回不可用原因时禁用并说明。 */
  canOpenNodeVersion?: (nodeId: string) => { ok: true } | { ok: false; reason: string };
  /**
   * 页面内模型缩略图渲染器
   * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
   */
  renderModelThumbnail?: ModelThumbnailRenderer;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [showDetail, setShowDetail] = useState(false);
  const scrollTop = useRef(0);
  const listPanel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active && listPanel.current) listPanel.current.scrollTop = scrollTop.current;
  }, [active, showDetail]);
  const [compact, setCompact] = useState(() => globalThis.matchMedia?.("(max-width: 1100px)").matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.("(max-width: 1100px)");
    if (!query) return;
    const update = () => setCompact(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  if (!state) return null;
  const selected = state.items.find((item) => item.entryId === state.selectedEntryId) ?? state.items[0] ?? null;
  const counts: Record<CanvasHistoryFilter, number> = {
    all: state.kindCounts.text + state.kindCounts.image + state.kindCounts.video + state.kindCounts.audio + state.kindCounts.model,
    ...state.kindCounts
  };

  return (
    <div className={`canvas-history${embedded ? " canvas-history--embedded" : ""}`} data-detail={showDetail} data-testid="canvas-history-browser">
      <SegmentedControl
        className="canvas-history__filters"
        optionClassName="canvas-history__filter"
        label="生成历史筛选"
        value={state.filter}
        onValueChange={(next) => { setShowDetail(false); scrollTop.current = 0; void controller.setFilter(next as typeof state.filter); }}
        options={FILTERS.map((filter) => ({
          value: filter.id,
          ariaLabel: `${filter.label}，${counts[filter.id]} 条`,
          label: (
            <>
              <span>{filter.label}</span>
              <b>{counts[filter.id]}</b>
            </>
          )
        }))}
      />

      <div ref={listPanel} className="canvas-history__list-panel" onScroll={event => { if (active && (!compact || !showDetail)) scrollTop.current = event.currentTarget.scrollTop; }}>
        <div className="canvas-history__list">
          {state.status === "loading" ? <div className="canvas-history__state" role="status">正在加载生成历史…</div> : null}
          {state.status === "empty" ? (
            <div className="canvas-history__state" role="status">
              <strong>暂无生成记录</strong>
              <small>完成生成后，结果会显示在这里。</small>
            </div>
          ) : null}
          {state.error ? (
            <div className="canvas-history__state canvas-history__state--error" role="alert">
              <span>{state.error ?? "生成历史加载失败"}</span>
              <button type="button" onClick={() => void (state.items.length && state.nextCursor ? controller.loadMore() : controller.retry())}>重试</button>
            </div>
          ) : null}
          {state.items.map((item) => (
            <button
              key={item.entryId}
              type="button"
              className={`canvas-history__item${selected?.entryId === item.entryId ? " is-selected" : ""}`}
              aria-label={`查看 ${item.nodeTitle} 的${KIND_LABELS[item.kind]}生成结果`}
              onClick={() => { controller.select(item.entryId); setShowDetail(true); }}
            >
              {active ? <HistoryPreview preview={item.preview} renderModelThumbnail={renderModelThumbnail} /> : null}
              <span className="canvas-history__item-copy">
                <strong>{item.nodeTitle}</strong>
                <small>{KIND_LABELS[item.kind]} · {formatTime(item.createdAt)}</small>
              </span>
              {item.current ? <span className="canvas-history__badge">当前</span> : null}
            </button>
          ))}
        </div>
        {state.nextCursor && state.status === "ready" ? (
          <button
            type="button"
            className="canvas-history__more"
            disabled={state.loadingMore}
            onClick={() => void controller.loadMore()}
          >
            {state.loadingMore ? "加载中…" : "加载更多"}
          </button>
        ) : null}
      </div>

      {selected ? (
        <div className="canvas-history__detail">
          {embedded ? <Button className="canvas-history__back" size="sm" onClick={() => setShowDetail(false)}>返回列表</Button> : null}
          <div className="canvas-history__detail-preview">
            {active && (!embedded || !compact || showDetail) ? <HistoryPreview key={selected.entryId} preview={selected.preview} thumbnail={false} renderModelThumbnail={renderModelThumbnail} /> : null}
          </div>
          <div className="canvas-history__detail-title">
            <strong>{selected.nodeTitle}</strong>
            <small>{formatTime(selected.createdAt)} · {selected.source.label}</small>
          </div>
          <dl className="canvas-history__meta">
            <dt>内容类型</dt>
            <dd>{KIND_LABELS[selected.kind]}</dd>
            <dt>来源节点</dt>
            <dd>{selected.nodeTitle}</dd>
            <dt>是否当前版本</dt>
            <dd>{selected.current ? "是" : "否"}</dd>
          </dl>
          {onOpenNodeVersion ? (
            <NodeVersionJump
              key={selected.entryId}
              item={selected}
              onOpenNodeVersion={onOpenNodeVersion}
              canOpenNodeVersion={canOpenNodeVersion}
              onClose={onClose}
            />
          ) : null}
        </div>
      ) : null}

      <div className="canvas-history__footer">
        <span>{state.total} 条记录</span>
        {embedded ? null : <Button onClick={onClose}>关闭</Button>}
      </div>
    </div>
  );
}

/** A fresh controller belongs to one center instance and canvas, never a long-lived plugin cache. */
export function createCanvasHistoryWorkspace(
  client: CanvasHistoryClient,
  onOpenNodeVersion: (item: { nodeId: string; entryId: string }) => void,
  canOpenNodeVersion: (nodeId: string) => { ok: true } | { ok: false; reason: string },
  renderModelThumbnail?: ModelThumbnailRenderer
) {
  return function CanvasHistoryWorkspace({ canvasId, active, onClose }: { canvasId: string; active: boolean; onClose: () => void }) {
    const [controller] = useState(() => new CanvasHistoryController(client));
    useEffect(() => {
      void controller.open({ canvasId });
      return () => controller.close();
    }, [canvasId, controller]);
    return <CanvasHistoryBrowser controller={controller} active={active} embedded onClose={onClose} onOpenNodeVersion={onOpenNodeVersion} canOpenNodeVersion={canOpenNodeVersion}
      {...(renderModelThumbnail ? { renderModelThumbnail } : {})} />;
  };
}

/**
 * Dialog renderer：打开时按固定画布加载首页；关闭仅清除本地状态。
 * 只读，不产生任何画布写入。
 */
export function createCanvasHistoryRenderer(
  controller: CanvasHistoryController,
  canvasId: string,
  onOpenNodeVersion?: (item: { nodeId: string; entryId: string }) => void,
  canOpenNodeVersion?: (nodeId: string) => { ok: true } | { ok: false; reason: string }
) {
  return function CanvasHistoryRenderer({ instance, requestClose }: DialogRendererProps) {
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
    useEffect(() => {
      if (!state) void controller.open({ canvasId });
    }, [state, canvasId]);
    return (
      <Dialog.Content
        variant="standard"
        size="lg"
        labelledBy={`${instance.instanceId}-title`}
        instanceId={instance.instanceId}
        onOverlayClick={requestClose}
      >
        <DialogHeader onClose={requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>作品生成历史</DialogTitle>
        </DialogHeader>
        <DialogBody className="canvas-history__body">
          <CanvasHistoryBrowser
            controller={controller}
            onClose={requestClose}
            {...(onOpenNodeVersion ? { onOpenNodeVersion } : {})}
            {...(canOpenNodeVersion ? { canOpenNodeVersion } : {})}
          />
        </DialogBody>
      </Dialog.Content>
    );
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * 总览到节点版本的显式跳转（change: 2026-10-09-improve-canvas-workflow，任务 6.3）。
 *
 * 只读总览不提供直接恢复；点击时重新校验目标，正常关闭总览后才导航并打开节点版本面板。
 * 目标失效时禁用并说明原因，不打开错误节点。
 */
function NodeVersionJump({
  item,
  onOpenNodeVersion,
  canOpenNodeVersion,
  onClose
}: {
  item: { nodeId: string; entryId: string };
  onOpenNodeVersion: (item: { nodeId: string; entryId: string }) => void;
  canOpenNodeVersion?: (nodeId: string) => { ok: true } | { ok: false; reason: string };
  onClose: () => void | boolean;
}) {
  const [jumpError, setJumpError] = useState<string | null>(null);
  const availability = canOpenNodeVersion?.(item.nodeId) ?? { ok: true as const };
  return (
    <div className="canvas-history__jump">
      <p className="canvas-history__jump-note">此条目属于某个作品的生成历史。版本恢复请前往该节点。</p>
      <Button
        size="sm"
        tone="primary"
        disabled={!availability.ok}
        title={availability.ok ? undefined : availability.reason}
        onClick={() => {
          const current = canOpenNodeVersion?.(item.nodeId);
          if (current && !current.ok) { setJumpError(current.reason); return; }
          if (onClose() === false) { setJumpError("当前界面无法关闭，请结束操作后重试。"); return; }
          onOpenNodeVersion({ nodeId: item.nodeId, entryId: item.entryId });
        }}
      >
        前往节点查看版本
      </Button>
      {jumpError ? <p className="canvas-history__jump-reason">{jumpError}</p> : null}
      {!availability.ok ? (
        <span className="canvas-history__jump-reason" role="note">{availability.reason}</span>
      ) : null}
    </div>
  );
}
