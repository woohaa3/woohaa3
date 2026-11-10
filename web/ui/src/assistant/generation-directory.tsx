import { useEffect, useMemo, useRef, useState } from "react";
import type { GenerationModelEntry, GenerationSourceEntry } from "@woohaa3/contracts";
import { Popover } from "../primitives/Popover.js";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "../icons/index.js";

export type GenerationDirectoryProps = {
  entries: readonly GenerationModelEntry[]; sources: readonly GenerationSourceEntry[];
  selected: string; open: boolean; onOpenChange(open: boolean): void;
  onSelect(entry: GenerationModelEntry): void; onRetry?(sourceIdentity: string): void;
  onManage?(): void; recent?: readonly string[]; disabled?: boolean;
  placeholder?: string; loading?: boolean; error?: string; onRetryAll?(): void;
};
const ROW_HEIGHT = 64;
/** Pure controlled directory. Source browsing is deliberately not an execution selection. */
export function GenerationModelDirectory(props: GenerationDirectoryProps) {
  const [query, setQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [source, setSource] = useState("");
  const [scroll, setScroll] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const selected = props.entries.find(e => e.identity === props.selected);
  useEffect(() => {
    if (props.open) { setQuery(""); setSource(""); setSourceQuery(""); setScroll(0); }
  }, [props.open]);
  const entries = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const matches = props.entries.filter(e => (!source || e.sourceIdentity === source) &&
      (!q || [e.label, e.modelId, e.sourceLabel, e.detail].some(v => v?.toLocaleLowerCase().includes(q))));
    if (q) return matches;
    const recent = new Map((props.recent ?? []).map((id, index) => [id, index]));
    return matches.map((entry, index) => ({ entry, index })).sort((a, b) =>
      (recent.get(a.entry.identity) ?? Infinity) - (recent.get(b.entry.identity) ?? Infinity) || a.index - b.index).map(v => v.entry);
  }, [props.entries, props.recent, query, source]);
  useEffect(() => { setScroll(0); if (list.current) list.current.scrollTop = 0; }, [query, source]);
  const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 3);
  const end = Math.min(entries.length, start + 16);
  useEffect(() => {
    if (props.open && !query && !source) {
      const index = entries.findIndex(e => e.identity === props.selected);
      const top = Math.max(0, index * ROW_HEIGHT);
      setScroll(top); if (list.current) list.current.scrollTop = top;
    }
  }, [props.open]);
  const incomplete = props.sources.filter(s => s.status !== "ready");
  const summary = selected ? `${selected.label} · ${selected.sourceLabel}` : props.placeholder || props.selected || "来源与模型";
  return <div className="mc-panel__model assistant-model-selector">
    <Popover open={props.open && !props.disabled} onOpenChange={props.onOpenChange} side="top" align="start"
      label="来源与模型" className="generation-directory" trigger={
        <button type="button" className="mc-panel__model-trigger" aria-label="来源与模型" disabled={props.disabled} title={summary}>
          <span className="mc-panel__model-label">{summary}</span><ChevronDownIcon className="mc-panel__chevron" />
        </button>}>
      <div className="generation-directory__search"><SearchIcon size={16} /><input placeholder="搜索模型名称、ID 或来源" value={query} onChange={e => setQuery(e.target.value)} /></div>
      {props.loading || props.error ? <div className="generation-directory__incomplete">{props.error || "正在读取来源…"}{props.error && props.onRetryAll ? <button type="button" onClick={props.onRetryAll}>重试来源</button> : null}</div> : null}
      <div className="generation-directory__body">
        <div className="generation-directory__sources">
          {props.sources.length > 8 ? <input placeholder="查找来源" value={sourceQuery} onChange={e => setSourceQuery(e.target.value)} /> : null}
          <div className="generation-directory__source-list">
            <button type="button" data-selected={!source} onClick={() => setSource("")}>全部来源</button>
            {props.sources.filter(s => s.label.toLocaleLowerCase().includes(sourceQuery.toLocaleLowerCase())).map(s => <button type="button" key={s.identity} title={s.error || s.unavailableReason || s.label} data-selected={source === s.identity} onClick={() => setSource(s.identity)}>{s.label}<small>{s.status === "loading" ? "读取中" : s.status === "failed" ? "读取失败" : s.status === "unloaded" ? "尚未读取" : ""}</small></button>)}
          </div>
        </div>
        <div className="generation-directory__results">
          {incomplete.length ? <div className="generation-directory__incomplete">部分来源尚未完整读取{incomplete.filter(s => !source || s.identity === source).map(s => <div key={s.identity}>{s.label}：{s.error || (s.status === "loading" ? "正在读取" : "尚未读取")}{s.status !== "loading" && props.onRetry ? <button type="button" onClick={() => props.onRetry?.(s.identity)}>重试</button> : null}</div>)}</div> : null}
          <div ref={list} className="generation-directory__list" onScroll={e => setScroll(e.currentTarget.scrollTop)}>
            {!entries.length ? <div className="generation-directory__empty">{incomplete.length ? "已读取的来源中无匹配" : props.sources.length ? "当前筛选下无结果" : props.error ? "来源读取失败" : props.loading ? "正在读取来源…" : "尚未配置来源"}<button type="button" onClick={() => { setQuery(""); setSource(""); }}>清除搜索并回到全部来源</button></div> : <div style={{ height: entries.length * ROW_HEIGHT, position: "relative" }}>{entries.slice(start, end).map((e, index) => <button type="button" key={e.identity} className="generation-directory__model" aria-label={e.label} data-selected={e.identity === props.selected} style={{ position: "absolute", top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }} disabled={!!e.unavailableReason} title={[e.label, e.modelId, e.sourceLabel, e.detail, e.unavailableReason].filter(Boolean).join("\n")} onClick={() => { if (!e.unavailableReason) { props.onSelect(e); props.onOpenChange(false); } }}>
              <span className="generation-directory__model-text"><strong>{e.label}</strong><small>{e.modelId || "使用助手默认模型"}{e.detail ? ` · ${e.detail}` : ""}</small>{e.unavailableReason ? <small>{e.unavailableReason}</small> : null}</span><span className="generation-directory__origin">{!query && props.recent?.includes(e.identity) ? <small>最近使用</small> : null}{e.sourceLabel}</span>{e.identity === props.selected ? <CheckIcon size={15} /> : null}
            </button>)}</div>}
          </div>
        </div>
      </div>
      <footer className="generation-directory__footer"><span title={summary}>当前：{summary}</span>{props.onManage ? <button type="button" onClick={props.onManage}>管理来源</button> : null}</footer>
    </Popover>
  </div>;
}
