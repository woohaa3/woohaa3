/**
 * 查找作品面板（change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
 *
 * 页面内搜索面板：按名称/类型检索当前画布，键盘选择结果并定位。
 * 只读仍可定位；结果在点击前失效时提示并刷新，不向原点跳转。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import { searchCanvasNodes, type CanvasSearchKind, type CanvasSearchResult } from "../domain/canvas-search.js";
import type { CanvasSearchStore } from "../services/canvas-search-store.js";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { CloseIcon, LocateIcon, SearchIcon } from "@woohaa3/ui/icons";

export type CanvasSearchPanelProps = {
  store: CanvasSearchStore;
  /** 当前授权画布（working projection 的 committed 部分）。 */
  getCanvas: () => ServerCanvas | null;
  subscribeCanvas?: (notify: () => void) => () => void;
  /** 定位并选择结果；失效时返回 ok:false。 */
  onLocate: (nodeId: string) => { ok: boolean; reason?: string };
  onRename?: (nodeId: string, title: string, expectedData: CanvasNodeData | null) => Promise<{ ok: boolean; reason?: string }>;
  /** 取消/关闭时恢复焦点到传入元素。 */
  onRequestFocusRestore?: () => void;
};

const KIND_OPTIONS: readonly { kind: CanvasSearchKind; label: string }[] = [
  { kind: "text", label: "文字" },
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "audio", label: "音频" },
  { kind: "model3d", label: "3D 模型" },
  { kind: "composite-asset", label: "复合资产" },
  { kind: "scene-area", label: "导演区" },
  { kind: "world-camera", label: "镜头" },
  { kind: "workflow-group-2d", label: "节点组" }
];

const noCanvasSubscription = () => () => {};
const noCanvasSnapshot = () => null;

export function CanvasSearchPanel({ store, getCanvas, subscribeCanvas, onLocate, onRename, onRequestFocusRestore }: CanvasSearchPanelProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const subscribedCanvas = useSyncExternalStore(subscribeCanvas ?? noCanvasSubscription,
    subscribeCanvas ? getCanvas : noCanvasSnapshot, noCanvasSnapshot);
  const canvas = subscribeCanvas ? subscribedCanvas : getCanvas();
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState<{ nodeId: string; title: string; expectedData: CanvasNodeData | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const results = useMemo(
    () => (canvas ? searchCanvasNodes(canvas, { query: snapshot.query, kinds: snapshot.kinds }) : []),
    [canvas, snapshot.query, snapshot.kinds]
  );

  useEffect(() => {
    if (snapshot.open) inputRef.current?.focus();
  }, [snapshot.open]);

  if (!snapshot.open) return null;

  const locate = (result: CanvasSearchResult) => {
    const outcome = onLocate(result.nodeId);
    setFailure(outcome.ok ? null : (outcome.reason ?? "目标作品已不存在"));
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    const next = Math.max(0, Math.min(results.length - 1, snapshot.activeIndex + delta));
    store.setActiveIndex(next);
  };

  const toggleKind = (kind: CanvasSearchKind) => {
    const set = new Set(snapshot.kinds);
    if (set.has(kind)) set.delete(kind);
    else set.add(kind);
    store.setKinds(KIND_OPTIONS.map((option) => option.kind).filter((item) => set.has(item)));
  };

  const active = results[snapshot.activeIndex];

  return (
    <div className="canvas-search" role="dialog" aria-modal="false" aria-label="查找作品" data-testid="canvas-search">
      <div className="canvas-search__header">
        <SearchIcon className="canvas-search__icon" />
        <input
          ref={inputRef}
          className="canvas-search__input"
          type="search"
          value={snapshot.query}
          placeholder="按名称或类型查找作品"
          aria-label="查找作品"
          autoComplete="off"
          onChange={(event) => store.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
            if (event.key === "Home") { event.preventDefault(); store.setActiveIndex(0); return; }
            if (event.key === "End") { event.preventDefault(); store.setActiveIndex(Math.max(0, results.length - 1)); return; }
            if (event.key === "Enter") {
              event.preventDefault();
              if (active) locate(active);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              store.close();
              onRequestFocusRestore?.();
            }
          }}
        />
        <IconButton
          className="canvas-search__close"
          label="关闭查找"
          size="sm"
          onClick={() => {
            store.close();
            onRequestFocusRestore?.();
          }}
        >
          <CloseIcon />
        </IconButton>
      </div>

      <div className="canvas-search__filters" role="group" aria-label="类型筛选">
        {KIND_OPTIONS.map((option) => (
          <Button
            key={option.kind}
            size="sm"
            tone={snapshot.kinds.includes(option.kind) ? "primary" : "neutral"}
            aria-pressed={snapshot.kinds.includes(option.kind)}
            className="canvas-search__filter"
            onClick={() => toggleKind(option.kind)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {failure ? <p className="canvas-search__failure" role="alert">{failure}</p> : null}

      {results.length === 0 ? (
        <p className="canvas-search__empty" role="status">没有找到匹配的作品</p>
      ) : (
        <ul className="canvas-search__results" role="listbox" aria-label="查找结果">
          {results.map((result, index) => (
            <li
              key={result.nodeId}
              role="option"
              aria-selected={index === snapshot.activeIndex}
              className={`canvas-search__result${index === snapshot.activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => store.setActiveIndex(index)}
              onClick={() => locate(result)}
            >
              <div className="canvas-search__result-content">
              {renaming?.nodeId === result.nodeId ? <input className="canvas-search__input" value={renaming.title} disabled={saving}
                onClick={event => event.stopPropagation()} onChange={event => setRenaming(current => current && { ...current, title: event.target.value })}
                onKeyDown={event => event.stopPropagation()} /> : <span className="canvas-search__result-name" title={result.name}>{result.name}</span>}
              <span className="canvas-search__result-meta">
                {result.typeLabel}
                {result.groupName ? ` · ${result.groupName}` : ""}
                <span className="canvas-search__result-id" title={result.nodeId}>#{result.shortId}</span>
              </span>
              </div>
              {onRename ? <Button size="sm" disabled={saving} onClick={event => {
                event.stopPropagation();
                if (renaming?.nodeId !== result.nodeId) { setRenaming({ nodeId: result.nodeId, title: result.name, expectedData: structuredClone(canvas?.nodeData[result.nodeId] ?? null) }); return; }
                setSaving(true);
                void onRename(result.nodeId, renaming.title, renaming.expectedData).then(outcome => {
                  if (outcome.ok) setRenaming(null); else setFailure(outcome.reason ?? "重命名未保存");
                }).catch(() => setFailure("重命名未保存，请重试")).finally(() => setSaving(false));
              }}>{renaming?.nodeId === result.nodeId ? "保存名称" : "重命名"}</Button> : null}
              {renaming?.nodeId === result.nodeId ? <Button size="sm" disabled={saving} onClick={event => { event.stopPropagation(); setRenaming(null); }}>取消</Button> : null}
              <IconButton
                className="canvas-search__result-locate"
                label={`定位 ${result.name}`}
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  locate(result);
                }}
              >
                <LocateIcon />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
