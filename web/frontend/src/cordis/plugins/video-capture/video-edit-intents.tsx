/**
 * 视频编辑 dialog 右侧意图列表
 * （change: 2026-09-28-split-frontend-god-plugins，task 5；从 video-edit-dialog.tsx 拆出）。
 */
import { isVideoEditRange, type VideoEditIntent } from "@woohaa3/contracts";
import { useEffect, useState } from "react";
import { DialogIconButton } from "@woohaa3/ui/dialogs";
import { TrashIcon } from "@woohaa3/ui/icons";
import { formatVideoTime } from "./video-geometry.js";
import { MIN_RANGE_SECONDS } from "./video-geometry.js";

export function validateRangeInput(startText: string, endText: string, duration: number): string | null {
  if (!startText.trim() || !endText.trim()) return "请填写起止时间。";
  const start = Number(startText), end = Number(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end < 0 || start > duration) return `时间须在 0 到 ${duration} 秒之间。`;
  if (end - start < MIN_RANGE_SECONDS - 1e-9) return "区间至少为 0.05 秒。";
  return null;
}

function RangeEditor({ intent, duration, busy, update, onDirty }: { intent: VideoEditIntent; duration: number; busy: boolean; update: (patch: Partial<VideoEditIntent>) => void; onDirty: (dirty: boolean) => void }) {
  const [start, setStart] = useState(String(intent.startSeconds));
  const [end, setEnd] = useState(String(intent.endSeconds));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!dirty) { setStart(String(intent.startSeconds)); setEnd(String(intent.endSeconds)); } }, [intent.startSeconds, intent.endSeconds, dirty]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  const cancel = () => { setStart(String(intent.startSeconds)); setEnd(String(intent.endSeconds)); setError(null); setDirty(false); };
  return <div className="video-edit-dialog__range-editor">
    <div className="video-edit-dialog__range-inputs">
      <label>起始时间（秒）<input type="number" step="0.05" value={start} disabled={busy} onChange={event => { setStart(event.target.value); setDirty(true); }} /></label>
      <label>结束时间（秒）<input type="number" step="0.05" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); setDirty(true); }} /></label>
    </div>
    {error ? <p className="dlg__error">{error}</p> : null}
    {dirty ? <div><button type="button" disabled={busy} onClick={() => { const issue = validateRangeInput(start, end, duration); setError(issue); if (!issue) { update({ startSeconds: Number(start), endSeconds: Number(end) }); setDirty(false); } }}>确认时间</button> <button type="button" disabled={busy} onClick={cancel}>取消</button></div> : null}
  </div>;
}

export function IntentList({
  ordered,
  activeIntentId,
  busyNow,
  rangeDirty,
  setActiveIntentId,
  removeIntent,
  activeIntent,
  updateActive,
  duration,
  onRangeDirty
}: {
  ordered: readonly VideoEditIntent[];
  activeIntentId: string | undefined;
  busyNow: boolean;
  rangeDirty: boolean;
  setActiveIntentId: (id: string) => void;
  removeIntent: (id: string) => void;
  activeIntent: VideoEditIntent | undefined;
  updateActive: (patch: Partial<VideoEditIntent>) => void;
  duration: number;
  onRangeDirty: (dirty: boolean) => void;
}) {
  return (
    <aside className="video-edit-dialog__details">
      <div className="video-edit-dialog__details-head">
        <strong>编辑内容</strong>
        <span>{ordered.length} 个编辑点</span>
      </div>
      <div className="video-edit-dialog__intent-list" aria-label="编辑点列表">
        {ordered.map((intent, index) => (
          <div key={intent.id} className={`video-edit-dialog__intent-row${intent.id === activeIntentId ? " is-active" : ""}`}>
            <button
              type="button"
              className="video-edit-dialog__intent-select"
              disabled={busyNow || rangeDirty}
              onClick={() => setActiveIntentId(intent.id)}
            >
              <strong>{index + 1}. {formatVideoTime(intent.startSeconds)}{isVideoEditRange(intent) ? `-${formatVideoTime(intent.endSeconds!)}` : ""}</strong>
              <span>{intent.prompt.trim() || "（未填写提示词）"}</span>
              {intent.annotationShapes.length > 0 ? <small>{intent.annotationShapes.length} 处标注</small> : null}
            </button>
            <DialogIconButton
              label={`删除编辑点 ${index + 1}`}
              tooltip="删除编辑点"
              icon={<TrashIcon className="dlg__icon" />}
              disabled={busyNow || rangeDirty}
              onClick={() => removeIntent(intent.id)}
            />
          </div>
        ))}
        {ordered.length === 0 ? <p className="video-edit-dialog__empty">点击时间轴上方按钮新增编辑点或区间。</p> : null}
      </div>
      {activeIntent ? (
        <div className="video-edit-dialog__active-editor">
          <div className="video-edit-dialog__range">
            <span>当前时间范围</span>
            <strong>
              {formatVideoTime(activeIntent.startSeconds)}
              {isVideoEditRange(activeIntent) ? ` - ${formatVideoTime(activeIntent.endSeconds!)}` : ""}
            </strong>
          </div>
          {isVideoEditRange(activeIntent) ? <RangeEditor key={activeIntent.id} intent={activeIntent} duration={duration} busy={busyNow} update={updateActive} onDirty={onRangeDirty} /> : null}
          <label className="video-edit-dialog__prompt-field">
            <span>修改提示词 <em>（必填）</em></span>
            <textarea
              value={activeIntent.prompt}
              placeholder="描述标记区域需要发生的变化…"
              rows={5}
              disabled={busyNow}
              onChange={(event) => updateActive({ prompt: event.target.value })}
            />
          </label>
          <p className="video-edit-dialog__hint">标注将与当前视频帧一起保存，仅作用于此编辑点。</p>
        </div>
      ) : null}
    </aside>
  );
}
