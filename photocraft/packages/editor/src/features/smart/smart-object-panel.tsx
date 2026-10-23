import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { createSession } from "./workspace.js";
import {
  FALLBACK_SOURCE_NAME,
  decodeSmartLayerState,
  isDeliverableSourceName,
  type SmartLayerState
} from "./layer-state.js";

/**
 * 本域的父层入口（域会话方法）。
 *
 * 声明成可选：精简宿主或测试替身可能只装配了部分域会话，此时入口不可用而不是抛错。
 */
type SmartApi = Partial<ReturnType<typeof createSession>>;

/**
 * 读取选中层的可用性投影。
 *
 * 只读调用，每次渲染重新取即可；内核是可用性与原因的唯一来源。
 */
function readState(api: SmartApi | undefined, layer: number | null): { state: SmartLayerState | null; message: string | null } {
  if (layer === null || typeof api?.smartLayerState !== "function") return { state: null, message: null };
  const result = api.smartLayerState(layer);
  // 未就绪/无文档不是用户操作失败，不在面板里显示错误。
  if (!result.ok) return { state: null, message: result.code === "no-document" ? null : result.message };
  const state = decodeSmartLayerState(result.value);
  return { state, message: state ? null : "智能对象状态无效，请重新选择图层" };
}

/** 导出下载：文件名不可交付时退回固定名，绝不写出路径。 */
function downloadSource(name: string, bytes: Uint8Array): void {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = isDeliverableSourceName(name) ? name : FALLBACK_SOURCE_NAME;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 智能对象面板（U65/U66）。
 *
 * - 替换源/导出源/编辑内容/转回图层都按**选中层自己的源**决定，不要求已打开子文档；
 * - 每个不可用入口都给出内核原因，不做静默禁用；
 * - 转回图层先确认，再一次提交（一步历史，其他共享实例不变）。
 */
export function SmartObjectPanel({ controller, readonly, layer, revision, onChanged }: {
  controller: EditorWorkspaceController; readonly: boolean; layer: number | null; revision: number; onChanged?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // 读文件是异步的：确认落点时以最新选中层为准，避免把旧文件写进换选后的另一层。
  const latestLayer = useRef(layer);
  useEffect(() => { latestLayer.current = layer; }, [layer]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 确认态绑定到发起确认的图层：换选图层后必须重新确认，不能把旧确认用到新层上。
  const [confirming, setConfirming] = useState<number | null>(null);
  const api = controller.features?.smart;
  const childResult = controller.smartChildState?.();
  const child = childResult?.ok ? childResult.value as { active?: boolean; invalidated?: string | null } : {};
  const { state, message: stateMessage } = readState(api, layer);
  const smart = state?.smart === true;
  const selected = layer !== null;
  const childOpen = state?.childOpen === true || child.active === true;
  // 确认框既绑定图层，也要求该入口**此刻仍然可用**：父文档关闭、图层被锁或子文档
  // 被打开后，旧确认必须自动收起，不能带着过期状态提交。
  const canConvert = state?.canConvertToLayers === true;
  const confirmingLayer = layer !== null && confirming === layer && canConvert;

  const run = (result: { ok: boolean; message?: string }) => {
    setMessage(result.ok ? null : result.message ?? "智能对象操作失败");
    if (result.ok) onChanged?.();
    return result.ok;
  };
  const exportSource = () => {
    const exportSmartSource = api?.exportSmartSource;
    if (!exportSmartSource || layer === null) return;
    const result = exportSmartSource(layer);
    if (!result.ok) { setMessage(result.message); return; }
    downloadSource(result.value.name, result.value.bytes);
    setMessage(null);
  };
  const convert = () => {
    const convertSmartToLayers = api?.convertSmartToLayers;
    if (!convertSmartToLayers || layer === null) return;
    setBusy("convert");
    try {
      run(convertSmartToLayers(layer));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };
  const replace = async (file: File) => {
    const target = layer;
    if (target === null) return;
    setBusy("replace");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 等待读文件期间可能换选图层或图表层已消失：此时不再写入，宁可丢弃这次选择。
      if (latestLayer.current !== target) {
        setMessage("选中图层已变化，本次替换已取消");
        return;
      }
      run(controller.replaceSmartContents(target, bytes));
    } finally {
      setBusy(null);
    }
  };

  return <section className="photo-editor__advanced-group" data-smart-object-panel={revision}
    data-smart-layer={layer ?? ""} data-smart-state={smart ? "smart" : selected ? "plain" : "none"}>
    <span className="photo-editor__options-title">智能对象</span>
    {state?.source ? <span className="photo-editor__option-hint" data-smart-source={state.source.kind}>
      {state.source.kind === "embedded"
        ? `嵌入源 ${state.source.fileName}（${state.source.bytes} 字节）`
        : `外链源 ${state.source.fileName}（NON_GOALS）`}
    </span> : null}
    <Button size="sm" disabled={readonly || !selected || smart || childOpen}
      onClick={() => run(controller.convertToSmartObject(layer === null ? [] : [layer]))}>转换为智能对象</Button>
    <Button size="sm" disabled={readonly || !smart || childOpen}
      onClick={() => run(controller.duplicateSmartObject(layer === null ? [] : [layer], false))}>复制实例</Button>
    <Button size="sm" disabled={readonly || !smart || childOpen}
      onClick={() => run(controller.duplicateSmartObject(layer === null ? [] : [layer], true))}>通过拷贝新建</Button>
    <Button size="sm" disabled={readonly || !smart || childOpen}
      onClick={() => run(controller.rasterizeSmartObject(layer!))}>栅格化</Button>

    <Button size="sm" disabled={readonly || !state?.canEditContents || childOpen}
      title={state?.canEditContents === false ? state.editReason : undefined}
      onClick={() => run(controller.beginSmartChild(layer!))}>编辑内容</Button>

    {/* 替换/导出只看选中层的源：未打开子文档也必须可用。 */}
    <span className="photo-editor__file-action"
      data-smart-entry="replace" data-smart-replaceable={state?.canReplace === true ? "true" : "false"}
      title={state?.canReplace === false ? state.replaceReason : undefined}>
      <Button size="sm" disabled={readonly || !state?.canReplace || busy !== null}
        loading={busy === "replace"}
        onClick={() => input.current?.click()}>替换源</Button>
      <input ref={input} type="file" accept=".pcraft,application/octet-stream" hidden
        data-smart-entry="replace-input"
        onChange={async event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) await replace(file);
        }} />
    </span>
    <Button size="sm" tone="ghost" data-smart-entry="export"
      disabled={!state?.canExport}
      title={state?.canExport === false ? state.exportReason : undefined}
      onClick={exportSource}>导出源</Button>

    {confirmingLayer ? <span className="photo-editor__options-group" data-smart-convert-confirm="true">
      <span className="photo-editor__option-hint">解包嵌入源为可编辑图层（一步撤销），其他共享实例保持不变。</span>
      <Button size="sm" loading={busy === "convert"} disabled={readonly} onClick={convert}>确认转回</Button>
      <Button size="sm" tone="ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>取消</Button>
    </span> : <Button size="sm" tone="ghost" data-smart-entry="convert"
      disabled={readonly || !state?.canConvertToLayers || busy !== null}
      title={state?.canConvertToLayers === false ? state.convertReason : undefined}
      onClick={() => setConfirming(layer)}>转回图层</Button>}

    {child.active ? <>
      <Button size="sm" disabled={readonly} onClick={() => run(controller.updateSmartParentFromChild?.(`ui-${revision}`) ?? (() => { const exported = controller.exportSmartChild(); return exported.ok ? controller.updateSmartParent(`ui-${revision}`, exported.value) : exported; })())}>更新父文档</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run(controller.reloadSmartChild())}>重载父源</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
        const result = controller.exportSmartChild();
        if (result.ok) { downloadSource("photocraft-smart-child.pcraft", result.value); setMessage(null); } else setMessage(result.message);
      }}>导出子工程</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run(controller.detachSmartChild())}>建立独立副本</Button>
      <Button size="sm" tone="ghost" onClick={() => { controller.closeSmartChild(); onChanged?.(); }}>关闭子文档</Button>
    </> : null}

    {state && state.reason ? <p className="photo-editor__option-hint" data-smart-entry="reason">{state.reason}</p> : null}
    {stateMessage ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{stateMessage}</p> : null}
    {child.invalidated ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{child.invalidated}</p> : null}
    {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
  </section>;
}
