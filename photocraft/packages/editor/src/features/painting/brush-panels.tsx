/**
 * 笔刷预设选择器与笔刷设置面板
 * （change: 2026-10-22-complete-photocraft-webui-editing，任务 2.1–2.5 / design D4）。
 *
 * 界面只做三件事：展示库、编辑未保存的笔刷参数、触发内核预览。所有笔迹预览都是内核
 * `brushPreview` 的 RGBA 像素（绘制到 `<canvas>`），没有 CSS 近似。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import { Popover } from "../../ui/Popover.js";
import {
  ANGLE_CONTROLS,
  DEFAULT_DYNAMICS,
  dynamicsFromBrush,
  dynamicsPatch,
  useBrushLibrary,
  type BrushControl,
  type BrushDynamics,
  type BrushLibraryController,
  type BrushPresetSummary
} from "../../brush-library-state.js";
import type { EditorPreview } from "../../editor-wasm.js";
import { clampBrushSize, type BrushSettings } from "../../photo-editor-tools.js";
import { MASK_MODES, PAINT_BLEND_MODES, TEXTURE_STYLES, type MaskMode, type PaintBlendMode, type TextureStyle } from "./blend-modes.js";import { formatCurvePoints, isLinearCurve, parseCurvePoints } from "./curve-points.js";

export type BrushPresetPickerProps = {
  controller: BrushLibraryController;
  brush: BrushSettings;
  disabled?: boolean;
  /** 预设被选中：把它的完整设置应用到工具（界面只保存 result，不写文档）。 */
  onPick: (name: string) => void;
  /** 当前笔刷参数变化（未保存的修改）。 */
  onBrush: (patch: Partial<BrushSettings> & Record<string, unknown>) => void;
};

/** 小型像素画布：把内核 RGBA 预览画出来（与正式预览同一份像素）。 */
function BrushPreviewCanvas({ preview, width, height, title }: { preview: EditorPreview | null; width: number; height: number; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !preview) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(preview.width, preview.height);
    image.data.set(preview.pixels);
    context.putImageData(image, 0, 0);
  }, [preview]);
  return <canvas ref={ref} className="photo-editor__brush-preview" width={width} height={height} title={title} data-brush-preview={title} />;
}

/** 预设选择器：分组、缩略图与笔迹预览。 */
export function BrushPresetPicker({ controller, brush, disabled = false, onPick, onBrush }: BrushPresetPickerProps) {
  const { state, preview } = useBrushLibrary(controller);
  const [open, setOpen] = useState(false);
  const [presetAnchor,setPresetAnchor]=useState<HTMLButtonElement|null>(null);
  const [settingsAnchor,setSettingsAnchor]=useState<HTMLButtonElement|null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [saveName, setSaveName] = useState("");
  const [saveGroup, setSaveGroup] = useState("");
  const [abrGroup, setAbrGroup] = useState("");
  const abrInput = useRef<HTMLInputElement>(null);
  const tipInput = useRef<HTMLInputElement>(null);
  const [dynamicsOpen, setDynamicsOpen] = useState(false);
  const [dynamics, setDynamics] = useState<BrushDynamics>(DEFAULT_DYNAMICS);
  const current = state.current;
  const presets = state.list?.presets ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, BrushPresetSummary[]>();
    for (const preset of presets) {
      const list = map.get(preset.group) ?? [];
      list.push(preset);
      map.set(preset.group, list);
    }
    return [...map.entries()];
  }, [presets]);

  const applyPatch = useCallback(
    (patch: Partial<BrushDynamics>) => {
      const next = { ...dynamics, ...patch };
      setDynamics(next);
      onBrush(dynamicsPatch(next) as unknown as Partial<BrushSettings> & Record<string, unknown>);
    },
    [dynamics, onBrush]
  );

  // 界面参数是内核设置的投影：笔刷变化（选中预设或快捷键改尺寸）后重新折叠。
  useEffect(() => {
    setDynamics(dynamicsFromBrush(brush as unknown as Record<string, unknown>));
  }, [brush]);

  // 实时预览按参数 JSON 记忆，避免每次 React 重渲染都调用内核。
  const previewKey = useMemo(() => JSON.stringify(dynamicsPatch(dynamics)), [dynamics]);
  const livePreview = useMemo(
    () => (dynamicsOpen ? controller.preview(JSON.parse(previewKey) as Record<string, unknown>, 128) : null),
    [controller, dynamicsOpen, previewKey]
  );

  if (!state.list) {
    return (
      <div className="photo-editor__brush-picker" data-brush-picker="loading">
        <span className="photo-editor__brush-note">{state.message ?? "笔刷库尚未就绪"}</span>
      </div>
    );
  }

  return (
    <div className="photo-editor__brush-picker" data-brush-picker="ready">
      <div className="photo-editor__brush-row">
        <button
          ref={setPresetAnchor}
          type="button"
          className="photo-editor__brush-current"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title="选择笔刷预设"
        >
          <BrushPreviewCanvas preview={preview(current ?? presets[0]?.name ?? "")} width={32} height={32} title={`预设预览：${current ?? "无"}`} />
          <span>{current ?? "未选择预设"}</span>
        </button>
        <Button ref={setSettingsAnchor} size="sm" disabled={disabled || state.busy} onClick={() => setDynamicsOpen((value) => !value)}>
          {dynamicsOpen ? "收起笔刷设置" : "笔刷设置"}
        </Button>
        <Button size="sm" tone="ghost" disabled={disabled || state.busy} onClick={() => abrInput.current?.click()}>导入 ABR</Button>
        <Button size="sm" tone="ghost" disabled={disabled || state.busy} onClick={() => tipInput.current?.click()}>导入图片笔尖</Button>
        <input ref={abrInput} type="file" accept=".abr,application/octet-stream" hidden onChange={async event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; await controller.inspectAbr(new Uint8Array(await file.arrayBuffer()), abrGroup); }} />
        <input ref={tipInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; await controller.importFromImage(file.name, new Uint8Array(await file.arrayBuffer()), abrGroup || undefined); }} />
      </div>

      {settingsAnchor ? <Popover anchorElement={settingsAnchor} open={dynamicsOpen && !disabled} onOpenChange={setDynamicsOpen} align="start" className="photo-editor__brush-popup">
        <div className="photo-editor__brush-settings" data-brush-settings="open">
          <BrushSettingsFields
            dynamics={dynamics}
            brush={brush}
            disabled={disabled || state.busy}
            onMode={(mode) => onBrush({ mode } as Partial<BrushSettings> & Record<string, unknown>)}
            onChange={applyPatch}
          />
          <div className="photo-editor__brush-preview-row">
            <BrushPreviewCanvas preview={livePreview} width={128} height={128} title="当前设置笔迹预览" />
            <span className="photo-editor__brush-note">预览由内核按当前设置与固定种子绘制</span>
          </div>
        </div>
      </Popover> : null}

      {presetAnchor ? <Popover anchorElement={presetAnchor} open={open && !disabled} onOpenChange={setOpen} align="start" className="photo-editor__brush-popup">
        <div className="photo-editor__brush-menu" role="dialog" aria-label="笔刷预设">
          <label>导入分组<input value={abrGroup} onChange={event => setAbrGroup(event.currentTarget.value)} placeholder="可选" maxLength={255} /></label>
          {groups.map(([group, list]) => (
            <section key={group} className="photo-editor__brush-group">
              <h4>{group || "未分组"}</h4>
              <ul>
                {list.map((preset) => (
                  <li key={preset.name} data-brush-preset={preset.name}>
                    <button
                      type="button"
                      disabled={disabled || state.busy}
                      className={preset.name === current ? "is-current" : undefined}
                      onClick={() => {
                        if (controller.select(preset.name)) {
                          onPick(preset.name);
                          setOpen(false);
                        }
                      }}
                    >
                      <BrushPreviewCanvas preview={preview(preset.name)} width={28} height={28} title={`笔迹预览：${preset.name}`} />
                      <span>{preset.name}</span>
                      <small>{preset.origin === "builtin" ? "内置" : preset.origin === "abr" ? "ABR" : preset.origin === "image" ? "图片" : "自定义"}{preset.sampled ? " · 采样" : ""}</small>
                    </button>
                    <span className="photo-editor__brush-actions">
                      <Button
                        size="sm"
                        tone="ghost"
                        disabled={disabled || state.busy}
                        onClick={() => {
                          setRenaming(preset.name);
                          setRenameValue(preset.name);
                        }}
                      >
                        改名
                      </Button>
                      <Button
                        size="sm"
                        tone="ghost"
                        disabled={disabled || state.busy}
                        onClick={() => void controller.remove(preset.name)}
                      >
                        删除
                      </Button>
                    </span>
                    {renaming === preset.name ? (
                      <form
                        className="photo-editor__brush-inline"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void controller.rename(preset.name, renameValue).then((ok) => {
                            if (ok) setRenaming(null);
                          });
                        }}
                      >
                        <input value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} maxLength={255} aria-label="新预设名称" />
                        <Button size="sm" type="submit" disabled={state.busy}>确认</Button>
                        <Button size="sm" tone="ghost" onClick={() => setRenaming(null)}>取消</Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <form
            className="photo-editor__brush-inline"
            onSubmit={(event) => {
              event.preventDefault();
              void controller
                .save({ name: saveName, group: saveGroup || undefined, overwrite: presets.some((preset) => preset.name === saveName) })
                .then((ok) => {
                  if (ok) {
                    setSaveName("");
                    onPick(saveName);
                  }
                });
            }}
          >
            <input value={saveName} onChange={(event) => setSaveName(event.currentTarget.value)} placeholder="新预设名称" maxLength={255} aria-label="新预设名称" />
            <input value={saveGroup} onChange={(event) => setSaveGroup(event.currentTarget.value)} placeholder="分组（可选）" maxLength={255} aria-label="预设分组" />
            <Button size="sm" type="submit" disabled={disabled || state.busy || !saveName.trim()}>保存当前设置</Button>
          </form>
          <p className="photo-editor__brush-note">
            {state.persistence === "failed" ? "本机库写入失败：当前会话可用，重载后可能丢失。" : state.persistence === "unsaved" ? "本机库只在本次会话内（宿主未提供存储）。" : "笔刷库独立于工程内容，不影响未保存状态。"}
          </p>
        </div>
      </Popover> : null}

      {state.message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{state.message}</p> : null}
      {state.report ? (
        <div className="photo-editor__brush-report" data-brush-abr-report="pending">
          <p>
            ABR v{state.report.version}：可导入 {state.report.supported} 条
            {state.report.unsupported.length ? `，${state.report.unsupported.length} 条不支持` : ""}
          </p>
          {state.report.unsupported.length ? (
            <ul>{state.report.unsupported.slice(0, 20).map((entry) => <li key={entry}>{entry}</li>)}</ul>
          ) : null}
          <div className="photo-editor__brush-row">
            <Button size="sm" disabled={state.busy || state.report.supported === 0} onClick={() => void controller.commitAbr(true)}>
              仅导入可支持笔刷
            </Button>
            <Button size="sm" tone="ghost" disabled={state.busy} onClick={() => controller.cancelAbr()}>取消</Button>
          </div>
        </div>
      ) : null}
      <p className="photo-editor__brush-note" hidden>{state.list.count} 个预设</p>
    </div>
  );
}

/** 笔尖与动态参数按钮组（受控；值来自内核设置投影）。 */
function BrushSettingsFields({ dynamics, brush, disabled, onMode, onChange }: {
  dynamics: BrushDynamics;
  brush: BrushSettings;
  disabled: boolean;
  onMode: (mode: PaintBlendMode) => void;
  onChange: (patch: Partial<BrushDynamics>) => void;
}) {
  return (
    <div className="photo-editor__brush-fields" data-brush-fields="true">
      {/* U30：绘画混合模式是 `paint.stroke` 的顶层参数，不属于 brush 补丁。 */}
      <label>
        模式
        <select
          value={brush.mode ?? "normal"}
          disabled={disabled}
          data-brush-blend-mode={brush.mode ?? "normal"}
          onChange={(event) => onMode(event.currentTarget.value as PaintBlendMode)}
        >
          {PAINT_BLEND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
      <label>
        间距
        <input type="range" min={1} max={1000} step={1} disabled={disabled} value={Math.round(dynamics.spacing * 100)} onChange={(event) => onChange({ spacing: Number(event.currentTarget.value) / 100 })} />
        <output>{Math.round(dynamics.spacing * 100)}%</output>
      </label>
      <label>
        角度
        <input type="range" min={-180} max={180} step={1} disabled={disabled} value={Math.round(dynamics.angle)} onChange={(event) => onChange({ angle: Number(event.currentTarget.value) })} />
        <output>{Math.round(dynamics.angle)}°</output>
      </label>
      <label>
        圆度
        <input type="range" min={0} max={100} step={1} disabled={disabled} value={Math.round(dynamics.roundness * 100)} onChange={(event) => onChange({ roundness: Number(event.currentTarget.value) / 100 })} />
        <output>{Math.round(dynamics.roundness * 100)}%</output>
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.flipX} disabled={disabled} onChange={(event) => onChange({ flipX: event.currentTarget.checked })} />水平翻转
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.flipY} disabled={disabled} onChange={(event) => onChange({ flipY: event.currentTarget.checked })} />垂直翻转
      </label>
      <DynamicField label="大小" dynamics={dynamics} jitter={dynamics.sizeJitter} control={dynamics.sizeControl} minimum={dynamics.sizeMinimum} disabled={disabled} onChange={onChange} keys="size" />
      <DynamicField label="不透明度" dynamics={dynamics} jitter={dynamics.opacityJitter} control={dynamics.opacityControl} minimum={dynamics.opacityMinimum} disabled={disabled} onChange={onChange} keys="opacity" />
      <DynamicField label="流量" dynamics={dynamics} jitter={dynamics.flowJitter} control={dynamics.flowControl} minimum={dynamics.flowMinimum} disabled={disabled} onChange={onChange} keys="flow" />
      <label>
        散布
        <input type="range" min={0} max={1000} step={1} disabled={disabled} value={Math.round(dynamics.scatter * 100)} onChange={(event) => onChange({ scatter: Number(event.currentTarget.value) / 100 })} />
        <output>{Math.round(dynamics.scatter * 100)}%</output>
      </label>
      <label>
        数量
        <input type="range" min={1} max={16} step={1} disabled={disabled} value={dynamics.scatterCount} onChange={(event) => onChange({ scatterCount: Number(event.currentTarget.value) })} />
        <output>{dynamics.scatterCount}</output>
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.scatterBothAxes} disabled={disabled} onChange={(event) => onChange({ scatterBothAxes: event.currentTarget.checked })} />双轴散布
      </label>
      <SmPost label="数量抖动" value={dynamics.scatterJitter} minimum={dynamics.scatterMinimum} disabled={disabled} onChange={onChange} keys="scatter" />
      <DynamicField label="角度" dynamics={dynamics} jitter={dynamics.angleJitter} control={dynamics.angleControl} minimum={0} disabled={disabled} onChange={onChange} keys="angle" />
      <DynamicField label="圆度" dynamics={dynamics} jitter={dynamics.roundnessJitter} control={dynamics.roundnessControl} minimum={dynamics.roundnessMinimum} disabled={disabled} onChange={onChange} keys="roundness" />
      <label>
        平滑
        <input type="range" min={0} max={100} step={1} disabled={disabled} value={Math.round(dynamics.smoothing * 100)} onChange={(event) => onChange({ smoothing: Number(event.currentTarget.value) / 100 })} />
        <output>{Math.round(dynamics.smoothing * 100)}%</output>
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.pulledString} disabled={disabled} onChange={(event) => onChange({ pulledString: event.currentTarget.checked })} />拉绳模式
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.catchUp} disabled={disabled} onChange={(event) => onChange({ catchUp: event.currentTarget.checked })} />追赶
      </label>
      <label className="photo-editor__brush-check">
        <input type="checkbox" checked={dynamics.catchUpOnEnd} disabled={disabled} onChange={(event) => onChange({ catchUpOnEnd: event.currentTarget.checked })} />抬笔收尾
      </label>

      {/* U30：纹理、颜色动态与每项动态的响应曲线。 */}
      <fieldset className="photo-editor__brush-dynamic" disabled={disabled} data-brush-texture={dynamics.textureEnabled ? "on" : "off"}>
        <legend>纹理</legend>
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={dynamics.textureEnabled} disabled={disabled} onChange={(event) => onChange({ textureEnabled: event.currentTarget.checked })} />启用纹理
        </label>
        <label>
          图案
          <select value={dynamics.textureStyle} disabled={disabled} onChange={(event) => onChange({ textureStyle: event.currentTarget.value as TextureStyle | "custom" })}>
            {TEXTURE_STYLES.map((style) => <option key={style} value={style}>{style === "noise" ? "噪点" : style === "canvas" ? "画布" : style === "paper" ? "纸纹" : "网点"}</option>)}
            {dynamics.textureStyle === "custom" ? <option value="custom">当前采样图案</option> : null}
          </select>
        </label>
        <label>
          缩放
          <input type="range" min={1} max={1000} step={1} disabled={disabled} value={Math.round(dynamics.textureScale * 100)} onChange={(event) => onChange({ textureScale: Number(event.currentTarget.value) / 100 })} />
          <output>{Math.round(dynamics.textureScale * 100)}%</output>
        </label>
        <label>
          模式
          <select value={dynamics.textureMode} disabled={disabled} onChange={(event) => onChange({ textureMode: event.currentTarget.value as MaskMode })}>
            {MASK_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <label>
          深度
          <input type="range" min={0} max={100} step={1} disabled={disabled} value={Math.round(dynamics.textureDepth * 100)} onChange={(event) => onChange({ textureDepth: Number(event.currentTarget.value) / 100 })} />
          <output>{Math.round(dynamics.textureDepth * 100)}%</output>
        </label>
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={dynamics.textureInvert} disabled={disabled} onChange={(event) => onChange({ textureInvert: event.currentTarget.checked })} />反相纹理
        </label>
      </fieldset>

      <fieldset className="photo-editor__brush-dynamic" disabled={disabled} data-brush-color-dynamics={dynamics.colorDynamicsEnabled ? "on" : "off"}>
        <legend>颜色动态</legend>
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={dynamics.colorDynamicsEnabled} disabled={disabled} onChange={(event) => onChange({ colorDynamicsEnabled: event.currentTarget.checked })} />启用颜色动态
        </label>
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={dynamics.colorPerTip} disabled={disabled} onChange={(event) => onChange({ colorPerTip: event.currentTarget.checked })} />每笔尖应用
        </label>
        <CurveField label="前景/背景抖动" jitter={dynamics.fgBgJitter} control={dynamics.fgBgControl} disabled={disabled} onChange={onChange} keys="fgBg" />
        <PercentField label="色相抖动" value={dynamics.hueJitter} disabled={disabled} onChange={(value) => onChange({ hueJitter: value })} />
        <PercentField label="饱和度抖动" value={dynamics.saturationJitter} disabled={disabled} onChange={(value) => onChange({ saturationJitter: value })} />
        <PercentField label="明度抖动" value={dynamics.brightnessJitter} disabled={disabled} onChange={(value) => onChange({ brightnessJitter: value })} />
        <label>
          纯度
          <input type="range" min={-100} max={100} step={1} disabled={disabled} value={Math.round(dynamics.purity * 100)} onChange={(event) => onChange({ purity: Number(event.currentTarget.value) / 100 })} />
          <output>{Math.round(dynamics.purity * 100)}%</output>
        </label>
      </fieldset>

      <fieldset className="photo-editor__brush-dynamic" disabled={disabled}>
        <legend>压力响应曲线</legend>
        <CurveText label="大小" points={dynamics.sizeCurve} disabled={disabled} onChange={(sizeCurve) => onChange({ sizeCurve })} />
        <CurveText label="不透明度" points={dynamics.opacityCurve} disabled={disabled} onChange={(opacityCurve) => onChange({ opacityCurve })} />
        <CurveText label="流量" points={dynamics.flowCurve} disabled={disabled} onChange={(flowCurve) => onChange({ flowCurve })} />
        <p className="photo-editor__brush-note">格式 <code>输入,输出; …</code>（0–1、递增、2–16 点）。留空＝线性；非法输入不提交。</p>
      </fieldset>
    </div>
  );
}

/** 抖动 + 最小值（散布数量等没有控制器的动态）。 */
function SmPost({ label, value, minimum, disabled, onChange, keys }: {
  label: string; value: number; minimum: number; disabled: boolean;
  onChange: (patch: Partial<BrushDynamics>) => void; keys: "scatter";
}) {
  return (
    <fieldset className="photo-editor__brush-dynamic" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        抖动
        <input type="range" min={0} max={100} step={1} value={Math.round(value * 100)} onChange={(event) => onChange({ [`${keys}Jitter`]: Number(event.currentTarget.value) / 100 })} />
      </label>
      <label>
        最小值
        <input type="range" min={0} max={100} step={1} value={Math.round(minimum * 100)} onChange={(event) => onChange({ [`${keys}Minimum`]: Number(event.currentTarget.value) / 100 })} />
      </label>
    </fieldset>
  );
}

/** 前景/背景抖动：抖动量 + 控制器。 */
function CurveField({ label, jitter, control, disabled, onChange, keys }: {
  label: string; jitter: number; control: BrushControl; disabled: boolean;
  onChange: (patch: Partial<BrushDynamics>) => void; keys: "fgBg";
}) {
  return (
    <fieldset className="photo-editor__brush-dynamic" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        抖动
        <input type="range" min={0} max={100} step={1} value={Math.round(jitter * 100)} onChange={(event) => onChange({ [`${keys}Jitter`]: Number(event.currentTarget.value) / 100 })} />
      </label>
      <label>
        控制
        <ControlSelect value={control} keys={keys} disabled={disabled} onChange={onChange} />
      </label>
    </fieldset>
  );
}

/** 控制器选项（id + 中文标签）；角度动态只允许方向类控制器。 */
const CONTROL_OPTIONS: readonly { id: BrushControl; label: string }[] = [
  { id: "off", label: "关" },
  { id: "penPressure", label: "钢笔压力" },
  { id: "penTilt", label: "钢笔斜度" },
  { id: "fade", label: "渐隐" },
  { id: "stylusWheel", label: "笔轮" },
  { id: "rotation", label: "笔杆旋转" },
  { id: "direction", label: "笔画方向" },
  { id: "initialDirection", label: "起始方向" }
];

function ControlSelect({ value, keys, disabled, onChange }: {
  value: BrushControl;
  keys: "size" | "opacity" | "flow" | "angle" | "roundness" | "fgBg";
  disabled?: boolean;
  onChange: (patch: Partial<BrushDynamics>) => void;
}) {
  const options = keys === "angle"
    ? CONTROL_OPTIONS.filter((option) => ANGLE_CONTROLS.includes(option.id))
    : CONTROL_OPTIONS;
  return (
    <select value={value} disabled={disabled} onChange={(event) => onChange({ [`${keys}Control`]: event.currentTarget.value as BrushControl })}>
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  );
}

function PercentField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input type="range" min={0} max={100} step={1} disabled={disabled} value={Math.round(value * 100)} onChange={(event) => onChange(Number(event.currentTarget.value) / 100)} />
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

/**
 * 响应曲线的文本入口。
 *
 * 非法输入**不写状态**：输入框保持用户输入、控制台给出原因，但补丁不发出，所以不会把非法
 * 曲线送去内核改像素（内核会静默夹成线性）。
 */
function CurveText({ label, points, disabled, onChange }: { label: string; points: BrushDynamics["sizeCurve"]; disabled: boolean; onChange: (points: BrushDynamics["sizeCurve"]) => void }) {
  const [text, setText] = useState(() => formatCurvePoints(points));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(formatCurvePoints(points)); setError(null); }, [points]);
  return (
    <label>
      {label}
      <input
        value={text}
        disabled={disabled}
        placeholder="0,0; 0.5,0.2; 1,1"
        data-brush-curve={label}
        aria-invalid={error !== null}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (!next.trim()) { setError(null); onChange([]); return; }
          const parsed = parseCurvePoints(next);
          if (!parsed) { setError("曲线格式非法：需要 2–16 个 0–1 的 [输入, 输出] 点且输入递增"); return; }
          setError(null);
          onChange(isLinearCurve(parsed) ? [] : parsed);
        }}
      />
      {error ? <span className="photo-editor__brush-note photo-editor__brush-note--error">{error}</span> : null}
    </label>
  );
}

function DynamicField({
  label,
  dynamics,
  jitter,
  control,
  minimum,
  disabled,
  onChange,
  keys
}: {
  label: string;
  dynamics: BrushDynamics;
  jitter: number;
  control: BrushControl;
  minimum: number;
  disabled: boolean;
  onChange: (patch: Partial<BrushDynamics>) => void;
  keys: "size" | "opacity" | "flow" | "angle" | "roundness";
}) {
  const set = (patch: Partial<BrushDynamics>) => onChange(patch);
  return (
    <fieldset className="photo-editor__brush-dynamic" disabled={disabled} data-brush-dynamic={keys}>
      <legend>{label}动态</legend>
      <label>
        抖动
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(jitter * 100)}
          onChange={(event) => set({ [`${keys}Jitter`]: Number(event.currentTarget.value) / 100 })}
        />
      </label>
      <label>
        控制
        <ControlSelect value={control} keys={keys} disabled={disabled} onChange={onChange} />
      </label>
      {keys === "angle" ? null : (
        <label>
          最小值
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(minimum * 100)}
            onChange={(event) => set({ [`${keys}Minimum`]: Number(event.currentTarget.value) / 100 })}
          />
        </label>
      )}
      <span className="photo-editor__brush-note" hidden>{dynamics.sizeControl}</span>
    </fieldset>
  );
}

/** 笔刷尺寸/不透明度/流量快捷入口（工具参数栏用，不含库）。 */
export function BrushQuickFields({ brush, disabled, onBrush }: { brush: BrushSettings; disabled: boolean; onBrush: (patch: Partial<BrushSettings>) => void }) {
  return (
    <div className="photo-editor__brush-quick">
      <label title="笔刷大小（源像素）">
        大小
        <input type="number" min={1} max={512} value={Math.round(brush.size)} disabled={disabled} onChange={(event) => onBrush({ size: clampBrushSize(Number(event.currentTarget.value)) })} />
      </label>
      <label title="硬度 0–100%">
        硬度
        <input type="range" min={0} max={100} value={Math.round(brush.hardness * 100)} disabled={disabled} onChange={(event) => onBrush({ hardness: Number(event.currentTarget.value) / 100 })} />
      </label>
      <label title="不透明度 0–100%">
        不透明
        <input type="range" min={0} max={100} value={Math.round(brush.opacity * 100)} disabled={disabled} onChange={(event) => onBrush({ opacity: Number(event.currentTarget.value) / 100 })} />
      </label>
      <label title="流量 0–100%">
        流量
        <input type="range" min={0} max={100} value={Math.round(brush.flow * 100)} disabled={disabled} onChange={(event) => onBrush({ flow: Number(event.currentTarget.value) / 100 })} />
      </label>
      {/* U30：绘画混合模式进入 `paint.stroke` 的顶层 `mode`，不是 brush 补丁。 */}
      <label title="绘画混合模式">
        模式
        <select
          value={brush.mode ?? "normal"}
          disabled={disabled}
          data-brush-blend-mode={brush.mode ?? "normal"}
          onChange={(event) => onBrush({ mode: event.currentTarget.value as PaintBlendMode })}
        >
          {PAINT_BLEND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
    </div>
  );
}
