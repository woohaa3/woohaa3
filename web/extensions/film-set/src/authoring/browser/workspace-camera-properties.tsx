import { useState, useSyncExternalStore } from "react";
import type { ModelEditorSession } from "@woohaa3/frontend/extension-api";
import { modelCameraFocusOffset, MODEL_CAMERA_ASPECTS, type ModelCameraAspect } from "@woohaa3/contracts";
import { SelectInput } from "@woohaa3/ui/forms";
import { IconButton } from "@woohaa3/ui/primitives";
import { LocateIcon, RefreshIcon } from "@woohaa3/ui/icons";

/** Composition controls use the same preview and authoritative writer as the Bevy handles. */
export function FilmSetCameraProperties({ session, disabled }: { session: ModelEditorSession; disabled: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const camera = session.selectedCamera();
  if (!camera) return <p className="film-set-object-hint">当前镜头构图不可用，请重新选择镜头。</p>;
  const pose = session.effectivePose(camera);
  const focus = state.focusPreview ?? modelCameraFocusOffset(camera);
  const blocked = disabled || state.cameraWritePending;
  const degrees = 180 / Math.PI;
  const preview = (field: "azimuth" | "elevation" | "distance", value: number) => {
    if (!session.getState().posePreview) session.beginPose();
    session.updatePose({ [field]: field === "distance" ? value : value / degrees });
  };
  return <div className="film-set-camera-properties">
    <div className="film-set-property-heading"><span><LocateIcon size={14} />拍摄构图</span>
      <IconButton label="重置镜头" title="重置构图" size="sm" tone="ghost" disabled={blocked} onClick={() => session.resetSelectedCamera({ azimuth: 0, elevation: Math.PI / 4, distance: camera.distance })}><RefreshIcon size={14} /></IconButton>
    </div>
    {([ ["azimuth", "镜头方位", pose.azimuth * degrees, Math.min(-180, camera.azimuth * degrees), Math.max(180, camera.azimuth * degrees), 1, "°"], ["elevation", "镜头仰角", pose.elevation * degrees, -90, 90, 1, "°"], ["distance", "镜头距离", pose.distance, Math.min(0.1, camera.distance), Math.max(50, camera.distance * 1.5), 0.1, "m"] ] as const).map(([field, label, value, min, max, step, unit]) =>
      <CameraSlider key={`${camera.id}:${field}`} label={label} value={value} min={min} max={max} step={step} unit={unit} bounded={field === "elevation"} disabled={blocked}
        start={() => session.beginPose()} preview={value => preview(field, value)} commit={() => session.endPose()} cancel={() => session.cancelPose()} />)}
    <div className="film-set-property-label">注视点偏移</div>
    <div className="film-set-transform__axes film-set-camera-focus">
      {(["x", "y", "z"] as const).map(axis => <label className="film-set-number" data-axis={axis} key={`${camera.id}:${axis}`}><span>{axis.toUpperCase()}</span><div className="film-set-number__input">
        <FocusNumber label={`注视点 ${axis.toUpperCase()}`} value={focus[axis]} disabled={blocked}
          start={() => session.beginFocus()} preview={value => session.updateFocus({ ...focus, [axis]: value })}
          commit={() => session.endFocus()} cancel={() => session.cancelFocus()} />
      </div></label>)}
    </div>
  </div>;
}

function CameraSlider({ label, value, min, max, step, unit, bounded, disabled, start, preview, commit, cancel }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; bounded: boolean; disabled: boolean;
  start(): void; preview(value: number): void; commit(): void; cancel(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const precision = unit === "m" ? 3 : 1;
  const valid = (text: string) => text.trim() !== "" && Number.isFinite(Number(text)) && (unit !== "m" || Number(text) > 0) && (!bounded || (Number(text) >= min && Number(text) <= max));
  return <div className="film-set-camera-slider">
    <div className="film-set-camera-slider__row"><label>{label}</label><div className="film-set-camera-slider__value"><input aria-label={label} type="number" min={unit === "m" ? 0 : bounded ? min : undefined} max={bounded ? max : undefined} step={step} disabled={disabled}
      value={draft ?? Number(value.toFixed(precision))} onFocus={() => { start(); setDraft(String(Number(value.toFixed(precision)))); }}
      onChange={event => { setDraft(event.target.value); if (valid(event.target.value)) preview(Number(event.target.value)); }}
      onBlur={() => { if (draft === null || valid(draft)) commit(); else cancel(); setDraft(null); }}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.stopPropagation(); cancel(); setDraft(null); event.currentTarget.blur(); } }} /><span>{unit}</span></div></div>
    <input aria-label={`${label}滑杆`} className="film-set-camera-slider__range" type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); start(); }} onChange={event => preview(event.target.valueAsNumber)} onPointerUp={commit} onPointerCancel={cancel} onBlur={commit}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancel(); event.currentTarget.blur(); } }}
      onKeyUp={event => { if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") commit(); }} />
  </div>;
}

function FocusNumber({ label, value, disabled, start, preview, commit, cancel }: {
  label: string; value: number; disabled: boolean;
  start(): void; preview(value: number): void; commit(): void; cancel(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const valid = (text: string) => text.trim() !== "" && Number.isFinite(Number(text));
  return <input aria-label={label} type="number" step="0.1" disabled={disabled} value={draft ?? Number(value.toFixed(3))}
    onFocus={() => { start(); setDraft(String(Number(value.toFixed(3)))); }}
    onChange={event => { setDraft(event.target.value); if (valid(event.target.value)) preview(Number(event.target.value)); }}
    onBlur={() => { if (draft === null || valid(draft)) commit(); else cancel(); setDraft(null); }}
    onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.stopPropagation(); cancel(); setDraft(null); event.currentTarget.blur(); } }} />;
}

export function FilmSetAspectCards({ value, disabled, onChange }: { value: ModelCameraAspect; disabled: boolean; onChange(value: ModelCameraAspect): void }) {
  const common = ["16:9", "9:16", "1:1", "4:3"] as const;
  return <>
    <div className="film-set-aspect-cards">{common.map(aspect => <button type="button" key={aspect} aria-label={`画幅 ${aspect}`} data-active={value === aspect} disabled={disabled} onClick={() => onChange(aspect)}>
      <span style={{ aspectRatio: aspect.replace(":", "/") }} /><span>{aspect}</span>
    </button>)}</div>
    <label className="film-set-aspect-more">更多画幅<SelectInput label="镜头画幅" value={value} disabled={disabled} onValueChange={value => onChange(value as ModelCameraAspect)} options={MODEL_CAMERA_ASPECTS.map(aspect => ({ value: aspect, label: aspect }))} /></label>
  </>;
}
