import { useContext } from "react";
import { Button } from "../../ui/Button.js";
import { PaintingControlsContext } from "./controls-context.js";
import { GRADIENT_STYLES, SAMPLE_SIZES } from "./tool-modes.js";

/** 当前工具的常用参数；完整库编辑留在可停靠的工具设置面板。 */
export function PaintingContextOptions({ disabled, onMore }: { disabled: boolean; onMore(): void }) {
  const controls = useContext(PaintingControlsContext);
  if (!controls) return null;
  const { painting: p, tool } = controls;
  const s = p.settings;
  const number = (label: string, value: number, min: number, max: number, change: (value: number) => void) =>
    <label>{label}<input type="number" min={min} max={max} value={value} disabled={disabled} onChange={event => {
      const n = event.currentTarget.valueAsNumber;
      if (Number.isFinite(n)) change(Math.max(min, Math.min(max, n)));
    }} /></label>;
  const check = (label: string, value: boolean, change: (value: boolean) => void) =>
    <label><input type="checkbox" checked={value} disabled={disabled} onChange={event => change(event.currentTarget.checked)} />{label}</label>;
  const supported = ["pencil", "colorReplacement", "backgroundEraser", "magicEraser", "gradient", "bucket", "eyedropper"].includes(tool);
  if (!supported) return null;
  return <div className="photo-editor__painting-context" data-painting-context={tool}>
    {tool === "pencil" ? <>
      {number("尺寸", s.pencil.size, 1, 512, size => p.update("pencil", { size }))}
      {check("自动擦除", s.pencil.autoErase, autoErase => p.update("pencil", { autoErase }))}
    </> : null}
    {tool === "colorReplacement" ? <>
      {number("尺寸", s.colorReplacement.size ?? 30, 1, 512, size => p.update("colorReplacement", { size }))}
      {number("容差", s.colorReplacement.tolerance, 0, 100, tolerance => p.update("colorReplacement", { tolerance }))}
      <label>模式<select value={s.colorReplacement.mode} disabled={disabled} onChange={e => p.update("colorReplacement", { mode: e.currentTarget.value as typeof s.colorReplacement.mode })}>
        <option value="color">颜色</option><option value="hue">色相</option><option value="saturation">饱和度</option><option value="luminosity">明度</option>
      </select></label>
    </> : null}
    {tool === "backgroundEraser" ? <>
      {number("尺寸", s.backgroundEraser.size, 1, 512, size => p.update("backgroundEraser", { size }))}
      {number("容差", s.backgroundEraser.tolerance, 0, 100, tolerance => p.update("backgroundEraser", { tolerance }))}
      {check("保护前景色", s.backgroundEraser.protectForegroundColor, protectForegroundColor => p.update("backgroundEraser", { protectForegroundColor }))}
    </> : null}
    {tool === "bucket" || tool === "magicEraser" ? <>
      {number("容差", s[tool].tolerance, 0, 255, tolerance => p.update(tool, { tolerance }))}
      {number("不透明度 %", s[tool].opacity, 1, 100, opacity => p.update(tool, { opacity }))}
      {check("连续", s[tool].contiguous, contiguous => p.update(tool, { contiguous }))}
      {check("所有图层取样", s[tool].sampleAllLayers, sampleAllLayers => p.update(tool, { sampleAllLayers }))}
    </> : null}
    {tool === "gradient" ? <>
      <label>类型<select value={s.gradient.style} disabled={disabled} onChange={e => p.update("gradient", { style: e.currentTarget.value as typeof s.gradient.style })}>
        {GRADIENT_STYLES.map(style => <option key={style} value={style}>{({linear:"线性", radial:"径向", angle:"角度", reflected:"对称", diamond:"菱形"} as Record<string,string>)[style] ?? style}</option>)}
      </select></label>
      {number("不透明度 %", s.gradient.opacity, 1, 100, opacity => p.update("gradient", { opacity }))}
      {check("反向", s.gradient.reverse, reverse => p.update("gradient", { reverse }))}
    </> : null}
    {tool === "eyedropper" ? <>
      <label>取样大小<select value={s.eyedropper.size} disabled={disabled} onChange={e => p.update("eyedropper", { size: Number(e.currentTarget.value) as typeof s.eyedropper.size })}>
        {SAMPLE_SIZES.map(size => <option key={size} value={size}>{size} × {size}</option>)}
      </select></label>
      <label>取样<select value={s.eyedropper.sampleLayer} disabled={disabled} onChange={e => p.setSampleLayer(e.currentTarget.value as typeof s.eyedropper.sampleLayer)}><option value="current">当前图层</option><option value="all">所有图层</option><option value="currentAndBelow">当前及下方</option></select></label>
    </> : null}
    <Button size="sm" tone="ghost" disabled={disabled} onClick={onMore}>工具设置…</Button>
  </div>;
}
