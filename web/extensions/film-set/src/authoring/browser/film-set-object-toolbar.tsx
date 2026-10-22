/** Object list and selected properties in the shared film-set inspector. */
import { useSyncExternalStore } from "react";
import type { FilmSetObjectSession } from "./object-session.js";
import type { FilmSetObjectAction } from "./object-action.js";
import { Button } from "@woohaa3/frontend/extension-api";
import { DiamondIcon, ImageIcon, VideoIcon, LayoutGridIcon, TrashIcon } from "@woohaa3/frontend/extension-api";
import { FilmSetObjectTransformFields } from "./film-set-object-transform-fields.js";

export type FilmSetObjectToolbarProps = {
  session: FilmSetObjectSession;
  writable: boolean;
  readOnly: boolean;
  nodeId: string;
  onDelete: () => void;
  /** 与画布键盘共用的局部 action；用于列表内分层 Escape（取消手势优先于清选择）。 */
  action?: FilmSetObjectAction;
  /** 无手势且无选中时经受控导航退出聚焦（列表聚焦时窗口处理器被 editable 保护挡下）。 */
  onExit?: () => void;
};
const KIND_LABEL: Record<string, string> = { model: "模型", image: "图片", video: "视频", ground: "地面" };
const KIND_ICON = { model: DiamondIcon, image: ImageIcon, video: VideoIcon, ground: LayoutGridIcon };

export function FilmSetObjectToolbar({ session, writable, readOnly, nodeId, onDelete, action, onExit }: FilmSetObjectToolbarProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  if (state.nodeId !== nodeId) return null;
  const objects = session.objects();
  const item = session.selectedItem();
  const editable = writable && !readOnly;
  const pending = state.pendingItemId !== null;
  // 列表与场景共用同一对象 action；禁止 repeat/pending 连续误删（change:
  // 2026-10-10-improve-film-set-editing-and-inspector，任务 4.1/5.2）。删除前 action 会
  // 取消活动手势并暂停播放（任务 4.3）；无注入 action 时回退到直接删除回调（测试/独立挂载）。
  const deleteItem = () => {
    if (!editable || pending) return;
    if (action) action.deleteSelected();
    else onDelete();
  };
  return (
    <section className="film-set-object-dock" aria-label="片场对象">
      <div className="film-set-section-heading">
        <h3>场景对象 <span className="film-set-count">{objects.length}</span></h3>
        {state.selectedItemId ? <Button size="sm" tone="ghost" onClick={() => session.select(null)}>取消选择</Button> : null}
      </div>
      <ul className="film-set-object-list" role="listbox" aria-label="片场对象列表">
        {objects.length === 0 ? <li className="film-set-object-list__empty">片场为空，拖入模型开始布置。</li> : null}
        {objects.map(entry => {
          const Icon = KIND_ICON[entry.kind];
          return (
            <li key={entry.itemId}>
              <button type="button" className="film-set-object-row" role="option" aria-selected={entry.itemId === state.selectedItemId}
                aria-label={`${KIND_LABEL[entry.kind]} · ${entry.name}`} title={entry.name}
                onClick={() => session.select(entry.itemId)}
                onKeyDown={event => {
                  // 局部消费 Delete/Backspace：与删除按钮共用 action；不泄漏到 2D 节点删除。
                  if ((event.key === "Delete" || event.key === "Backspace") && !event.altKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    session.select(entry.itemId);
                    deleteItem();
                    return;
                  }
                  if (event.key === "Escape") {
                    // 分层只处理最高优先的一层（design D4）：活动手势 → 清对象选择 → 受控退出聚焦。
                    // 列表 option 是 editable 面，窗口键盘路由被短路，因此这里自行完成全部层级。
                    // repeat 只消费不推进层级，避免长按 Escape 一次按键连续退层（任务 5.3/5.4）。
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.repeat) return;
                    if (action?.cancelGesture()) return;
                    if (session.getState().selectedItemId) { session.select(null); return; }
                    onExit?.();
                    return;
                  }
                  const index = objects.findIndex(object => object.itemId === entry.itemId);
                  const target = event.key === "ArrowDown" ? Math.min(index + 1, objects.length - 1)
                    : event.key === "ArrowUp" ? Math.max(index - 1, 0)
                    : event.key === "Home" ? 0 : event.key === "End" ? objects.length - 1 : null;
                  if (target === null) return;
                  event.preventDefault();
                  event.currentTarget.closest("ul")?.querySelectorAll<HTMLButtonElement>("[role=option]")[target]?.focus();
                  session.select(objects[target].itemId);
                }}>
                <span className="film-set-object-row__icon"><Icon /></span>
                <span className="film-set-object-row__name">{entry.name}</span>
                <span className="film-set-object-row__kind">{KIND_LABEL[entry.kind]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {item ? (
        <div className="film-set-object-fields" key={item.id}>
          <div className="film-set-section-heading film-set-selection-heading"><h3 title={item.name}>{item.name}</h3><span>变换</span></div>
          <FilmSetObjectTransformFields session={session} transform={state.preview ?? item.localTransform} disabled={!editable || pending} />
          <div className="film-set-object-actions">
            <Button size="sm" tone="ghost" className="film-set-object-delete" icon={<TrashIcon />} disabled={!editable || pending} onClick={deleteItem}>删除对象</Button>
          </div>
        </div>
      ) : objects.length > 0 ? <p className="film-set-object-hint">在场景中点选对象，或从列表中选择。</p> : null}
      {item ? <p className="film-set-object-hint">拖动三轴移动 · Shift 拖动旋转</p> : null}
      {state.error ? <div className="film-set-object-error" role="status">{state.error}</div> : null}
    </section>
  );
}
