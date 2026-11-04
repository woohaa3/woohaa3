import { useEffect, useRef, useState } from "react";
import { WORLD_CAMERA_ASPECT_PRESETS, worldCameraAspectPresetId, worldCameraFramingControl, worldCameraUiSettingsOf, withWorldCameraAspect, withWorldCameraFraming, type WorldCameraData } from "@woohaa3/contracts";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { AdjustmentIcon } from "@woohaa3/ui/icons";
import { SelectInput } from "@woohaa3/ui/forms";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { cameraAngles, withCameraAngle } from "./composition-motion.js";

function NumberField({ value, onChange, min, max, step = 0.1, title }: {
  value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; title?: string;
}) {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  const cancelled = useRef(false);
  useEffect(() => { setText(String(Math.round(value * 100) / 100)); }, [value]);
  return <input type="number" title={title} value={text} min={min} max={max} step={step}
    onChange={event => {
      setText(event.target.value);
      const n = event.target.valueAsNumber;
      if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
    }}
    onBlur={() => {
      if (cancelled.current) { cancelled.current = false; return; }
      const n = text.trim() ? Number(text) : NaN;
      if (Number.isFinite(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
      setText(String(Math.round(value * 100) / 100));
    }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setText(String(Math.round(value * 100) / 100)); event.currentTarget.blur(); }
      if (event.key === "Enter") event.currentTarget.blur();
    }} />;
}

export function CameraParameters({ camera, more, onMore }: {
  camera: WorldCameraData; more: boolean; onMore: () => void;
}) {
  const settings = worldCameraUiSettingsOf(camera);
  const framing = worldCameraFramingControl(settings);
  const angles = cameraAngles(camera);
  const update = (next: typeof settings) => {
    const current = worldCameraEditorStore.getSnapshot();
    if (current) worldCameraEditorStore.update({ ...current.draft, ...next });
  };
  const updateCamera = (next: WorldCameraData) => worldCameraEditorStore.update(next);
  return <>
    <label className="world-camera-editor__framing" title="垂直视野">
      <span>视野 FoV</span>
      <NumberField value={framing.value} min={framing.min} max={framing.max} onChange={value => update(withWorldCameraFraming(settings, value))} />
      <span>°</span>
      <input type="range" min={framing.min} max={framing.max} step={0.1} value={framing.value}
        onChange={event => update(withWorldCameraFraming(settings, Number(event.target.value)))} />
    </label>
    <div className="world-camera-editor__labeled-select"><span>画幅</span><SelectInput label="画幅" value={worldCameraAspectPresetId(settings)}
      options={[...WORLD_CAMERA_ASPECT_PRESETS.map(preset => ({ value: preset.id, label: preset.label })),
        ...(worldCameraAspectPresetId(settings) === "custom" ? [{ value: "custom", label: "自定义" }] : [])]}
      onValueChange={value => update(withWorldCameraAspect(settings, value))} /></div>
    <div className="world-camera-editor__more-anchor">
      <IconButton label={more ? "收起设置" : "更多"} title={more ? "收起设置" : "更多"} size="sm" pressed={more} data-camera-more-trigger onClick={onMore}><AdjustmentIcon /></IconButton>
      {more ? <div className="world-camera-editor__popover" data-camera-popover>
        <strong>机位精调</strong>
        <div className="world-camera-editor__fields">
          {([ ["u", "横向 U"], ["v", "纵向 V"], ["h", "高度"] ] as const).map(([axis, label]) =>
            <label key={axis}><span>{label} · m</span><NumberField value={camera.position[axis]} onChange={value => updateCamera({ ...camera, position: { ...camera.position, [axis]: value } })} /></label>)}
          {([ ["yaw", "朝向"], ["pitch", "俯仰"], ["roll", "横滚"] ] as const).map(([axis, label]) =>
            <label key={axis}><span>{label} · °</span><NumberField value={angles[axis]} min={axis === "pitch" ? -89.9 : -180} max={axis === "pitch" ? 89.9 : 180} onChange={value => updateCamera(withCameraAngle(camera, axis, value))} /></label>)}
        </div>
        <div className="world-camera-editor__presets"><span>视野预设</span>{[35, 60, 90].map(value => <Button key={value} size="sm" onClick={() => update(withWorldCameraFraming(settings, value))}>{value}°</Button>)}</div>

      </div> : null}
    </div>
  </>;
}
