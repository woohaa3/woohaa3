/**
 * 视频编辑 dialog 右侧意图列表
 * （change: 2026-09-28-split-frontend-god-plugins，task 5；从 video-edit-dialog.tsx 拆出）。
 */
import { isVideoEditRange, type VideoEditIntent } from "@woohaa3/contracts";
import { DialogIconButton } from "@woohaa3/ui/dialogs";
import { TrashIcon } from "@woohaa3/ui/icons";
import { formatVideoTime } from "./video-geometry.js";

export function IntentList({
  ordered,
  activeIntentId,
  busyNow,
  setActiveIntentId,
  removeIntent,
  activeIntent,
  updateActive
}: {
  ordered: readonly VideoEditIntent[];
  activeIntentId: string | undefined;
  busyNow: boolean;
  setActiveIntentId: (id: string) => void;
  removeIntent: (id: string) => void;
  activeIntent: VideoEditIntent | undefined;
  updateActive: (patch: Partial<VideoEditIntent>) => void;
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
              disabled={busyNow}
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
              disabled={busyNow}
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
