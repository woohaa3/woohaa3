import { useEffect, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import {
  CLONE_OVERLAY_BLENDS,
  CLONE_SOURCE_SLOTS,
  DEFAULT_REGION_OPTIONS,
  DEFAULT_RETOUCH_OPTIONS,
  MOVE_MODES,
  PATCH_MODES,
  RETOUCH_ADDED_TOOLS,
  RETOUCH_ALL_TOOLS,
  RETOUCH_MENU_TOOLS,
  RETOUCH_PANEL_TOOLS,
  RETOUCH_BASE_TOOLS,
  RETOUCH_COMMANDS,
  SAMPLE_LAYERS,
  SPONGE_MODES,
  TONE_RANGES,
  clampRegionOptions,
  clampRetouchOptions,
  decodeCloneSources,
  decodeHistorySources,
  isRegionRetouchCommand,
  regionParams,
  validateRegionGesture,
  validateRetouchOptions,
  type CloneSourceState,
  type RegionOptions,
  type RetouchHistorySource,
  type RetouchOptions,
  type RetouchRegionCommand
} from "./tool-parameters.js";

// ---------------------------------------------------------------- 修饰与滤镜（任务 8.x）

/**
 * 共享上下文栏的「修饰工具」下拉（保持原 9 项与顺序）。
 *
 * 清单本身只有一份，定义在 `tool-parameters.ts`（`RETOUCH_BASE_TOOLS`）；这里只做转出，
 * 避免面板与参数表各写一遍工具名。新增笔迹工具见 `RETOUCH_ADDED_TOOLS`，完整下拉见
 * `RETOUCH_ALL_TOOLS`。
 */
export const RETOUCH_TOOLS = RETOUCH_BASE_TOOLS;

type RetouchSessionLike = {
  retouchOptions?: () => RetouchOptions;
  setRetouchOptions?: (patch: Partial<RetouchOptions>) => RetouchOptions;
  retouchHistorySources?: () => { ok: true; value: RetouchHistorySource[] } | { ok: false; message: string };
  selectHistorySource?: (index: number) => number | null;
  cloneSources?: () => { ok: true; value: CloneSourceState } | { ok: false; message: string };
  selectCloneSource?: (index: number) => unknown;
  setCloneSource?: (index: number, patch: Record<string, unknown>) => unknown;
  resetCloneSourceTransform?: (index: number) => unknown;
  setCloneOverlay?: (patch: Record<string, unknown>) => unknown;
  beginRetouchRegion?: (id: string, params: unknown) => { ok: boolean; message?: string; value?: unknown };
  commitRetouchRegion?: () => { ok: boolean; message?: string };
  cancelRetouchRegion?: () => void;
  /** 红眼位置累积（与画布单击共用；缺省时面板退回本地标记）。 */
  markRedEye?: (point: { x: number; y: number }) => { ok: boolean; message?: string; value?: readonly (readonly [number, number])[] };
  redEyePoints?: () => readonly (readonly [number, number])[];
  clearRedEye?: () => number;
  beginRedEye?: (options?: Record<string, unknown>) => { ok: boolean; message?: string; value?: unknown };
  hasRetouch?: () => boolean;
  /** 是否已有未确认的区域候选（画布拖动或面板都能生成）。 */
  retouchRegionActive?: () => boolean;
};

/**
 * 取本域会话。
 *
 * 面板只通过控制器的公开 `features.retouch` 访问域会话；缺少该端口时退化为旧的最小面板
 * （采样点 + 对齐），不伪造逐工具参数。
 */
function retouchSession(controller?: EditorWorkspaceController): RetouchSessionLike | null {
  if (!controller) return null;
  const features = (controller as unknown as { features?: { retouch?: RetouchSessionLike } }).features;
  return features?.retouch ?? null;
}

function readOptions(session: RetouchSessionLike | null): RetouchOptions {
  try {
    return session?.retouchOptions?.() ?? DEFAULT_RETOUCH_OPTIONS;
  } catch {
    return DEFAULT_RETOUCH_OPTIONS;
  }
}

function NumberField({ label, value, min, max, step = 1, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input type="number" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }} />
    </label>
  );
}

function Check({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

/** 逐命令的专用参数（U39）。 */
function ToolOptions({ command, options, readonly, onPatch }: {
  command: string;
  options: RetouchOptions;
  readonly: boolean;
  onPatch: (patch: Partial<RetouchOptions>) => void;
}) {
  switch (command) {
    case "paint.dodge":
    case "paint.burn":
      return (
        <>
          <label>
            范围
            <select value={options.toneRange} disabled={readonly}
              onChange={(event) => onPatch({ toneRange: event.currentTarget.value as RetouchOptions["toneRange"] })}>
              {TONE_RANGES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <NumberField label="曝光" value={options.exposure} min={1} max={100} disabled={readonly}
            onChange={(exposure) => onPatch({ exposure })} />
          <Check label="保护色调" checked={options.protectTones} disabled={readonly}
            onChange={(protectTones) => onPatch({ protectTones })} />
        </>
      );
    case "paint.sponge":
      return (
        <>
          <label>
            模式
            <select value={options.spongeMode} disabled={readonly}
              onChange={(event) => onPatch({ spongeMode: event.currentTarget.value as RetouchOptions["spongeMode"] })}>
              {SPONGE_MODES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <Check label="自然饱和度" checked={options.vibrance} disabled={readonly}
            onChange={(vibrance) => onPatch({ vibrance })} />
          <span className="photo-editor__option-hint">流量即海绵强度；落笔发送「去色/加色」，不再发送混合模式。</span>
        </>
      );
    case "paint.blur":
    case "paint.sharpen":
    case "paint.smudge":
      return (
        <>
          <NumberField label="强度" value={options.strength} min={1} max={100} disabled={readonly}
            onChange={(strength) => onPatch({ strength })} />
          {command === "paint.sharpen" ? (
            <Check label="保护细节" checked={options.protectDetail} disabled={readonly}
              onChange={(protectDetail) => onPatch({ protectDetail })} />
          ) : null}
          {command === "paint.smudge" ? (
            <Check label="手指绘画" checked={options.fingerPainting} disabled={readonly}
              onChange={(fingerPainting) => onPatch({ fingerPainting })} />
          ) : null}
          <SampleLayerField readonly={readonly} value={options.sampleLayer} onChange={(sampleLayer) => onPatch({ sampleLayer })} />
        </>
      );
    case "paint.remove":
      return (
        <>
          <Check label="闭合环绕区域" checked={options.removeCloseLoops} disabled={readonly}
            onChange={(removeCloseLoops) => onPatch({ removeCloseLoops })} />
          <Check label="结果放到新图层" checked={options.removeNewLayer} disabled={readonly}
            onChange={(removeNewLayer) => onPatch({ removeNewLayer })} />
          <SampleLayerField readonly={readonly} value={options.sampleLayer} onChange={(sampleLayer) => onPatch({ sampleLayer })} />
          <span className="photo-editor__option-hint">在画布上涂过要移除的对象后确认，结果是一步历史。</span>
        </>
      );
    case "paint.cloneStamp":
    case "paint.healingBrush":
    case "paint.spotHealing":
      return (
        <SampleLayerField readonly={readonly} value={options.sampleLayer} onChange={(sampleLayer) => onPatch({ sampleLayer })} />
      );
    default:
      return null;
  }
}

function SampleLayerField({ readonly, value, onChange }: {
  readonly: boolean;
  value: RetouchOptions["sampleLayer"];
  onChange: (value: RetouchOptions["sampleLayer"]) => void;
}) {
  return (
    <label>
      取样
      <select value={value} disabled={readonly}
        onChange={(event) => onChange(event.currentTarget.value as RetouchOptions["sampleLayer"])}>
        {SAMPLE_LAYERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>
  );
}

/** 图案图章：图案来源与对齐（U38）。 */
function PatternOptions({ controller, options, readonly, onPatch }: {
  controller?: EditorWorkspaceController;
  options: RetouchOptions;
  readonly: boolean;
  onPatch: (patch: Partial<RetouchOptions>) => void;
}) {
  const [patterns, setPatterns] = useState<readonly { id: string; label: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const library = controller?.patternLibrary?.();
    if (!library || !library.ok) {
      setPatterns([]);
      setMessage(library ? library.message : "当前宿主没有图案库端口");
      return;
    }
    const presets = [...(library.value.patternPresets ?? []), ...library.value.presets.map((preset) => ({ id: preset.key, name: preset.name }))];
    setPatterns(presets.map((preset) => ({ id: preset.id, label: preset.name })));
    setMessage(null);
  }, [controller]);
  return (
    <>
      <label>
        图案
        <select value={options.patternId} disabled={readonly}
          onChange={(event) => onPatch({ patternId: event.currentTarget.value })}>
          <option value="">图案面板当前图案</option>
          {patterns.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <NumberField label="缩放 %" value={options.patternScale} min={1} max={1000} disabled={readonly}
        onChange={(patternScale) => onPatch({ patternScale })} />
      <NumberField label="角度" value={options.patternAngle} min={-180} max={180} disabled={readonly}
        onChange={(patternAngle) => onPatch({ patternAngle })} />
      <Check label="对齐源坐标" checked={options.patternAligned} disabled={readonly}
        onChange={(patternAligned) => onPatch({ patternAligned })} />
      <Check label="印象派" checked={options.patternImpressionist} disabled={readonly}
        onChange={(patternImpressionist) => onPatch({ patternImpressionist })} />
      {message ? <span className="photo-editor__option-hint">{message}；将使用图案面板当前图案。</span> : null}
    </>
  );
}

/** 历史画笔：稳定历史源选择（U38）。 */
function HistorySourceOptions({ session, options, readonly, onPatch }: {
  session: RetouchSessionLike | null;
  options: RetouchOptions;
  readonly: boolean;
  onPatch: (patch: Partial<RetouchOptions>) => void;
}) {
  const [sources, setSources] = useState<readonly RetouchHistorySource[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!session?.retouchHistorySources) {
      setSources([]);
      setMessage("当前宿主没有历史源端口");
      return;
    }
    const result = session.retouchHistorySources();
    if (!result.ok) {
      setSources([]);
      setMessage(result.message);
      return;
    }
    setSources(result.value);
    setMessage(result.value.length ? null : "没有可用的历史状态");
  }, [session, refresh]);
  const choose = (index: number) => {
    onPatch({ historyState: index });
    session?.selectHistorySource?.(index);
  };
  return (
    <>
      <label>
        历史源
        <select value={options.historyState} disabled={readonly}
          onChange={(event) => choose(Number(event.currentTarget.value))}>
          {sources.length === 0 ? <option value={options.historyState}>（无可用状态）</option> : null}
          {sources.map((entry) => (
            <option key={entry.index} value={entry.index} disabled={!entry.available}>
              {entry.label}{entry.current ? "（当前）" : ""}{entry.available ? "" : "（不含该图层）"}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => setRefresh((value) => value + 1)}>刷新历史源</Button>
      {message ? <span className="photo-editor__option-hint">{message}</span> : null}
      <span className="photo-editor__option-hint">历史画笔只恢复所选状态的内容，不移动当前历史游标。</span>
    </>
  );
}

/** 五槽仿制源与叠加预览（U39）。 */
function CloneSourceOptions({ session, readonly }: { session: RetouchSessionLike | null; readonly: boolean }) {
  const [state, setState] = useState<CloneSourceState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!session?.cloneSources) {
      setState(null);
      setMessage("当前宿主没有仿制源端口");
      return;
    }
    const result = session.cloneSources();
    if (!result.ok) {
      setState(null);
      setMessage(result.message);
      return;
    }
    setState(result.value);
    setMessage(null);
  }, [session, refresh]);
  const reload = () => setRefresh((value) => value + 1);
  if (!state) {
    return message ? <span className="photo-editor__option-hint">{message}</span> : null;
  }
  const slot = state.slots.find((entry) => entry.index === state.active) ?? state.slots[0];
  /**
   * 发一条仿制源命令后刷新。失败必须显示出来：早先直接 `reload()`，内核拒绝（索引越界、
   * 某槽位没设过取样点、落笔中改工具状态、混合模式不支持）时界面毫无变化，用户会以为已生效。
   *
   * 反馈单独存 `feedback`：刷新成功会把加载期 `message` 清成 `null`，不能把命令结果混进同一格。
   */
  const send = (run: () => unknown) => {
    const result = run() as { ok?: boolean; message?: string } | undefined;
    setFeedback(result && result.ok === false ? result.message ?? "仿制源命令被拒绝" : null);
    reload();
  };
  const edit = (patch: Record<string, unknown>) => {
    if (!slot) return;
    send(() => session?.setCloneSource?.(slot.index, patch));
  };
  return (
    <section className="photo-editor__advanced-group" aria-label="仿制源" data-clone-source={slot?.index ?? 0}>
      <span className="photo-editor__options-title">仿制源</span>
      <div role="group" aria-label="仿制源槽位">
        {Array.from({ length: CLONE_SOURCE_SLOTS }, (_, index) => (
          <Button key={index} size="sm" tone={state.active === index ? "primary" : "ghost"} disabled={readonly}
            onClick={() => send(() => session?.selectCloneSource?.(index))}>
            {index + 1}
          </Button>
        ))}
      </div>
      {slot ? (
        <>
          <span className="photo-editor__option-hint">
            {slot.source ? `源 (${Math.round(slot.source[0])}, ${Math.round(slot.source[1])})` : "尚未设置采样点"}
            {slot.offset ? ` · 偏移 (${Math.round(slot.offset[0])}, ${Math.round(slot.offset[1])})` : ""}
          </span>
          <NumberField label="宽 %" value={slot.width} min={1} max={1000} disabled={readonly}
            onChange={(width) => edit({ width })} />
          <NumberField label="高 %" value={slot.height} min={1} max={1000} disabled={readonly}
            onChange={(height) => edit({ height })} />
          <Check label="约束比例" checked={slot.linked} disabled={readonly}
            onChange={(linked) => edit({ linked })} />
          <NumberField label="旋转" value={slot.rotation} min={-180} max={180} disabled={readonly}
            onChange={(rotation) => edit({ rotation })} />
          <Check label="水平翻转" checked={slot.flipH} disabled={readonly}
            onChange={(flipH) => edit({ flipH })} />
          <Check label="垂直翻转" checked={slot.flipV} disabled={readonly}
            onChange={(flipV) => edit({ flipV })} />
          <Button size="sm" tone="ghost" disabled={readonly}
            onClick={() => send(() => session?.resetCloneSourceTransform?.(slot.index))}>重置变换</Button>
        </>
      ) : null}
      <span className="photo-editor__options-title">叠加预览</span>
      <Check label="显示叠加" checked={state.overlay.show} disabled={readonly}
        onChange={(show) => send(() => session?.setCloneOverlay?.({ show }))} />
      <NumberField label="不透明度" value={state.overlay.opacity} min={0} max={100} disabled={readonly}
        onChange={(opacity) => send(() => session?.setCloneOverlay?.({ opacity }))} />
      <label>
        混合
        <select value={state.overlay.blend} disabled={readonly}
          onChange={(event) => send(() => session?.setCloneOverlay?.({ blend: event.currentTarget.value }))}>
          {CLONE_OVERLAY_BLENDS.map((blend) => <option key={blend} value={blend}>{blend}</option>)}
        </select>
      </label>
      <Check label="裁剪到笔尖" checked={state.overlay.clipped} disabled={readonly}
        onChange={(clipped) => send(() => session?.setCloneOverlay?.({ clipped }))} />
      <Check label="落笔时自动隐藏" checked={state.overlay.autoHide} disabled={readonly}
        onChange={(autoHide) => send(() => session?.setCloneOverlay?.({ autoHide }))} />
      <Check label="反相" checked={state.overlay.invert} disabled={readonly}
        onChange={(invert) => send(() => session?.setCloneOverlay?.({ invert }))} />
      {feedback ? <span className="photo-editor__option-hint photo-editor__brush-note--error">{feedback}</span> : null}
      {message ? <span className="photo-editor__option-hint">{message}</span> : null}
    </section>
  );
}

/**
 * 区域命令（U37）：修补／内容识别移动／红眼的候选 → 确认/取消。
 *
 * 画布拖动偏移由共享手势适配提供；面板在拿到偏移前也能用数值输入精确指定同一个参数，因此
 * 候选、预览与确认在域内即可走通，且取消不留半次修补。
 */
function RegionPanel({ session, command, readonly, samplePoint, onMessage }: {
  session: RetouchSessionLike | null;
  command: RetouchRegionCommand;
  readonly: boolean;
  samplePoint: [number, number] | null;
  onMessage: (value: string | null) => void;
}) {
  const [options, setOptions] = useState<RegionOptions>(DEFAULT_REGION_OPTIONS);
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const [points, setPoints] = useState<readonly (readonly [number, number])[]>([]);
  // 候选可能由画布拖动生成（`beginRetouchRegionDrag`），所以「确认/取消」不能在面板里
  // 另存一份真值：每次渲染都问域会话，两条入口才是同一个状态。
  const [panelActive, setActive] = useState(false);
  const active = panelActive || Boolean(session?.retouchRegionActive?.());
  const update = (patch: Partial<RegionOptions>) => setOptions((value) => clampRegionOptions({ ...value, ...patch }));
  const isRedEye = command === "paint.redEye";
  // 红眼位置与画布共用域会话里的同一份标记；没有该端口时退化为面板本地标记。
  const shared = Boolean(session?.markRedEye);
  const refreshMarks = () => {
    if (shared) setPoints(session?.redEyePoints?.() ?? []);
  };
  // 切到红眼或用画布标记后再回到面板时，把域会话里已有的位置读回来。
  useEffect(() => {
    if (!isRedEye) return;
    refreshMarks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRedEye, command, session]);
  const addMark = (point: [number, number] | null) => {
    if (!point) return;
    if (!shared) { setPoints((value) => [...value, point]); return; }
    const result = session!.markRedEye!({ x: point[0], y: point[1] });
    if (!result.ok) { onMessage(result.message ?? "无法标记这个位置"); return; }
    onMessage(null);
    refreshMarks();
  };
  const clearMarks = () => {
    if (shared) { session?.clearRedEye?.(); refreshMarks(); }
    else setPoints([]);
  };
  const gesture = { offset, points, layer: null } as const;
  const invalid = validateRegionGesture(command, options, gesture);
  const begin = () => {
    if (!session?.beginRetouchRegion) { onMessage("当前宿主没有区域修饰端口"); return; }
    // 红眼位置已交给域会话时由它生成参数（同一份标记也在画布上累积）。只有「标记走域会话」
    // 时才能用 `beginRedEye`：否则它会去读域会话里的空点集，把面板上已标好的位置丢成
    // 「请先标出红眼位置」。
    const result = isRedEye && shared && session.beginRedEye
      ? session.beginRedEye({ redEyePupilSize: options.redEyePupilSize, redEyeDarken: options.redEyeDarken })
      : (() => {
        const params = regionParams(command, options, gesture);
        if (!params) return { ok: false as const, message: invalid ?? "参数不完整" };
        return session.beginRetouchRegion!(command, params);
      })();
    if (!result.ok) { onMessage(result.message ?? "无法计算候选"); setActive(false); return; }
    setActive(true);
    onMessage(null);
    refreshMarks();
  };
  const commit = () => {
    const result = session?.commitRetouchRegion?.();
    setActive(false);
    onMessage(result && !result.ok ? result.message ?? "确认失败" : null);
  };
  const cancel = () => {
    session?.cancelRetouchRegion?.();
    setActive(false);
    onMessage(null);
  };
  return (
    <section className="photo-editor__advanced-group" aria-label="区域修饰" data-region-retouch={command}>
      <span className="photo-editor__options-title">{RETOUCH_COMMANDS.find((entry) => entry.id === command)?.label ?? "区域修饰"}</span>
      {isRedEye ? (
        <>
          {/*
            候选进行中必须锁住位置编辑：位置已经交给内核的那份候选，此时还能加点/清空的话，
            面板显示的数量和候选实际用的点集就会不一致（取消后保留位置的修复也会被绕过）。
          */}
          <Button size="sm" tone="ghost" disabled={readonly || active || !samplePoint}
            onClick={() => addMark(samplePoint)}>用采样点添加红眼</Button>
          <span className="photo-editor__option-hint">{points.length ? `已标记 ${points.length} 处` : "先 Alt+单击画布标出红眼，或点上面的按钮"}</span>
          <Button size="sm" tone="ghost" disabled={readonly || active || points.length === 0} onClick={clearMarks}>清空位置</Button>
          <NumberField label="瞳孔大小" value={options.redEyePupilSize} min={1} max={100} disabled={readonly || active}
            onChange={(redEyePupilSize) => update({ redEyePupilSize })} />
          <NumberField label="变暗量" value={options.redEyeDarken} min={0} max={100} disabled={readonly || active}
            onChange={(redEyeDarken) => update({ redEyeDarken })} />
        </>
      ) : (
        <>
          <label>
            模式
            <select value={command === "paint.patch" ? options.patchMode : options.moveMode} disabled={readonly || active}
              onChange={(event) => command === "paint.patch"
                ? update({ patchMode: event.currentTarget.value as RegionOptions["patchMode"] })
                : update({ moveMode: event.currentTarget.value as RegionOptions["moveMode"] })}>
              {(command === "paint.patch" ? PATCH_MODES : MOVE_MODES).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
          </label>
          <NumberField label="偏移 X" value={offset[0]} min={-10000} max={10000} disabled={readonly || active}
            onChange={(dx) => setOffset([dx, offset[1]])} />
          <NumberField label="偏移 Y" value={offset[1]} min={-10000} max={10000} disabled={readonly || active}
            onChange={(dy) => setOffset([offset[0], dy])} />
          <NumberField label="结构" value={options.structure} min={1} max={7} disabled={readonly}
            onChange={(structure) => update({ structure })} />
          <NumberField label="颜色适应" value={options.color} min={0} max={10} step={0.5} disabled={readonly}
            onChange={(color) => update({ color })} />
          <Check label="对所有图层取样" checked={options.sampleAllLayers} disabled={readonly}
            onChange={(sampleAllLayers) => update({ sampleAllLayers })} />
          {command === "paint.contentAwareMove" ? (
            <>
              <NumberField label="缩放 X %" value={options.scaleX} min={1} max={10000} disabled={readonly}
                onChange={(scaleX) => update({ scaleX })} />
              <NumberField label="缩放 Y %" value={options.scaleY} min={1} max={10000} disabled={readonly}
                onChange={(scaleY) => update({ scaleY })} />
              <NumberField label="旋转" value={options.rotate} min={-180} max={180} disabled={readonly}
                onChange={(rotate) => update({ rotate })} />
            </>
          ) : null}
          <span className="photo-editor__option-hint">先在画布上建立选区；偏移即拖动的距离。</span>
        </>
      )}
      <Button size="sm" disabled={readonly || active || invalid !== null} onClick={begin}>计算候选</Button>
      <Button size="sm" tone="primary" disabled={readonly || !active} onClick={commit}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={cancel}>取消</Button>
      {invalid ? <span className="photo-editor__option-hint">{invalid}</span> : null}
    </section>
  );
}
/**
 * 区域修饰组（U37）：修补／内容识别移动／红眼的候选 → 确认。
 *
 * 区域命令**不再**在面板里另存一份选择器：当前命令由共享上下文栏的「修饰工具」下拉
 * （`RETOUCH_MENU_TOOLS`）决定，画布手势与面板读同一个 `tool`。否则画布不知道该走区域路径，
 * 面板里选中的命令和画布拖动会各说各话。`tool` 不是区域命令时整组不渲染。
 */
function RegionGroup({ session, tool, readonly, samplePoint }: {
  session: RetouchSessionLike | null;
  tool: string;
  readonly: boolean;
  samplePoint: [number, number] | null;
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (!isRegionRetouchCommand(tool)) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="区域修饰组" data-region-group="true" data-region-retouch={tool}>
      <RegionPanel session={session} command={tool} readonly={readonly}
        samplePoint={samplePoint} onMessage={setMessage} />
      {message ? <p className="photo-editor__brush-note">{message}</p> : null}
    </section>
  );
}

/** 修饰工具参数面板：采样点、对齐、逐工具选项、历史源、仿制源与区域命令。 */
export function RetouchPanel({ readonly, tool, onSample, samplePoint, aligned, onAligned, controller, onTool }: {
  readonly: boolean;
  tool: string;
  onSample: () => void;
  samplePoint: [number, number] | null;
  aligned: boolean;
  onAligned: (value: boolean) => void;
  controller?: EditorWorkspaceController;
  /**
   * 「滤镜 → 修饰工具…」入口的工具选择器。
   *
   * 上下文栏那条入口自己有共享下拉，这个面板没有，所以不传时不渲染选择器，避免同一屏出现
   * 两个互相打架的「当前工具」。选了之后必须同时切到修饰手势，否则画布不知道该走笔迹还是
   * 区域路径（与上下文栏下拉同一份状态）。
   */
  onTool?: (id: string) => void;
}) {
  const session = retouchSession(controller);
  const [options, setOptions] = useState<RetouchOptions>(() => readOptions(session));
  useEffect(() => {
    setOptions(readOptions(session));
  }, [session, tool]);
  const patch = (value: Partial<RetouchOptions>) => {
    if (!session?.setRetouchOptions) {
      setOptions((current) => clampRetouchOptions({ ...current, ...value }));
      return;
    }
    setOptions(session.setRetouchOptions(value));
  };
  const label = RETOUCH_COMMANDS.find((entry) => entry.id === tool)?.label ?? "修饰";
  const invalid = validateRetouchOptions(tool, options);
  const needsSample = tool === "paint.cloneStamp" || tool === "paint.healingBrush";
  const cloneTool = tool === "paint.cloneStamp" || tool === "paint.healingBrush";
  // 没有域会话端口时（宿主未接线），逐工具选项无法到达内核：禁用而不是显示成可改。
  const optionsLocked = readonly || !session?.setRetouchOptions;
  return (
    <>
      <section className="photo-editor__advanced-group" aria-label="修饰工具" data-retouch-tool={tool}>
        <span className="photo-editor__options-title">{label}</span>
        {onTool ? (
          <label>
            工具
            <select value={tool} disabled={readonly} onChange={(event) => onTool(event.currentTarget.value)}>
              {RETOUCH_PANEL_TOOLS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
        ) : null}
        {needsSample ? (
          <>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={onSample}>设置采样点</Button>
            <Check label="对齐" checked={aligned} disabled={readonly} onChange={onAligned} />
            {/*
              取样源只显示一处：有仿制源端口时，活动槽位才是落笔真正用的源（多仿制源，U39），
              顶部再显示 app 本地的旧坐标会在切槽位后指向错误的点，所以交给下面「仿制源」组。
            */}
            <span className="photo-editor__option-hint">
              {session?.cloneSources
                ? "取样点见下方「仿制源」的活动槽位"
                : samplePoint ? `源 (${Math.round(samplePoint[0])}, ${Math.round(samplePoint[1])})` : "尚未设置采样点"}
            </span>
          </>
        ) : null}
        <ToolOptions command={tool} options={options} readonly={optionsLocked} onPatch={patch} />
        {tool === "paint.patternStamp" ? (
          <PatternOptions controller={controller} options={options} readonly={optionsLocked} onPatch={patch} />
        ) : null}
        {tool === "paint.historyBrush" ? (
          <HistorySourceOptions session={session} options={options} readonly={optionsLocked} onPatch={patch} />
        ) : null}
        {!session?.setRetouchOptions ? (
          <span className="photo-editor__option-hint">当前宿主没有接通修饰会话：逐工具参数不可改。</span>
        ) : null}
        {cloneTool && !samplePoint && !session?.cloneSources ? (
          <span className="photo-editor__option-hint">仿制图章与修复画笔必须先取样：Alt+单击画布。</span>
        ) : null}
        {invalid ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{invalid}</p> : null}
      </section>
      {cloneTool ? <CloneSourceOptions session={session} readonly={readonly} /> : null}
      <RegionGroup session={session} tool={tool} readonly={readonly} samplePoint={samplePoint} />
    </>
  );
}

export { decodeCloneSources, decodeHistorySources, RETOUCH_ADDED_TOOLS, RETOUCH_ALL_TOOLS, RETOUCH_MENU_TOOLS, RETOUCH_PANEL_TOOLS };
