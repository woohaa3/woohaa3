import { useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { supports, isRecord } from "../shared/panels.js";

// ---------------------------------------------------------------- 选区（任务 7.4/7.5）

export type SelectionModifyKind = "expand" | "contract" | "smooth" | "border" | "feather";

/** 选区修改面板：预览 → 一次确认；空选区与非法半径在开始前拒绝。 */
export function SelectionModifyPanel({
  controller,
  readonly,
  hasSelection,
  onChanged
}: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  hasSelection: boolean;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<SelectionModifyKind>("expand");
  const [radius, setRadius] = useState(2);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!supports(controller, "beginSelectionModify", "updateSelectionModify", "commitSelectionModify", "cancelSelectionModify")) {
    return null;
  }
  const preview = (nextRadius: number) => {
    setRadius(nextRadius);
    const result = active
      ? controller.updateSelectionModify({ radius: nextRadius })
      : controller.beginSelectionModify({ operation: kind, radius: nextRadius });
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    if (isRecord(result.value) && Array.isArray(result.value.bounds)) {
      setBounds(result.value.bounds as number[]);
    }
    onChanged();
  };

  const cancel = () => {
    controller.cancelSelectionModify();
    setActive(false);
    setBounds(null);
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="选区修改" data-selection-modify={kind}>
      <span className="photo-editor__options-title">选区修改</span>
      <label>
        操作
        <select value={kind} disabled={readonly || active} onChange={(event) => {
          setKind(event.currentTarget.value as SelectionModifyKind);
          setMessage(null);
        }}>
          <option value="expand">扩展</option>
          <option value="contract">收缩</option>
          <option value="smooth">平滑</option>
          <option value="border">边界</option>
          <option value="feather">羽化</option>
        </select>
      </label>
      <label>
        半径
        <input type="number" min={1} max={500} value={radius} disabled={readonly} onChange={(event) => preview(Math.max(1, Number(event.currentTarget.value)))} />
      </label>
      <Button size="sm" disabled={readonly || !hasSelection || active} onClick={() => preview(radius)}>预览</Button>
      <Button size="sm" disabled={readonly || !active} onClick={() => {
        const result = controller.commitSelectionModify();
        setMessage(result.ok ? null : result.message);
        setActive(false);
        setBounds(null);
        if (result.ok) onChanged();
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={cancel}>取消</Button>
      {bounds ? <span className="photo-editor__option-hint">{bounds.map((value) => Math.round(value)).join(", ")}</span> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** 色彩范围：从明确的颜色、模糊度和选区运算编译一次内核命令。 */
export function ColorRangePanel({ controller, readonly, color, onChanged }: {
  controller: EditorWorkspaceController; readonly: boolean; color: string; onChanged: () => void;
}) {
  const [sample, setSample] = useState(color);
  const [fuzziness, setFuzziness] = useState(40);
  const [mode, setMode] = useState("replace");
  const [select, setSelect] = useState("sampledColors");
  const [invert, setInvert] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const apply = () => {
    const result = controller.dispatch("select.colorRange", { select, color: sample, fuzziness, mode, invert });
    setMessage(result.ok ? null : result.message);
    if (result.ok) onChanged();
  };
  if (!controller.snapshot().commands.get("select.colorRange")?.allowed) return null;
  return <section className="photo-editor__advanced-group" aria-label="色彩范围" data-color-range="true">
    <span className="photo-editor__options-title">色彩范围</span>
    <label>范围<select value={select} disabled={readonly} onChange={event => setSelect(event.currentTarget.value)}><option value="sampledColors">取样颜色</option><option value="reds">红色</option><option value="yellows">黄色</option><option value="greens">绿色</option><option value="cyans">青色</option><option value="blues">蓝色</option><option value="magentas">洋红</option><option value="highlights">高光</option><option value="midtones">中间调</option><option value="shadows">阴影</option></select></label>
    <label>颜色<input type="color" value={sample} disabled={readonly} onChange={event => setSample(event.currentTarget.value)} /></label>
    <label>容差<input type="number" min={0} max={200} value={fuzziness} disabled={readonly} onChange={event => setFuzziness(Math.max(0, Math.min(200, Number(event.currentTarget.value))))} /></label>
    <label>运算<select value={mode} disabled={readonly} onChange={event => setMode(event.currentTarget.value)}><option value="replace">替换</option><option value="add">增加</option><option value="subtract">减去</option><option value="intersect">相交</option></select></label>
    <label><input type="checkbox" checked={invert} disabled={readonly} onChange={event => setInvert(event.currentTarget.checked)} />反相</label>
    <Button size="sm" disabled={readonly} onClick={apply}>应用色彩范围</Button>
    {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
  </section>;
}

/** 边缘细化面板：参数 + 输出目标（选区／像素蒙版），确认才走内核。 */
export function RefineEdgePanel({ controller, readonly, hasSelection }: { controller: EditorWorkspaceController; readonly: boolean; hasSelection: boolean }) {
  const [params, setParams] = useState({ radius: 1, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0 });
  const [output, setOutput] = useState<"selection" | "layerMask">("selection");
  const [message, setMessage] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Record<string, unknown> | null>(null);

  if (!supports(controller, "prepareRefineEdge")) return null;
  const compile = () => {
    const result = controller.prepareRefineEdge({ ...params, output });
    if (!result.ok) {
      setMessage(result.message);
      setPrepared(null);
      return;
    }
    setMessage(null);
    setPrepared(isRecord(result.value) && isRecord(result.value.params) ? result.value.params : null);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="选择并遮住" data-refine-edge="true">
      <span className="photo-editor__options-title">选择并遮住</span>
      {(["radius", "smooth", "feather", "contrast", "shiftEdge"] as const).map((key) => (
        <label key={key}>
          {REFINE_LABELS[key]}
          <input type="number" value={params[key]} disabled={readonly}
            min={key === "shiftEdge" ? -100 : 0} max={key === "shiftEdge" ? 100 : key === "contrast" || key === "smooth" ? 100 : 1000}
            onChange={(event) => setParams((current) => ({ ...current, [key]: Number(event.currentTarget.value) }))} />
        </label>
      ))}
      <label>
        输出
        <select value={output} disabled={readonly} onChange={(event) => setOutput(event.currentTarget.value as "selection" | "layerMask")}>
          <option value="selection">选区</option>
          <option value="layerMask">像素蒙版</option>
        </select>
      </label>
      <Button size="sm" disabled={readonly || !hasSelection} onClick={compile}>预览参数</Button>
      <Button size="sm" disabled={readonly || !prepared} onClick={() => {
        const result = controller.dispatch("select.refineEdge", prepared);
        setMessage(result.ok ? null : result.message);
      }}>确认</Button>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

export const REFINE_LABELS = { radius: "半径", smooth: "平滑", feather: "羽化", contrast: "对比度", shiftEdge: "边缘偏移" } as const;
