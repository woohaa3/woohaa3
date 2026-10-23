import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorPreview } from "../../editor-wasm.js";
import { isRecord } from "../shared/panels.js";
import {
  CHANNEL_VIEW_MAX_SIDE,
  CHANNEL_THUMBNAIL_MAX_SIDE,
  BLENDINGS,
  activeDocumentIndex,
  applyImageParams,
  calculationsParams,
  channelReference,
  decodeChannelSnapshot,
  defaultApplyImageForm,
  defaultCalculationsForm,
  sourceChannelOptions,
  targetCode,
  targetSelectionReference,
  usesScaleOffset,
  type ApplyImageForm,
  type CalculationsForm,
  type ChannelSnapshot,
  type SourceForm
} from "./model.js";

// ---------------------------------------------------------------- 通道面板（U25）

/** 面板行读取缩略图；只读内核正式文档，不建第二份像素缓存。 */
function ChannelThumbnail({ controller, code, revision }: { controller: EditorWorkspaceController; code: string; revision: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  useEffect(() => {
    const reference = channelReference(code);
    if (!reference) {
      setPreview(null);
      return;
    }
    const result = controller.features.channels.channelThumbnail(reference, CHANNEL_THUMBNAIL_MAX_SIDE);
    setPreview(result.ok ? result.value : null);
  }, [controller, code, revision]);
  useEffect(() => {
    if (!preview) return;
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0);
  }, [preview]);
  return preview
    ? <canvas ref={canvas} width={preview.width} height={preview.height} className="photo-editor__channel-thumb" data-channel-thumb={code} />
    : <span className="photo-editor__channel-thumb" data-channel-thumb={code} />;
}

/** 有界通道视图：单通道目标是灰度，复合目标是合成结果。 */
function ChannelViewPreview({ controller, revision }: { controller: EditorWorkspaceController; revision: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const result = controller.features.channels.channelViewPreview(CHANNEL_VIEW_MAX_SIDE);
    if (!result.ok) {
      setMessage(result.message);
      setPreview(null);
      return;
    }
    setMessage(null);
    setPreview(result.value);
  }, [controller, revision]);
  useEffect(() => {
    if (!preview) return;
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0);
  }, [preview]);
  if (message) return <p className="photo-editor__brush-note">{message}</p>;
  return preview
    ? <canvas ref={canvas} width={preview.width} height={preview.height} className="photo-editor__channel-view" data-channel-view="true" />
    : null;
}

const INDICATES = [
  ["masked", "被蒙版区域"],
  ["selected", "所选区域"]
] as const;

export function ChannelPanel({
  controller,
  readonly,
  revision,
  hasSelection,
  onChanged
}: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  revision: number;
  hasSelection: boolean;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [newChannel, setNewChannel] = useState({ name: "", fill: "black", indicates: "masked", color: "#ff0000", opacity: 100 });
  const [newSpot, setNewSpot] = useState({ name: "", color: "#00ff00", solidity: 0, fromSelection: true });
  const [rename, setRename] = useState<{ index: number; name: string } | null>(null);
  const [editingOptions, setEditingOptions] = useState<{ index: number; name: string; indicates: string; color: string; opacity: number; solidity: number } | null>(null);
  const [split, setSplit] = useState({ closeOriginal: true });
  const [merge, setMerge] = useState<{ documents: number[]; name: string }>({ documents: [], name: "" });

  const refresh = useCallback(() => {
    const result = controller.features.channels.channelSnapshot();
    if (!result.ok) {
      setMessage(result.message);
      setSnapshot(null);
      return;
    }
    const decoded = decodeChannelSnapshot(result.value);
    if (!decoded) {
      setMessage("通道快照结构非法");
      setSnapshot(null);
      return;
    }
    setSnapshot(decoded);
  }, [controller]);

  useEffect(() => {
    refresh();
  }, [refresh, revision, version]);

  /** 文本次级操作：命令成功才刷新面板与画布，失败只回显原因。 */
  const run = (id: string, params: unknown) => {
    if (readonly) return;
    const result = controller.features.channels.channelCommand(id, params);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setVersion((value) => value + 1);
    onChanged();
  };

  /** 选区命令属于选区域，能力已开放；按当前目标通道载入/保存。 */
  const selection = (id: string, params: unknown) => {
    if (readonly) return;
    const result = controller.dispatch(id, params);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setVersion((value) => value + 1);
    onChanged();
  };

  if (!snapshot) {
    return (
      <section className="photo-editor__advanced-group" aria-label="通道" data-channel-panel="true">
        <span className="photo-editor__options-title">通道</span>
        <p className="photo-editor__brush-note">{message ?? "读取通道…"}</p>
      </section>
    );
  }

  const active = targetCode(snapshot);
  const targetReference = targetSelectionReference(snapshot);
  const mergeable = snapshot.documents.filter((row) => row.grayscale && row.sameSize);

  return (
    <section className="photo-editor__advanced-group" aria-label="通道" data-channel-panel="true" data-channel-target={active ?? snapshot.target.kind}>
      <span className="photo-editor__options-title">通道</span>
      <div className="photo-editor__channel-rows">
        <div className="photo-editor__channel-row" data-channel-row="composite" data-selected={snapshot.target.kind === "composite"}>
          <span className="photo-editor__channel-eye" data-channel-eye="composite" data-visible={snapshot.compositeVisible}
            onClick={() => run("channel.setVisible", { channel: "composite", visible: !snapshot.compositeVisible })}>{snapshot.compositeVisible ? "●" : "○"}</span>
          <button type="button" className="photo-editor__channel-target" disabled={readonly}
            onClick={() => run("channel.target", { channel: "composite" })}>
            <ChannelThumbnail controller={controller} code={snapshot.colors.length > 1 ? "composite" : "color:0"} revision={revision} />
            <span>{snapshot.composite}</span>
          </button>
        </div>
        {snapshot.colors.map((row) => (
          <div key={`color:${row.index}`} className="photo-editor__channel-row" data-channel-row={`color:${row.index}`}
            data-selected={active === `color:${row.index}`}>
            <span className="photo-editor__channel-eye" data-channel-eye={`color:${row.index}`} data-visible={row.visible}
              onClick={() => run("channel.setVisible", { channel: { color: row.index }, visible: !row.visible })}>{row.visible ? "●" : "○"}</span>
            <button type="button" className="photo-editor__channel-target" disabled={readonly}
              onClick={() => run("channel.target", { channel: { color: row.index } })}>
              <ChannelThumbnail controller={controller} code={`color:${row.index}`} revision={revision} />
              <span>{row.name}</span>
            </button>
          </div>
        ))}
        {snapshot.alpha.map((row, position) => (
          <div key={`alpha:${row.index}`} className="photo-editor__channel-row" data-channel-row={`alpha:${row.index}`}
            data-channel-kind={row.kind} data-selected={active === `alpha:${row.index}`}>
            <span className="photo-editor__channel-eye" data-channel-eye={`alpha:${row.index}`} data-visible={row.visible}
              onClick={() => run("channel.setVisible", { channel: { alpha: row.index }, visible: !row.visible })}>{row.visible ? "●" : "○"}</span>
            <button type="button" className="photo-editor__channel-target" disabled={readonly}
              onClick={() => run("channel.target", { channel: { alpha: row.index } })}>
              <ChannelThumbnail controller={controller} code={`alpha:${row.index}`} revision={revision} />
              <span style={{ fontStyle: row.kind === "spot" ? "italic" : undefined }}>{row.name}</span>
            </button>
            <span className="photo-editor__channel-buttons">
              {/* 行序即内核数组序；边界判断用行位置，不依赖索引恰好从 0 连续。 */}
              <Button size="sm" tone="ghost" disabled={readonly || position === 0} title="上移通道"
                onClick={() => run("channel.move", { channel: { alpha: row.index }, to: row.index - 1 })}>↑</Button>
              <Button size="sm" tone="ghost" disabled={readonly || position === snapshot.alpha.length - 1} title="下移通道"
                onClick={() => run("channel.move", { channel: { alpha: row.index }, to: row.index + 1 })}>↓</Button>
              <Button size="sm" tone="ghost" disabled={readonly} title="复制通道"
                onClick={() => run("channel.duplicate", { channel: { alpha: row.index } })}>复制</Button>
              <Button size="sm" tone="ghost" disabled={readonly} title="通道选项"
                onClick={() => setEditingOptions({ index: row.index, name: row.name, indicates: row.indicates, color: row.spot?.color ?? row.color, opacity: row.opacity, solidity: row.spot?.solidity ?? 0 })}>选项…</Button>
              <Button size="sm" tone="ghost" disabled={readonly} title="重命名通道"
                onClick={() => setRename({ index: row.index, name: row.name })}>改名…</Button>
              {row.kind === "spot" ? (
                <Button size="sm" tone="ghost" disabled={readonly} title="把专色通道并入像素"
                  onClick={() => run("channel.mergeSpot", { channel: { alpha: row.index } })}>合并专色</Button>
              ) : null}
              <Button size="sm" tone="danger" disabled={readonly} title="删除通道"
                onClick={() => run("channel.delete", { channel: { alpha: row.index } })}>删除</Button>
            </span>
          </div>
        ))}
      </div>

      {rename ? (
        <div className="photo-editor__channel-form" data-channel-rename={rename.index}>
          <label>通道名<input value={rename.name} disabled={readonly} onChange={(event) => setRename({ ...rename, name: event.currentTarget.value })} /></label>
          <Button size="sm" disabled={readonly || !rename.name.trim()} onClick={() => { run("channel.rename", { channel: { alpha: rename.index }, name: rename.name }); setRename(null); }}>确定</Button>
          <Button size="sm" tone="ghost" onClick={() => setRename(null)}>取消</Button>
        </div>
      ) : null}

      {editingOptions ? (
        <div className="photo-editor__channel-form" data-channel-options={editingOptions.index}>
          <label>通道名<input value={editingOptions.name} disabled={readonly} onChange={(event) => setEditingOptions({ ...editingOptions, name: event.currentTarget.value })} /></label>
          <label>叠层颜色<input type="color" value={editingOptions.color} disabled={readonly} onChange={(event) => setEditingOptions({ ...editingOptions, color: event.currentTarget.value })} /></label>
          <label>叠层不透明度<input type="number" min={0} max={100} value={editingOptions.opacity} disabled={readonly} onChange={(event) => setEditingOptions({ ...editingOptions, opacity: Number(event.currentTarget.value) })} /></label>
          {snapshot.alpha[editingOptions.index]?.kind === "spot" ? (
            <label>密度<input type="number" min={0} max={100} value={editingOptions.solidity} disabled={readonly} onChange={(event) => setEditingOptions({ ...editingOptions, solidity: Number(event.currentTarget.value) })} /></label>
          ) : (
            <label>表示<select value={editingOptions.indicates} disabled={readonly} onChange={(event) => setEditingOptions({ ...editingOptions, indicates: event.currentTarget.value })}>
              {INDICATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          )}
          <Button size="sm" disabled={readonly} onClick={() => {
            const spot = snapshot.alpha[editingOptions.index]?.kind === "spot";
            run("channel.options", {
              channel: { alpha: editingOptions.index },
              name: editingOptions.name,
              color: editingOptions.color,
              ...(spot ? { solidity: editingOptions.solidity } : { opacity: editingOptions.opacity, indicates: editingOptions.indicates })
            });
            setEditingOptions(null);
          }}>确定</Button>
          <Button size="sm" tone="ghost" onClick={() => setEditingOptions(null)}>取消</Button>
        </div>
      ) : null}

      <div className="photo-editor__channel-create" data-channel-create="alpha">
        <span className="photo-editor__option-hint">新建通道</span>
        <label>名称<input value={newChannel.name} placeholder="Alpha 1" disabled={readonly} onChange={(event) => setNewChannel({ ...newChannel, name: event.currentTarget.value })} /></label>
        <label>填充<select value={newChannel.fill} disabled={readonly} onChange={(event) => setNewChannel({ ...newChannel, fill: event.currentTarget.value })}>
          <option value="black">黑色</option>
          <option value="white">白色</option>
          <option value="selection">选区</option>
        </select></label>
        <label>表示<select value={newChannel.indicates} disabled={readonly} onChange={(event) => setNewChannel({ ...newChannel, indicates: event.currentTarget.value })}>
          {INDICATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>颜色<input type="color" value={newChannel.color} disabled={readonly} onChange={(event) => setNewChannel({ ...newChannel, color: event.currentTarget.value })} /></label>
        <label>不透明度<input type="number" min={0} max={100} value={newChannel.opacity} disabled={readonly} onChange={(event) => setNewChannel({ ...newChannel, opacity: Number(event.currentTarget.value) })} /></label>
        <Button size="sm" disabled={readonly || (newChannel.fill === "selection" && !hasSelection)}
          title={newChannel.fill === "selection" && !hasSelection ? "先用选区工具建立选区" : undefined}
          onClick={() => run("channel.new", {
            ...(newChannel.name.trim() ? { name: newChannel.name } : {}),
            fill: newChannel.fill,
            indicates: newChannel.indicates,
            color: newChannel.color,
            opacity: newChannel.opacity
          })}>新建 Alpha 通道</Button>
      </div>

      <div className="photo-editor__channel-create" data-channel-create="spot">
        <span className="photo-editor__option-hint">新建专色通道（只保证屏幕替代色，不承诺印刷分色）</span>
        <label>名称<input value={newSpot.name} placeholder="Spot Color 1" disabled={readonly} onChange={(event) => setNewSpot({ ...newSpot, name: event.currentTarget.value })} /></label>
        <label>颜色<input type="color" value={newSpot.color} disabled={readonly} onChange={(event) => setNewSpot({ ...newSpot, color: event.currentTarget.value })} /></label>
        <label>密度<input type="number" min={0} max={100} value={newSpot.solidity} disabled={readonly} onChange={(event) => setNewSpot({ ...newSpot, solidity: Number(event.currentTarget.value) })} /></label>
        <label><input type="checkbox" checked={newSpot.fromSelection} disabled={readonly || !hasSelection} onChange={(event) => setNewSpot({ ...newSpot, fromSelection: event.currentTarget.checked })} />用选区填充</label>
        <Button size="sm" disabled={readonly} onClick={() => run("channel.newSpot", {
          ...(newSpot.name.trim() ? { name: newSpot.name } : {}),
          color: newSpot.color,
          solidity: newSpot.solidity,
          fromSelection: newSpot.fromSelection && hasSelection
        })}>新建专色通道</Button>
      </div>

      <div className="photo-editor__channel-actions">
        <Button size="sm" disabled={readonly || !targetReference} title={targetReference ? undefined : "蒙版目标暂未接入共享端口"}
          onClick={() => selection("select.loadSelection", { channel: targetReference })}>载入通道为选区</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasSelection}
          onClick={() => selection("select.saveSelection", { channel: "new", operation: "new" })}>存储选区为通道</Button>
        <Button size="sm" tone="ghost" disabled={readonly} title="按复合亮度建立选区，不需要已有选区" onClick={() => run("select.loadLuminosity", null)}>载入亮度选区</Button>
        <Button size="sm" tone="ghost" onClick={() => setViewOpen((value) => !value)}>{viewOpen ? "隐藏通道视图" : "查看通道视图"}</Button>
      </div>
      {viewOpen ? <ChannelViewPreview controller={controller} revision={revision} /> : null}

      <div className="photo-editor__channel-split">
        <span className="photo-editor__option-hint">拆分 / 合并通道</span>
        <label><input type="checkbox" checked={split.closeOriginal} disabled={readonly} onChange={(event) => setSplit({ closeOriginal: event.currentTarget.checked })} />拆分后关闭原文档</label>
        <Button size="sm" disabled={readonly}
          onClick={() => run("channel.split", { closeOriginal: split.closeOriginal })}>拆分为灰度文档</Button>
        <span className="photo-editor__option-hint">可合并的灰度文档（{mergeable.length}）：</span>
        {mergeable.map((row) => (
          <label key={row.index}>
            <input type="checkbox" checked={merge.documents.includes(row.index)} disabled={readonly}
              onChange={(event) => setMerge({
                ...merge,
                documents: event.currentTarget.checked
                  ? [...merge.documents, row.index].sort((a, b) => a - b)
                  : merge.documents.filter((index) => index !== row.index)
              })} />{row.name}
          </label>
        ))}
        {/* 只合成 RGB：CMYK/Lab 属多色彩管理与印刷分色，本域不开放，内核同层拒绝。 */}
        <span className="photo-editor__option-hint">模式 RGB</span>
        <label>名称<input value={merge.name} placeholder="合并结果" disabled={readonly} onChange={(event) => setMerge({ ...merge, name: event.currentTarget.value })} /></label>
        <Button size="sm" disabled={readonly || merge.documents.length < 3}
          onClick={() => run("channel.merge", {
            mode: "rgb",
            ...(merge.documents.length ? { documents: merge.documents } : {}),
            ...(merge.name.trim() ? { name: merge.name } : {})
          })}>合并通道</Button>
      </div>
      <p className="photo-editor__option-hint">当前 {snapshot.alpha.length} 个 Alpha/专色通道 · 最多 {snapshot.maxOpenDocuments} 个同时打开的文档</p>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-channel-error="true">{message}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 应用图像 / 计算（U26）

function SourceFields({ label, form, onChange, snapshot }: {
  label: string;
  form: SourceForm;
  onChange: (next: SourceForm) => void;
  snapshot: ChannelSnapshot | null;
}) {
  const options = snapshot ? sourceChannelOptions(snapshot, form.document) : [{ value: "composite", label: "合成通道" }];
  return (
    <fieldset data-channel-source={label}>
      <legend>{label}</legend>
      <label>文档<select value={form.document} onChange={(event) => onChange({ ...form, document: Number(event.currentTarget.value), channel: "composite" })}>
        {(snapshot?.documents ?? []).map((row) => (
          <option key={row.index} value={row.index}>{row.name}{row.sameSize ? "" : `（${row.width}×${row.height}，尺寸不匹配）`}</option>
        ))}
      </select></label>
      <label>图层<input value={form.layer} placeholder="合并图像" onChange={(event) => onChange({ ...form, layer: event.currentTarget.value })} /></label>
      <label>通道<select value={form.channel} onChange={(event) => onChange({ ...form, channel: event.currentTarget.value })}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label><input type="checkbox" checked={form.invert} onChange={(event) => onChange({ ...form, invert: event.currentTarget.checked })} />反相</label>
    </fieldset>
  );
}

function BlendingFields({ form, onChange }: {
  form: { blending: string; opacity: number; scale: number; offset: number };
  onChange: (patch: Partial<{ blending: string; opacity: number; scale: number; offset: number }>) => void;
}) {
  return (
    <>
      <label>混合<select value={form.blending} onChange={(event) => onChange({ blending: event.currentTarget.value })}>
        {BLENDINGS.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
      </select></label>
      <label>不透明度<input type="number" min={0} max={100} value={form.opacity} onChange={(event) => onChange({ opacity: Number(event.currentTarget.value) })} /></label>
      {usesScaleOffset(form.blending) ? (
        <>
          <label>系数<input type="number" min={1} max={2} step={0.01} value={form.scale} onChange={(event) => onChange({ scale: Number(event.currentTarget.value) })} /></label>
          <label>位移<input type="number" min={-255} max={255} value={form.offset} onChange={(event) => onChange({ offset: Number(event.currentTarget.value) })} /></label>
        </>
      ) : null}
    </>
  );
}

function MaskField({ value, onChange, snapshot }: {
  value: string;
  onChange: (value: string) => void;
  snapshot: ChannelSnapshot | null;
}) {
  // 蒙版来源不带 `document`，上游按**活动**文档解析，选项必须来自活动文档而不是源文档。
  const options = snapshot ? sourceChannelOptions(snapshot, activeDocumentIndex(snapshot)) : [{ value: "composite", label: "合成通道" }];
  return (
    <label>蒙版<select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">无</option>
      {options.filter((option) => option.value !== "transparency").map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
  );
}

/** 预览候选：像素来自内核副本，正式文档不受影响。 */
function CandidatePreview({ preview }: { preview: EditorPreview | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!preview) return;
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0);
  }, [preview]);
  return preview
    ? <canvas ref={canvas} width={preview.width} height={preview.height} className="photo-editor__channel-view" data-channel-candidate="true" />
    : null;
}

function previewSummary(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const revisionChanged = value.revisionChanged === true;
  const rows = isRecord(value.channels) ? value.channels.alpha : null;
  const channels = Array.isArray(rows) ? rows.length : null;
  const documents = typeof value.documents === "number" ? value.documents : null;
  return [
    revisionChanged ? "候选会改变内容" : "候选与当前内容相同",
    channels === null ? null : `${channels} 个 Alpha/专色通道`,
    documents === null ? null : `会话内 ${documents} 个文档`
  ].filter(Boolean).join(" · ");
}

/**
 * 应用图像：源文档/层/通道 + 混合/不透明度/反相 + 目标。
 *
 * 预览与确认都从**当前**参数重新计算；参数改动没有成功预览时不能确认（不提交旧候选）。
 * 候选还绑定「预览时的文档 + 修订」：文档换了、或这份文档在预览之后又被别处写入，
 * 候选像素就不再对应当前内容，必须重新预览才能确认（design「事务和生命周期」）。
 */
export function ApplyImagePanel({ controller, readonly, revision, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [form, setForm] = useState<ApplyImageForm>(() => defaultApplyImageForm(null));
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dirtyPreview, setDirtyPreview] = useState(false);
  const documentId = useRef<number | null>(null);
  const previewOwner = useRef<{ documentId: number; revision: number } | null>(null);

  useEffect(() => {
    const result = controller.features.channels.channelSnapshot();
    const decoded = result.ok ? decodeChannelSnapshot(result.value) : null;
    setSnapshot(decoded);
    if (!decoded) return;
    // 同一文档的修订变化（别处写入）只修正失效目标；换文档才重建表单，避免把用户输入冲掉。
    if (documentId.current === decoded.documentId) {
      setForm((current) => ({ ...current, ...withoutStaleTarget(current, decoded) }));
      // 预览之后文档又被写入：旧候选的像素已不对应当前内容，取消确认资格。
      if (previewOwner.current !== null && previewOwner.current.revision !== decoded.revision) {
        setPreview(null);
        setSummary(null);
        setDirtyPreview(true);
      }
      return;
    }
    documentId.current = decoded.documentId;
    previewOwner.current = null;
    setForm(defaultApplyImageForm(decoded));
    setPreview(null);
    setSummary(null);
    setDirtyPreview(false);
  }, [controller, revision]);

  const update = (patch: Partial<ApplyImageForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirtyPreview(true);
  };

  // 只列内核真正支持的目标：图层像素与 Alpha/专色通道。图层蒙版目标会被内核明确拒绝，
  // 列出来只会让用户以为能写蒙版（上游 `applyImage` 只写像素）。
  const targetOptions = [
    { value: "pixels", label: "当前图层的像素" },
    ...(snapshot?.alpha.map((row) => ({ value: `alpha:${row.index}`, label: `通道：${row.name}` })) ?? [])
  ];

  return (
    <section className="photo-editor__advanced-group" aria-label="应用图像" data-apply-image="true">
      <span className="photo-editor__options-title">应用图像</span>
      <SourceFields label="源" form={form.source} snapshot={snapshot} onChange={(source) => update({ source })} />
      <MaskField value={form.maskChannel} onChange={(maskChannel) => update({ maskChannel })} snapshot={snapshot} />
      <BlendingFields form={form} onChange={(patch) => update(patch)} />
      <label>目标<select value={form.target} disabled={readonly} onChange={(event) => update({ target: event.currentTarget.value })}>
        {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label><input type="checkbox" checked={form.preserveTransparency} disabled={readonly} onChange={(event) => update({ preserveTransparency: event.currentTarget.checked })} />保留透明度</label>
      <div className="photo-editor__channel-actions">
        <Button size="sm" disabled={readonly} onClick={() => {
          const params = applyImageParams(form);
          const result = controller.features.channels.previewChannelCommand("image.applyImage", params, CHANNEL_VIEW_MAX_SIDE);
          if (!result.ok) {
            setPreview(null);
            setSummary(null);
            previewOwner.current = null;
            setDirtyPreview(true);
            setMessage(result.message);
            return;
          }
          setPreview(result.value.preview);
          setSummary(previewSummary(result.value.summary));
          previewOwner.current = snapshot ? { documentId: snapshot.documentId, revision: snapshot.revision } : null;
          setDirtyPreview(false);
          setMessage(null);
        }}>预览</Button>
        <Button size="sm" tone="primary" disabled={readonly || dirtyPreview || !preview} title={dirtyPreview ? "参数已改动，请重新预览" : undefined} onClick={() => {
          const result = controller.features.channels.channelCommand("image.applyImage", applyImageParams(form));
          if (!result.ok) {
            setMessage(result.message);
            return;
          }
          setMessage(null);
          setPreview(null);
          setSummary(null);
          previewOwner.current = null;
          setDirtyPreview(true);
          onChanged();
        }}>确认</Button>
        <Button size="sm" tone="ghost" disabled={!preview} onClick={() => {
          setPreview(null);
          setSummary(null);
          previewOwner.current = null;
          setDirtyPreview(true);
          setMessage(null);
        }}>取消</Button>
      </div>
      <CandidatePreview preview={preview} />
      {summary ? <p className="photo-editor__option-hint">{summary}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-channel-error="true">{message}</p> : null}
    </section>
  );
}

/** 计算：两个源 + 混合/不透明度/反相 + 蒙版 + 输出（新通道/新文档/选区）。 */
export function CalculationsPanel({ controller, readonly, revision, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [form, setForm] = useState<CalculationsForm>(() => defaultCalculationsForm(null));
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dirtyPreview, setDirtyPreview] = useState(true);
  const documentId = useRef<number | null>(null);
  const previewOwner = useRef<{ documentId: number; revision: number } | null>(null);

  useEffect(() => {
    const result = controller.features.channels.channelSnapshot();
    const decoded = result.ok ? decodeChannelSnapshot(result.value) : null;
    setSnapshot(decoded);
    if (!decoded) return;
    if (documentId.current === decoded.documentId) {
      // 预览之后这份文档又被写入：旧候选不再对应当前内容，取消确认资格。
      if (previewOwner.current !== null && previewOwner.current.revision !== decoded.revision) {
        setPreview(null);
        setSummary(null);
        setDirtyPreview(true);
      }
      return;
    }
    documentId.current = decoded.documentId;
    previewOwner.current = null;
    setForm(defaultCalculationsForm(decoded));
    setPreview(null);
    setSummary(null);
    setDirtyPreview(true);
  }, [controller, revision]);

  const update = (patch: Partial<CalculationsForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirtyPreview(true);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="计算" data-calculations="true">
      <span className="photo-editor__options-title">计算</span>
      <SourceFields label="源 1" form={form.source1} snapshot={snapshot} onChange={(source1) => update({ source1 })} />
      <SourceFields label="源 2" form={form.source2} snapshot={snapshot} onChange={(source2) => update({ source2 })} />
      <MaskField value={form.maskChannel} onChange={(maskChannel) => update({ maskChannel })} snapshot={snapshot} />
      <BlendingFields form={form} onChange={(patch) => update(patch)} />
      <label>结果<select value={form.result} disabled={readonly} onChange={(event) => update({ result: event.currentTarget.value as CalculationsForm["result"] })}>
        <option value="newChannel">新通道</option>
        <option value="newDocument">新文档</option>
        <option value="selection">选区</option>
      </select></label>
      <label>名称<input value={form.name} placeholder="Alpha" disabled={readonly} onChange={(event) => update({ name: event.currentTarget.value })} /></label>
      <div className="photo-editor__channel-actions">
        <Button size="sm" disabled={readonly} onClick={() => {
          const result = controller.features.channels.previewChannelCommand("image.calculations", calculationsParams(form), CHANNEL_VIEW_MAX_SIDE);
          if (!result.ok) {
            setPreview(null);
            setSummary(null);
            previewOwner.current = null;
            setDirtyPreview(true);
            setMessage(result.message);
            return;
          }
          setPreview(result.value.preview);
          setSummary(previewSummary(result.value.summary));
          previewOwner.current = snapshot ? { documentId: snapshot.documentId, revision: snapshot.revision } : null;
          setDirtyPreview(false);
          setMessage(null);
        }}>预览</Button>
        <Button size="sm" tone="primary" disabled={readonly || dirtyPreview || !preview} title={dirtyPreview ? "参数已改动，请重新预览" : undefined} onClick={() => {
          const result = controller.features.channels.channelCommand("image.calculations", calculationsParams(form));
          if (!result.ok) {
            setMessage(result.message);
            return;
          }
          setMessage(null);
          setPreview(null);
          setSummary(null);
          previewOwner.current = null;
          setDirtyPreview(true);
          onChanged();
        }}>确认</Button>
        <Button size="sm" tone="ghost" disabled={!preview} onClick={() => {
          setPreview(null);
          setSummary(null);
          previewOwner.current = null;
          setDirtyPreview(true);
          setMessage(null);
        }}>取消</Button>
      </div>
      <CandidatePreview preview={preview} />
      {summary ? <p className="photo-editor__option-hint">{summary}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-channel-error="true">{message}</p> : null}
    </section>
  );
}

/** 目标通道被删除后不要继续指向不存在的索引。 */
function withoutStaleTarget(form: ApplyImageForm, snapshot: ChannelSnapshot): Partial<ApplyImageForm> {
  if (!form.target.startsWith("alpha:")) return {};
  const index = Number(form.target.slice("alpha:".length));
  return snapshot.alpha.some((row) => row.index === index) ? {} : { target: "pixels" };
}
