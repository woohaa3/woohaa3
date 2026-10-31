import type { ModelEditorSession } from "@woohaa3/frontend/extension-api";
import { IconButton } from "@woohaa3/ui/primitives";
import { PointerIcon, MoveIcon, RotateIcon, ScaleIcon, OrbitIcon, ElevationIcon, LocateIcon, LayoutGridIcon, SparklesIcon } from "@woohaa3/ui/icons";
import type { FilmSetObjectSession } from "./object-session.js";

/** One floating tool shelf; selecting a tool always releases the previous gesture. */
export function FilmSetViewportTools({ session, objects, camera, selectedItemId, clipId, disabled, hidden, grid, onGrid, onObject, onShot, cancel, aiVisible, aiExpanded, onAiToggle }: {
  session: ModelEditorSession; objects: FilmSetObjectSession; camera: boolean;
  selectedItemId: string | null; clipId?: string; disabled: boolean; hidden: boolean;
  grid: boolean; onGrid(): void; onObject(id: string | null): void; onShot(id: string): void; cancel(): void;
  aiVisible: boolean; aiExpanded: boolean; onAiToggle(): void;
}) {
  const tool = objects.getState().tool;
  const cameraTool = session.getState().cameraTool;
  return <div className="film-set-viewport-tools" data-canvas-scrollable="true" hidden={hidden}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <IconButton label="选择对象" title="选择对象" size="sm" tone="ghost" data-active={!camera && !selectedItemId}
      onClick={() => { cancel(); onObject(null); }}><PointerIcon /></IconButton>
    <span className="film-set-viewport-tools__divider" />
    {camera ? <>
      {([ ["orbit", "方位旋转", OrbitIcon], ["elevation", "仰角", ElevationIcon], ["distance", "推拉", MoveIcon], ["focus", "移动注视点", LocateIcon] ] as const).map(([value, label, Icon]) =>
        <IconButton key={value} label={label} title={label} size="sm" tone="ghost" data-active={cameraTool === value} disabled={disabled || !clipId}
          onClick={() => { cancel(); onShot(clipId!); session.setCameraTool(value); }}><Icon /></IconButton>)}
    </> : <>
      {([ ["move", "移动对象", MoveIcon], ["yaw", "Y 旋转", RotateIcon], ["scale", "等比缩放", ScaleIcon] ] as const).map(([value, label, Icon]) =>
        <IconButton key={value} label={label} title={label} size="sm" tone="ghost" data-active={!!selectedItemId && tool === value} disabled={disabled || !selectedItemId}
          onClick={() => { cancel(); onObject(selectedItemId); objects.setTool(value); }}><Icon /></IconButton>)}
    </>}
    <span className="film-set-viewport-tools__divider" />
    <IconButton label="网格" title="显示网格" size="sm" tone="ghost" data-active={grid} onClick={() => { cancel(); onGrid(); }}><LayoutGridIcon /></IconButton>
    {aiVisible ? <>
      <span className="film-set-viewport-tools__divider" />
      <IconButton label={aiExpanded ? "收起场景 AI" : "展开场景 AI"} title={aiExpanded ? "收起场景 AI" : "展开场景 AI"}
        size="sm" tone="ghost" data-active={aiExpanded} onClick={onAiToggle}><SparklesIcon /></IconButton>
    </> : null}
  </div>;
}
