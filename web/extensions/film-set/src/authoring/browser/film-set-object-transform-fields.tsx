import { useEffect, useState } from "react";
import type { FilmSetLocalTransform } from "@woohaa3/contracts";
import type { FilmSetObjectSession } from "./object-session.js";

type Props = { session: FilmSetObjectSession; transform: FilmSetLocalTransform; disabled: boolean };

/** Numeric edits preview immediately and commit once on blur/Enter; Escape restores the saved value. */
export function FilmSetObjectTransformFields({ session, transform, disabled }: Props) {
  const edit = (change: (current: FilmSetLocalTransform) => FilmSetLocalTransform) => {
    const current = session.getState().preview;
    if (current) session.updatePreview(change(current));
  };
  const common = { disabled, onStart: () => session.beginEdit(), onCommit: () => session.endEdit(), onCancel: () => session.cancelEdit() };
  return (
    <div className="film-set-transform">
      <div className="film-set-transform__label">位置</div>
      <div className="film-set-transform__axes">
        {(["x", "y", "z"] as const).map(axis => (
          <NumberField key={axis} {...common} label={axis.toUpperCase()} ariaLabel={`对象位置 ${axis.toUpperCase()}`} axis={axis}
            value={transform.offset[axis]} step={0.1}
            onPreview={value => edit(current => ({ ...current, offset: { ...current.offset, [axis]: value } }))} />
        ))}
      </div>
      <details className="film-set-transform__more"><summary>旋转与缩放</summary><div className="film-set-transform__pair">
        <NumberField {...common} label="Y 旋转" ariaLabel="对象 Y 旋转" value={transform.yaw * 180 / Math.PI} step={1} suffix="°"
          onPreview={value => edit(current => ({ ...current, yaw: value * Math.PI / 180 }))} />
        <NumberField {...common} label="等比缩放" ariaLabel="等比缩放" value={transform.scale} min={0.01} step={0.05} suffix="×"
          onPreview={value => edit(current => ({ ...current, scale: value }))} />
      </div></details>
    </div>
  );
}

function NumberField({ label, ariaLabel, value, disabled, axis, suffix, min, step, onStart, onPreview, onCommit, onCancel }: {
  label: string; ariaLabel: string; value: number; disabled: boolean; axis?: string; suffix?: string; min?: number; step: number;
  onStart: () => boolean; onPreview: (value: number) => void; onCommit: () => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(Number(value.toFixed(3)))); }, [value, focused]);
  const valid = draft.trim() !== "" && Number.isFinite(Number(draft)) && (min === undefined || Number(draft) >= min);
  return (
    <label className="film-set-number" data-axis={axis}>
      <span>{label}</span>
      <div className="film-set-number__input">
        <input type="number" aria-label={ariaLabel} value={draft} disabled={disabled} min={min} step={step}
          aria-invalid={focused && !valid ? true : undefined}
          onFocus={() => { if (onStart()) setFocused(true); }}
          onChange={event => {
            const next = event.target.value; setDraft(next);
            if (next.trim() !== "" && Number.isFinite(Number(next)) && (min === undefined || Number(next) >= min)) onPreview(Number(next));
          }}
          onBlur={() => { if (focused) { if (valid) onCommit(); else onCancel(); } setFocused(false); }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); event.currentTarget.blur(); }
          }} />
        {suffix ? <span aria-hidden="true">{suffix}</span> : null}
      </div>
    </label>
  );
}
