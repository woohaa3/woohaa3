import { useState } from "react";
import { MODEL_CAMERA_ASPECTS, type ModelCameraAspect } from "@woohaa3/contracts";
import { CloseIcon } from "@woohaa3/ui";
import { ExecutionPanelShell } from "../../ui/index.js";
import type { ShotMediaParameters } from "./shot-media-parameters.js";
import "./shot-media-parameters-panel.css";

type ShotChange = { kind: "aspect"; aspect: ModelCameraAspect } | { kind: "timeline"; timeline: { duration?: number; loop?: boolean } };
export type ShotMediaParametersPanelProps = {
  nodeId: string;
  parameters: ShotMediaParameters;
  writable?: boolean;
  onChange?: (change: ShotChange) => Promise<string | null>;
  onClose?: (() => void) | undefined;
};

export function ShotMediaParametersPanel({ nodeId, parameters, writable = false, onChange, onClose }: ShotMediaParametersPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const video = parameters.kind === "video";
  const submit = async (change: ShotChange) => {
    if (!onChange || pending) return;
    setPending(true);
    try { setError(await onChange(change)); } catch { setError("镜头修改无法确认，请重试"); } finally { setPending(false); }
  };
  return <ExecutionPanelShell ariaLabel={video ? "镜头视频参数" : "镜头图片参数"} className="mc-panel--shot-media">
    <div className="shot-media-panel" data-node-id={nodeId} data-media-kind={parameters.kind}>
      <header className="shot-media-panel__header"><div className="shot-media-panel__heading">
        <strong className="shot-media-panel__title">{parameters.title}</strong><span className="shot-media-panel__kind">{video ? "视频" : "图片"}</span>
      </div>{onClose ? <button type="button" className="mc-panel__close" data-tooltip="关闭" aria-label="关闭执行面板" onClick={onClose}><CloseIcon className="mc-panel__icon" /></button> : null}</header>
      <div className="shot-media-panel__params">
        <label>画幅<select value={parameters.aspect} disabled={!writable || pending} onChange={event => void submit({ kind: "aspect", aspect: event.target.value as ModelCameraAspect })}>{MODEL_CAMERA_ASPECTS.map(aspect => <option key={aspect} value={aspect}>{aspect}</option>)}</select></label>
        {video ? <><label>时长（秒）<input key={parameters.durationSeconds} type="number" min="0.1" max="3600" step="0.1" defaultValue={parameters.durationSeconds} disabled={!writable || pending} onBlur={event => { const duration = Number(event.target.value); if (duration > 0 && duration <= 3600 && duration !== parameters.durationSeconds) void submit({ kind: "timeline", timeline: { duration } }); else event.target.value = String(parameters.durationSeconds); }} /></label>
          <label className="shot-media-panel__loop"><input type="checkbox" checked={parameters.loop} disabled={!writable || pending} onChange={event => void submit({ kind: "timeline", timeline: { loop: event.target.checked } })} />循环</label></> : null}
      </div>
      <div className="shot-media-panel__output">输出 {parameters.width} × {parameters.height}{video ? ` · ${parameters.frameRate} fps` : ""}</div>
      {error ? <p className="shot-media-panel__error">{error}</p> : null}
    </div>
  </ExecutionPanelShell>;
}
