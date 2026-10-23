/**
 * 本域面板：新建文档、文件信息、预设/最近设置与文档副本
 * （change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 分工：
 * - 面板只做表单与反馈，不持有文档/历史；
 * - 每次提交都经控制器的域会话，内核复核上限与命令门；
 * - 失败保留用户输入并显示原因；成功显示内核**实际**结果（尺寸/DPI/恢复层数）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import {
  DOCUMENT_PRESET_STORE_VERSION,
  FILE_INFO_FORMATS,
  NEW_DOCUMENT_LIMITS,
  SIZE_PRESETS,
  createLocalDocumentPresetStorage,
  describeFileInfoLoss,
  encodeDocumentPresetStore,
  parseDocumentPresetStore,
  planReopenRecent,
  reopenRecentLabel,
  validateNewDocumentSpec,
  type DocumentPresetStorage,
  type FileInfo,
  type FileInfoFormat,
  type NewDocumentSpec,
  type RecentFileEntry,
  type RecentFileStore,
  type SizePreset
} from "@woohaa3/photocraft-protocol";
import { fileInfoToForm, sameFileInfoForm } from "./model.js";
import { readClipboardImage, type ClipboardHost } from "./clipboard.js";
import { downloadBytes, projectFileName } from "./download.js";
import { exportPresetFormat, resolveExportPresetPort, type ExportPresetEntry } from "./export-bridge.js";

/**
 * 精简宿主或测试替身可能只实现部分域会话方法：缺少时**不渲染**入口，
 * 而不是在点击时抛错（与本包其它域面板的处理一致）。
 */
function sessionSupports(controller: EditorWorkspaceController, ...methods: string[]): boolean {
  const session = controller.features.files as unknown as Record<string, unknown>;
  return methods.every((method) => typeof session[method] === "function");
}

/** 设计上界都在协议里；这里只做表单默认值。 */
const DEFAULT_FORM = {
  width: "1920",
  height: "1080",
  resolution: "72",
  background: "white",
  name: ""
} as const;

/** U01：新建空白文档（宽高、分辨率、背景、尺寸预设）。 */
export function NewDocumentPanel({ controller, readonly, onCreated, disabledReason, applyRequest, onSpecChange, clipboard, onRequestDocumentSlot }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onCreated?: (report: { name: string; width: number; height: number; resolution: number }) => void;
  /** 非空时禁止新建并显示原因（例如工作区槽位已满或宿主端口缺失）。 */
  disabledReason?: string | null;
  /**
   * 外部要求填入的设置（「使用预设/最近项」）。
   *
   * 用递增 `token` 而不是直接比 `spec`：表单自己的变化也会回报 `spec`，若按值同步就会形成
   * 表单 → 上层 → 表单的回写环，用户刚输入的值会被上一次回报覆盖。
   */
  applyRequest?: { spec: NewDocumentSpec; token: number } | null;
  /** 每次表单变化后回报**已校验**的设置，供「保存为预设」使用。 */
  onSpecChange?: (spec: NewDocumentSpec | undefined) => void;
  /**
   * 剪贴板读取端口（缺省读 `navigator.clipboard`）。
   *
   * 宿主若已有受控的剪贴板读取能力，可注入自己的实现而不改面板语义；
   * 传 `null` 表示明确禁用「从剪贴板新建」以外的降级（仍会如实报告不支持）。
   */
  clipboard?: ClipboardHost | null;
  /**
   * 申请一个**独立文档槽位**：把新建的文档字节与名称交给宿主办成新标签/新文档。
   *
   * 一个编辑会话只有一个文档槽位，所以已有文档时不能在本会话里再建一份。宿主提供本端口时，
   * 新建会先在独立的候选实例上生成自包含工程字节，再由宿主用既有打开路径落地；不提供时
   * 走「当前会话为空才能建」的路径（由 `disabledReason` 明确说明）。
   */
  onRequestDocumentSlot?: (bytes: Uint8Array, name: string) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const session = controller.features.files;
  const [form, setForm] = useState<Record<keyof typeof DEFAULT_FORM, string>>({ ...DEFAULT_FORM });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = readonly || !!disabledReason;

  /** 把外部（预设/最近）传入的设置同步进表单：只覆盖设置字段，不覆盖用户填的名称。 */
  const applySpec = useCallback((next: NewDocumentSpec) => {
    setForm((current) => ({
      ...current,
      width: String(next.width),
      height: String(next.height),
      resolution: String(next.resolution),
      background: next.background
    }));
    setError(null);
    setDone(null);
  }, []);

  const applyToken = applyRequest?.token;
  const applyTarget = applyRequest?.spec;
  useEffect(() => {
    if (applyToken === undefined || !applyTarget) return;
    applySpec(applyTarget);
    // 只在真正收到新的外部请求时应用；`applyToken` 是唯一触发依据。
  }, [applyToken, applySpec]);

  /**
   * 每次表单变化都把**校验通过**的设置回报给上层。
   *
   * 非法输入回报 `undefined`：这样「保存为预设」不会保存用户最后一份旧的有效设置，
   * 也不会把非法输入当成可保存的预设。
   */
  useEffect(() => {
    if (!onSpecChange) return;
    const validated = validateNewDocumentSpec({
      width: Number(form.width),
      height: Number(form.height),
      resolution: Number(form.resolution),
      background: form.background,
      name: form.name
    });
    onSpecChange(validated.ok ? validated.value : undefined);
  }, [form, onSpecChange]);

  const patch = (key: keyof typeof DEFAULT_FORM, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    setDone(null);
  };

  const applyPreset = (preset: SizePreset) => {
    setForm((current) => ({
      ...current,
      width: String(preset.width),
      height: String(preset.height),
      // 打印预设自带 DPI；屏幕预设保留用户当前选择。
      ...(preset.resolution === undefined ? {} : { resolution: String(preset.resolution) })
    }));
    setError(null);
    setDone(null);
  };

  const submit = () => {
    if (locked || busy) return;
    const validated = validateNewDocumentSpec({
      width: Number(form.width),
      height: Number(form.height),
      resolution: Number(form.resolution),
      background: form.background,
      name: form.name
    });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setBusy(true);
    void (async () => {
      // 已有文档时不能再往本会话塞第二份（内核按「一个会话一个文档槽位」拒绝）。
      // 正确做法是把新文档建成自包含工程字节，交给宿主开成**独立标签**。
      if (onRequestDocumentSlot) {
        const produced = await session.createDocumentBytes(validated.value);
        if (!produced.ok) { setBusy(false); setError(produced.message); return; }
        const delivered = await onRequestDocumentSlot(produced.value.bytes, validated.value.name);
        setBusy(false);
        if (!delivered.ok) { setError(delivered.reason); return; }
        const report = produced.value.report;
        setDone(`已新建 ${report.width}×${report.height} px · ${report.resolution} ppi · ${report.background}，已在新文档中打开`);
        setError(null);
        onCreated?.(report);
        return;
      }
      // 冷启动：内核只在首次显式进入编辑时加载，而「新建」总是在没有文档时发起。
      // 不先加载内核的话，真实首启路径上新建永远返回「编辑器尚未加载」——按钮可点、功能不可达。
      const ready = await controller.ensureEditor();
      if (!ready.ok) { setBusy(false); setError(ready.message); return; }
      const result = session.createDocument(validated.value);
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const report = result.value;
      setDone(`已新建 ${report.width}×${report.height} px · ${report.resolution} ppi · ${report.background}`);
      setError(report.recentRecorded ? null : "文档已创建，但最近设置未能记录（仅本次会话）");
      onCreated?.(report);
    })();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="新建文档" data-files-new-document="true">
      <span className="photo-editor__options-title">新建文档</span>
      {disabledReason ? <p className="photo-editor__brush-note">{disabledReason}</p> : null}
      <label>尺寸预设
        <select disabled={locked} value="" onChange={(event) => {
          const preset = SIZE_PRESETS.find((entry) => entry.id === event.currentTarget.value);
          if (preset) applyPreset(preset);
        }}>
          <option value="">自定义…</option>
          {SIZE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <label>宽度<input type="number" min={1} max={NEW_DOCUMENT_LIMITS.maxSide} step={1} value={form.width}
        disabled={locked} onChange={(event) => patch("width", event.currentTarget.value)} />px</label>
      <label>高度<input type="number" min={1} max={NEW_DOCUMENT_LIMITS.maxSide} step={1} value={form.height}
        disabled={locked} onChange={(event) => patch("height", event.currentTarget.value)} />px</label>
      <label>分辨率<input type="number" min={NEW_DOCUMENT_LIMITS.minResolution} max={NEW_DOCUMENT_LIMITS.maxResolution} step={1} value={form.resolution}
        disabled={locked} onChange={(event) => patch("resolution", event.currentTarget.value)} />ppi</label>
      <label>背景<select value={form.background} disabled={locked} onChange={(event) => patch("background", event.currentTarget.value)}>
        <option value="white">白色</option>
        <option value="black">黑色</option>
        <option value="transparent">透明</option>
      </select></label>
      <label>名称<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={form.name} placeholder="留空为「未命名」"
        disabled={locked} onChange={(event) => patch("name", event.currentTarget.value)} /></label>
      <p className="photo-editor__brush-note">当前只支持 RGB · 8 位/通道；CMYK、Lab、灰度与高位深不在本次范围。</p>
      <Button size="sm" tone="primary" disabled={locked || busy} loading={busy} onClick={submit}>新建</Button>
      <span className="photo-editor__options-title">从图像新建</span>
      {/*
        U02：图片来源由**用户显式选择**（文件选择器），复用浏览器授予的读取权限；
        不读浏览器 File.name 当路径，也不假装能访问剪贴板历史。
      */}
      <label className="photo-editor__file-action">选择图像文件<input type="file" hidden
        accept="image/png,image/jpeg,image/webp,image/tiff,image/bmp,image/gif"
        data-files-image-source="true"
        disabled={locked || busy}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file || locked || busy) return;
          setBusy(true);
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // U02：与「新建」同一条独立槽位管线——图片只在候选实例上解码建文档，
            // 当前文档与其撤销栈不受影响。空会话时仍可退回本会话直接建立。
            if (onRequestDocumentSlot && sessionSupports(controller, "createDocumentFromImageBytes")) {
              const produced = await session.createDocumentFromImageBytes(form.name.trim() || file.name, bytes);
              if (!produced.ok) { setError(produced.message); return; }
              const delivered = await onRequestDocumentSlot(produced.value.bytes, produced.value.report.name);
              if (!delivered.ok) { setError(delivered.reason); return; }
              const report = produced.value.report;
              setError(report.warnings.length > 0 ? `已创建，但解码提示：${report.warnings.join("；")}` : null);
              setDone(`已从图像新建 ${report.width}×${report.height} px（${report.name}），已在新文档中打开`);
              onCreated?.({ name: report.name, width: report.width, height: report.height, resolution: Number(form.resolution) });
              return;
            }
            // 冷启动：与新建同因，先加载内核再建文档。
            const ready = await controller.ensureEditor();
            if (!ready.ok) { setError(ready.message); return; }
            const result = session.createDocumentFromImage(form.name.trim() || file.name, bytes);
            if (!result.ok) { setError(result.message); return; }
            const report = result.value;
            setError(null);
            setDone(`已从图像新建 ${report.width}×${report.height} px（${report.name}）`);
            if (report.warnings.length > 0) setError(`已创建，但解码提示：${report.warnings.join("；")}`);
            onCreated?.({ name: report.name, width: report.width, height: report.height, resolution: Number(form.resolution) });
          } catch (cause) {
            setError(`读取图像失败：${cause instanceof Error ? cause.message : String(cause)}`);
          } finally {
            setBusy(false);
          }
        }} /></label>
      {/*
        U02：从工作区剪贴板新建。读取失败按「不支持 / 被拒绝 / 为空 / 读不出」分别说明，
        让用户知道该换浏览器、去授权、先复制一张图，还是改用文件选择。
      */}
      <Button size="sm" tone="ghost" disabled={locked || busy} loading={busy}
        data-files-clipboard-source="true"
        onClick={async () => {
          if (locked || busy) return;
          setBusy(true);
          try {
            const picked = await readClipboardImage(clipboard ?? undefined);
            if (!picked.ok) { setError(picked.message); setDone(null); return; }
            // U02：与「从图像新建」相同，宿主提供槽位时走候选实例 + 独立标签。
            if (onRequestDocumentSlot && sessionSupports(controller, "createDocumentFromImageBytes")) {
              const produced = await session.createDocumentFromImageBytes(form.name.trim() || picked.label, picked.bytes);
              if (!produced.ok) { setError(produced.message); return; }
              const delivered = await onRequestDocumentSlot(produced.value.bytes, produced.value.report.name);
              if (!delivered.ok) { setError(delivered.reason); return; }
              const report = produced.value.report;
              setError(report.warnings.length > 0 ? `已创建，但解码提示：${report.warnings.join("；")}` : null);
              setDone(`已从剪贴板新建 ${report.width}×${report.height} px（${report.name}），已在新文档中打开`);
              onCreated?.({ name: report.name, width: report.width, height: report.height, resolution: Number(form.resolution) });
              return;
            }
            const ready = await controller.ensureEditor();
            if (!ready.ok) { setError(ready.message); return; }
            const result = session.createDocumentFromImage(form.name.trim() || picked.label, picked.bytes);
            if (!result.ok) { setError(result.message); return; }
            const report = result.value;
            setError(null);
            setDone(`已从剪贴板新建 ${report.width}×${report.height} px（${report.name}）`);
            if (report.warnings.length > 0) setError(`已创建，但解码提示：${report.warnings.join("；")}`);
            onCreated?.({ name: report.name, width: report.width, height: report.height, resolution: Number(form.resolution) });
          } finally {
            setBusy(false);
          }
        }}>从剪贴板新建</Button>
      <p className="photo-editor__brush-note">从图像新建使用图像自身的像素尺寸；分辨率沿用上方表单值。</p>
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {done ? <p className="photo-editor__brush-note" data-files-new-document-result="true">{done}</p> : null}
    </section>
  );
}

/**
 * U01+U04：新建面板与预设/最近面板共享同一个表单状态。
 *
 * 两者必须读写同一份设置：否则「保存当前设置」永远拿不到设置、「使用预设」也填不回新建表单，
 * 两个面板各自成立、连起来却不可用。这里把表单状态提升到本域组合组件，面板本身仍是无状态投影。
 */
export function NewDocumentWorkspace({ controller, readonly, disabledReason, storage, onRequestDocumentSlot, onUseExportPreset, recentIndex, recentStorageError, onReopenRecent, onRemoveRecent, hasRecentBytes, documentBusy }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  disabledReason?: string | null;
  /** 本机存储端口（缺省浏览器 `localStorage`）；预设与最近设置靠它跨会话保留。 */
  storage?: DocumentPresetStorage | null;
  /** 申请独立文档槽位（宿主实现）；有它时「已有文档」也能新建并开成新标签。 */
  onRequestDocumentSlot?: (bytes: Uint8Array, name: string) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 应用一条导出预设（转交栅格交换域，本域不解释其设置）。 */
  onUseExportPreset?: (preset: ExportPresetEntry) => void;
  /**
   * 宿主持有的最近文件索引（U04）。
   *
   * 缺省时本域**不伪造**一个空索引冒充「没有最近文件」——面板显示尚未提供该端口；
   * 提供空 `entries` 才表示「确实还没有打开过文件」。
   */
  recentIndex?: RecentFileStore | null;
  /** 索引本机持久化的诊断（宿主 `RecentFilesIndex.lastError`）；非空时在列表下方如实提示。 */
  recentStorageError?: string | null;
  /** 重开最近文件（宿主用自己的字节引用真正打开；缺省 = 字节引用不可用）。 */
  onReopenRecent?: (entry: RecentFileEntry) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 从最近记录移除一条（用户显式清理，或宿主已释放字节）。 */
  onRemoveRecent?: (id: string) => void;
  /** 逐条回答「这条记录现在还有字节可重开吗」（刷新后记录仍在、字节已不在）。 */
  hasRecentBytes?: (entry: RecentFileEntry) => boolean;
  /** 当前文档有未结算草稿或正在保存：最近文件重开前必须先结算。 */
  documentBusy?: boolean;
}) {
  const [spec, setSpec] = useState<NewDocumentSpec | undefined>(undefined);
  const [applyRequest, setApplyRequest] = useState<{ spec: NewDocumentSpec; token: number } | null>(null);
  /** 新建成功后递增，通知「最近」列表重新读取内核的真实记录。 */
  const [recentToken, setRecentToken] = useState(0);
  const apply = useCallback((next: NewDocumentSpec) => {
    setApplyRequest((current) => ({ spec: next, token: (current?.token ?? 0) + 1 }));
  }, []);
  /**
   * 新建成功后把最近设置写回本机存储。
   *
   * 内核的 `document.recent.add` 只在进程内生效；不落盘的话「最近的新建设置」关闭浏览器就没了。
   */
  const persistRecents = useCallback(async () => {
    const port = storage === undefined ? createLocalDocumentPresetStorage() : storage;
    if (!port) return;
    // 精简宿主可能只实现 `createDocument`；此时不做簿记落盘，也不报错。
    if (!sessionSupports(controller, "listDocumentPresets", "recentDocuments")) return;
    const files = controller.features.files;
    const presets = files.listDocumentPresets();
    const recents = files.recentDocuments();
    if (!presets.ok || !recents.ok) return;
    await port.save(encodeDocumentPresetStore({
      version: DOCUMENT_PRESET_STORE_VERSION,
      presets: [...presets.value],
      recent: [...recents.value]
    }));
  }, [controller, storage]);
  return (
    <>
      <NewDocumentPanel
        controller={controller}
        readonly={readonly}
        disabledReason={disabledReason}
        onSpecChange={setSpec}
        applyRequest={applyRequest}
        onRequestDocumentSlot={onRequestDocumentSlot}
        onCreated={() => {
          // 内核刚记录了一次最近设置：既落盘，也要让「最近」列表立即反映真实结果，
          // 否则新建后面板仍显示旧列表，直到重挂载才更新（用户会以为没记录）。
          setRecentToken((token) => token + 1);
          void persistRecents();
        }}
      />
      <DocumentPresetsPanel controller={controller} readonly={readonly} spec={spec} onUseSettings={apply} storage={storage} refreshToken={recentToken}
        {...(onUseExportPreset ? { onUseExportPreset } : {})} />
      {recentIndex === null ? (
        <section className="photo-editor__advanced-group" aria-label="最近文件" data-files-recent-files="unavailable">
          <span className="photo-editor__options-title">最近打开的文件</span>
          <p className="photo-editor__brush-note">宿主未提供最近文件端口：本会话不记录打开过的文件（不伪造空列表）。</p>
        </section>
      ) : recentIndex === undefined ? null : (
        <RecentFilesPanel readonly={readonly} index={recentIndex}
          {...(recentStorageError ? { storageError: recentStorageError } : {})}
          {...(onReopenRecent ? { reopen: onReopenRecent } : {})}
          {...(onRemoveRecent ? { remove: onRemoveRecent } : {})}
          {...(hasRecentBytes ? { hasBytes: hasRecentBytes } : {})}
          {...(documentBusy === undefined ? {} : { documentBusy })} />
      )}
    </>
  );
}

/** U04：File Info（已知 EXIF/XMP/版权字段 + 只读相机信息 + 格式损失提示）。 */
export function FileInfoPanel({ controller, readonly }: { controller: EditorWorkspaceController; readonly: boolean }) {
  const session = controller.features.files;
  const [form, setForm] = useState<Record<string, string>>({});
  /** 最近一次内核读取的表单快照；用于判定提交是否「无变化」。 */
  const [snapshot, setSnapshot] = useState<Record<string, string> | null>(null);
  const [camera, setCamera] = useState<FileInfo["camera"]>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** 损失预览的目标格式：工程文件永远无损，因此必须能选到导出格式才会真的报告损失。 */
  const [target, setTarget] = useState<FileInfoFormat>("pcraft");

  const load = useCallback(() => {
    const result = session.readFileInfo();
    if (!result.ok) { setError(result.message); return; }
    const info = result.value as FileInfo;
    const next = fileInfoToForm(info);
    setForm(next);
    setSnapshot(next);
    setCamera(info.camera);
    setLoaded(true);
    setError(null);
  }, [session]);

  useEffect(() => { if (sessionSupports(controller, "readFileInfo")) load(); }, [controller, load]);

  const hasInfo = Object.entries(form).some(([, value]) => value.trim().length > 0);
  const loss = describeFileInfoLoss(target, hasInfo);

  const submit = () => {
    // 与最近一次读取的字段逐项比较：内核不会为无变化的提交新增历史，
    // 界面也必须如实说「未新增历史」，而不是永远宣称写入了。
    const unchanged = snapshot !== null && sameFileInfoForm(snapshot, form);
    const result = session.writeFileInfo(form);
    if (!result.ok) { setError(result.message); setDone(null); return; }
    setError(null);
    setDone(unchanged ? "File Info 无变化，未新增历史" : "File Info 已写入（一步可撤销）");
    load();
  };

  if (!sessionSupports(controller, "readFileInfo", "writeFileInfo")) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="文件信息" data-files-file-info="true">
      <span className="photo-editor__options-title">文件信息</span>
      <label>标题<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={form.title ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, title: event.currentTarget.value })} /></label>
      <label>作者<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={form.author ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, author: event.currentTarget.value })} /></label>
      <label>作者头衔<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={form.authorTitle ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, authorTitle: event.currentTarget.value })} /></label>
      <label>说明<textarea rows={2} value={form.description ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} /></label>
      <label>关键字（分号分隔）<input value={form.keywords ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, keywords: event.currentTarget.value })} /></label>
      <label>版权<input value={form.copyright ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, copyright: event.currentTarget.value })} /></label>
      <label>版权状态<select value={form.copyrightStatus ?? "unknown"} disabled={readonly}
        onChange={(event) => setForm({ ...form, copyrightStatus: event.currentTarget.value })}>
        <option value="unknown">未知</option>
        <option value="copyrighted">受版权保护</option>
        <option value="publicDomain">公有领域</option>
      </select></label>
      <label>版权链接<input value={form.copyrightUrl ?? ""} disabled={readonly}
        onChange={(event) => setForm({ ...form, copyrightUrl: event.currentTarget.value })} /></label>
      {camera && Object.keys(camera).length > 0 ? <dl className="photo-editor__geometry-properties" data-files-camera="readonly">
        <dt>相机</dt><dd>{[camera.make, camera.model].filter(Boolean).join(" ") || "—"}</dd>
        {camera.dateTaken ? <><dt>拍摄时间</dt><dd>{camera.dateTaken}</dd></> : null}
        {camera.exposure ? <><dt>曝光</dt><dd>{camera.exposure}</dd></> : null}
        {camera.iso ? <><dt>ISO</dt><dd>{camera.iso}</dd></> : null}
        {camera.lens ? <><dt>镜头</dt><dd>{camera.lens}</dd></> : null}
      </dl> : null}
      <label>损失预览目标<select value={target} data-files-loss-target="true"
        onChange={(event) => setTarget(event.currentTarget.value as FileInfoFormat)}>
        {FILE_INFO_FORMATS.map((format) => <option key={format} value={format}>{format === "other" ? "其他格式" : format}</option>)}
      </select></label>
      <p className="photo-editor__brush-note" data-files-metadata-note="true" data-files-loss={loss.complete ? "none" : "lossy"}>
        {loss.note}。
        {loss.complete ? " 该目标会完整保留当前元数据。" : ` 本次会丢失：${loss.lost.join("、")}。`}
      </p>
      <Button size="sm" tone="primary" disabled={readonly || !loaded} onClick={submit}>写入 File Info</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={load}>重新读取</Button>
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {done ? <p className="photo-editor__brush-note" data-files-file-info-result="true">{done}</p> : null}
    </section>
  );
}

/**
 * U04：最近文件（真实字节重开或明确要求重新选择）
 * （change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 与「最近的新建设置」分开：最近**文件**指向真实内容字节，字节由宿主持有（浏览器不授予路径
 * 权限）。因此这里只渲染宿主给的索引，并把「重开」交给宿主端口：
 *
 * - 宿主仍持有字节 → 真正打开那份内容；
 * - 字节已释放 → 明确要求「用打开文件…重新选择」，**不**回退成新建空白文档；
 * - 当前文档有未结算草稿 → 拒绝并说明，不替用户丢弃内容。
 *
 * 本组件不缓存字节、不写 `.pcraft`、不改变内容指纹。
 */
export function RecentFilesPanel({ readonly, index, reopen, remove, documentBusy, hasBytes, storageError }: {
  readonly: boolean;
  /** 宿主持有的最近文件索引（只含身份与大小）。 */
  index: RecentFileStore;
  /** 重开端口；缺省时入口禁用并说明原因（宿主未提供字节引用）。 */
  reopen?: (entry: RecentFileEntry) => Promise<{ ok: true } | { ok: false; reason: string }> | { ok: true } | { ok: false; reason: string };
  remove?: (id: string) => void;
  documentBusy?: boolean;
  /**
   * 这条记录当前是否还有可用字节（宿主逐条回答）。
   *
   * 缺省用「有没有重开端口」近似。宿主必须逐条回答：浏览器刷新后记录还在、字节已经不在，
   * 此时要显示「需重新选择」，而不是让用户点一次才发现打不开。
   */
  hasBytes?: (entry: RecentFileEntry) => boolean;
  /**
   * 索引本机持久化的诊断（宿主 `RecentFilesIndex.lastError`）。
   *
   * 写失败或快照损坏时必须显示：否则列表看起来正常，刷新后记录全部消失，
   * 用户会以为「最近文件功能坏了」而不是「本机存储不可用」。
   */
  storageError?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const persistentNote = storageError
    ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-files-recent-files-storage="degraded">{storageError}</p>
    : null;
  if (index.entries.length === 0) {
    return (
      <section className="photo-editor__advanced-group" aria-label="最近文件" data-files-recent-files="empty">
        <span className="photo-editor__options-title">最近打开的文件</span>
        <p className="photo-editor__brush-note">还没有打开过的文件。打开或新建的 `.pcraft` 会出现在这里。</p>
        {persistentNote}
      </section>
    );
  }
  return (
    <section className="photo-editor__advanced-group" aria-label="最近文件" data-files-recent-files="true">
      <span className="photo-editor__options-title">最近打开的文件</span>
      <ul data-files-recent-file-list="true">
        {index.entries.map((entry) => {
          // 重开前置判定用与宿主同一份纯规则：原因逐条显示，不靠点一次才知道。
          const plan = planReopenRecent(index, entry.id, {
            hasBytes: !!reopen && (hasBytes ? hasBytes(entry) : true),
            busy: documentBusy === true || readonly
          });
          return (
            <li key={entry.id} data-files-recent-file={entry.id}>
              <span>{entry.name} — {entry.width}×{entry.height} px · {Math.round(entry.byteLength / 1024)} KB</span>
              <Button size="sm" tone="ghost" disabled={!plan.ok || busy} onClick={() => {
                if (!plan.ok || !reopen) { setError(plan.ok ? "宿主未提供最近文件重开端口" : plan.reason); return; }
                setBusy(true);
                void (async () => {
                  try {
                    const result = await reopen(entry);
                    if (!result.ok) { setError(result.reason); setDone(null); return; }
                    setError(null);
                    setDone(`已重开「${entry.name}」`);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}>{reopenRecentLabel(plan)}</Button>
              {remove ? <Button size="sm" tone="ghost" disabled={busy} onClick={() => {
                remove(entry.id);
                setDone(`已从最近文件移除「${entry.name}」`);
              }}>移除记录</Button> : null}
              {plan.ok ? null : <em className="photo-editor__brush-note" data-files-recent-reason={plan.code}>{plan.reason}</em>}
            </li>
          );
        })}
      </ul>
      <p className="photo-editor__brush-note">最近文件只记录身份与大小；内容字节由宿主持有，浏览器不授予路径权限。</p>
      {persistentNote}
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {done ? <p className="photo-editor__brush-note" data-files-recent-file-result="true">{done}</p> : null}
    </section>
  );
}

/** U04：新建预设与最近设置（最近项说明能否直接重开，并如实报告是否已持久化）。 */
export function DocumentPresetsPanel({ controller, readonly, spec, onUseSettings, storage, refreshToken, onUseExportPreset }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  /** 当前新建表单的设置；用于「保存为预设」。 */
  spec?: NewDocumentSpec;
  onUseSettings?: (spec: NewDocumentSpec) => void;
  /**
   * 本机存储端口（缺省用浏览器 `localStorage` 适配）。
   *
   * 提供时预设与最近设置跨会话保留；写入失败**不谎称已保存**，而是明确降级为「仅本次会话」。
   */
  storage?: DocumentPresetStorage | null;
  /**
   * 递增令牌：外层新建成功后用它要求这里重新读取内核的最近记录。
   *
   * 内核的 `document.recent.add` 是唯一真源；本面板若只在自己的动作里刷新，
   * 面板外的新建就不会反映到列表里（界面显示旧列表，用户以为没记录）。
   */
  refreshToken?: number;
  /**
   * 应用一条导出预设（U04）。
   *
   * 导出参数预设的实现与存储归栅格交换域；本域只把用户选择**转交**给它，
   * 不读取、不解释、也不缓存导出设置。
   */
  onUseExportPreset?: (preset: ExportPresetEntry) => void;
}) {
  const session = controller.features.files;
  const [presets, setPresets] = useState<readonly { name: string; settings: NewDocumentSpec }[]>([]);
  const [recent, setRecent] = useState<readonly NewDocumentSpec[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<"unknown" | "saved" | "session">("unknown");
  const port = useMemo(() => storage === undefined ? createLocalDocumentPresetStorage() : storage, [storage]);
  /**
   * 导出预设端口：在 io 域的既有装配点上解析（缺失即不可用）。
   *
   * 每次挂载解析一次：装配在会话生命周期内不变，重新解析只会掩盖「装错了」。
   */
  const exportPort = useMemo(() => resolveExportPresetPort(controller.features), [controller]);

  const refresh = useCallback(() => {
    const listed = session.listDocumentPresets();
    if (listed.ok) setPresets(listed.value);
    // 精简宿主可以只有预设、没有最近簿记。
    if (!sessionSupports(controller, "recentDocuments")) return;
    const recents = session.recentDocuments();
    if (recents.ok) setRecent(recents.value);
  }, [controller, session]);

  /**
   * 首次挂载把本机快照回灌内核。
   *
   * 内核只持有进程内预设列表；跨会话保留靠这份版本化快照。回灌只走 `save`，
   * 逐条校验由协议层完成（坏条目被丢弃而不是整块失败）。
   */
  useEffect(() => {
    if (!sessionSupports(controller, "listDocumentPresets")) return;
    // 先同步渲染内核当前（进程内）列表，避免首帧空白；随后再回灌本机快照。
    refresh();
    if (!port) return;
    let cancelled = false;
    void (async () => {
      const text = await port.load();
      if (cancelled) return;
      if (!text) return;
      const decoded = parseDocumentPresetStore(text);
      if (!decoded.ok) {
        // 版本不认识或 JSON 损坏：不使用缓存，但要说清原因。内核仍按空列表起步。
        setError(`本机预设存储不可用（${decoded.error}），本次仅使用会话内预设`);
        return;
      }
      for (const preset of decoded.value.presets) {
        session.saveDocumentPreset(preset.name, preset.settings);
      }
      // 最近设置同样回灌：内核只持进程内列表，跨会话保留靠同一份快照。
      if (sessionSupports(controller, "recordRecentDocument")) {
        for (const entry of decoded.value.recent) {
          session.recordRecentDocument(entry);
        }
      }
      if (!cancelled) refresh();
    })();
    return () => { cancelled = true; };
  }, [port, controller, refresh, session]);

  /**
   * 面板外的新建（新建面板自己的 `onCreated`）会往内核记录一条最近设置；
   * 这里按外层令牌重新读取，让列表反映内核真实记录而不是旧快照。
   * 首次挂载由上面的回灌 effect 负责，所以跳过 token 0。
   */
  useEffect(() => {
    if (!refreshToken) return;
    // 精简宿主可能没有预设/最近簿记：此时不应因刷新而抛错。
    if (!sessionSupports(controller, "listDocumentPresets")) return;
    refresh();
  }, [refreshToken, refresh, controller]);

  /** 把当前预设/最近写回本机存储；失败如实降级，不伪造已保存。 */
  const persist = useCallback(async (nextPresets: readonly { name: string; settings: NewDocumentSpec }[], nextRecent: readonly NewDocumentSpec[]) => {
    if (!port) { setPersistence("session"); return; }
    const text = encodeDocumentPresetStore({
      version: DOCUMENT_PRESET_STORE_VERSION,
      presets: [...nextPresets],
      recent: [...nextRecent]
    });
    setPersistence(await port.save(text) === "saved" ? "saved" : "session");
  }, [port]);

  const save = () => {
    if (!spec) { setError("先在「新建文档」里设置尺寸，再保存为预设"); return; }
    const result = session.saveDocumentPreset(name, spec);
    if (!result.ok) { setError(result.message); setDone(null); return; }
    setPresets(result.value);
    setName("");
    setError(null);
    setDone("预设已保存");
    void persist(result.value, recent);
  };

  if (!sessionSupports(controller, "listDocumentPresets", "saveDocumentPreset", "deleteDocumentPreset")) return null;
  const describe = (settings: NewDocumentSpec) => `${settings.width}×${settings.height} px · ${settings.resolution} ppi · ${settings.background}`;
  return (
    <section className="photo-editor__advanced-group" aria-label="新建预设" data-files-presets="true">
      <span className="photo-editor__options-title">新建预设与最近</span>
      <label>预设名<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={name} placeholder="例如 方形海报"
        disabled={readonly} onChange={(event) => { setName(event.currentTarget.value); setError(null); }} /></label>
      <Button size="sm" disabled={readonly} onClick={save}>保存当前设置</Button>
      {presets.length === 0 ? <p className="photo-editor__brush-note">还没有保存的新建预设。</p> : (
        <ul data-files-preset-list="true">
          {presets.map((preset) => <li key={preset.name}>
            <span>{preset.name} — {describe(preset.settings)}</span>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => onUseSettings?.(preset.settings)}>使用</Button>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
              const removed = session.deleteDocumentPreset(preset.name);
              if (!removed.ok) { setError(removed.message); return; }
              setPresets(removed.value);
              setDone(`已删除预设「${preset.name}」`);
              void persist(removed.value, recent);
            }}>删除</Button>
          </li>)}
        </ul>
      )}
      <span className="photo-editor__options-title">最近的新建设置</span>
      {recent.length === 0 ? <p className="photo-editor__brush-note">还没有最近的新建记录。</p> : (
        <ul data-files-recent-list="true">
          {recent.map((settings, index) => <li key={`${settings.width}x${settings.height}-${index}`}>
            <span>{describe(settings)}</span>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => onUseSettings?.(settings)}>填入表单</Button>
          </li>)}
        </ul>
      )}
      <p className="photo-editor__brush-note" data-files-persistence={persistence}>
        {persistence === "saved" ? "预设与最近设置已保存在本机，下次打开仍可用。"
          : persistence === "session" ? "本机存储不可用：预设只在本次会话保留，关闭后不会保存。"
          : "预设保存在本机；最近项只保存新建设置。"}
      </p>
      {/*
        U04：导出参数预设由栅格交换域唯一持有（change: 2026-10-22-add-photocraft-raster-interchange）。
        本域只消费入口：列出提供方给的预设并跳到导出面板；提供方缺失时如实禁用，
        不在这里自造一套导出设置（那会成为第二份导出规则）。
      */}
      <span className="photo-editor__options-title">导出预设</span>
      {exportPort.available ? (
        (() => {
          const listed = exportPort.list();
          if (!listed.ok) return <p className="photo-editor__brush-note photo-editor__brush-note--error" data-files-export-presets="error">{listed.reason}</p>;
          if (listed.presets.length === 0) return <p className="photo-editor__brush-note" data-files-export-presets="empty">导出域还没有可用预设。</p>;
          return (
            <ul data-files-export-presets="ready">
              {listed.presets.map((preset) => {
                const format = exportPresetFormat(preset.settings);
                return <li key={preset.name}>
                  <span>{preset.name}{format ? ` — ${format}` : ""}</span>
                  <Button size="sm" tone="ghost" disabled={readonly} data-files-export-preset={preset.name}
                    onClick={() => onUseExportPreset?.(preset)}>去导出…</Button>
                </li>;
              })}
            </ul>
          );
        })()
      ) : <p className="photo-editor__brush-note" data-files-export-presets="unavailable">{exportPort.reason}</p>}
      <p className="photo-editor__brush-note">最近项只保存新建设置，可直接重新填入；已打开过的**文件**需要重新选择字节（浏览器不授予路径权限）。</p>
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {done ? <p className="photo-editor__brush-note" data-files-presets-result="true">{done}</p> : null}
    </section>
  );
}

/** U02/U03：文档副本与保存基线恢复（不伪造写盘，不冒称磁盘最新版本）。 */
export function DocumentCopyPanel({ controller, readonly, baseline, onDuplicate }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  /** 工作区持有的保存基线；缺省表示尚无可恢复来源。 */
  baseline?: { bytes: Uint8Array; baseAssetId?: string; label: string } | null;
  onDuplicate?: (bytes: Uint8Array) => void;
}) {
  const session = controller.features.files;
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [name, setName] = useState("");
  /**
   * 用户重新选择的工程字节（design「源已不可取得时要求重新选择并核对来源」）。
   *
   * 没有它的话「恢复到上次保存」在真实界面里**永远禁用**：`sections.tsx` 不传 `baseline`，
   * 而宿主也没有把「上次成功保存的工程字节」交进来的端口——按钮存在、功能不可达。
   */
  const [chosen, setChosen] = useState<{ bytes: Uint8Array; label: string } | null>(null);
  const source = baseline ?? chosen;
  const baselineLabel = source?.label ?? null;

  const duplicate = () => {
    const result = session.duplicateDocument(name);
    if (!result.ok) { setError(result.message); setDone(null); return; }
    setError(null);
    // 副本字节必须真的交到用户手里：`onDuplicate` 在真实装配里没有提供者，只调用它
    // 会让「复制整份文档」生成字节却无处可去（按钮可用、结果不可达）。这里按同包既有
    // 的本地下载约定直接交付，同时仍把字节交给可选的宿主回调。
    const delivered = downloadBytes(result.value, projectFileName(name));
    onDuplicate?.(result.value);
    // 交付失败不能报「已生成副本字节」就完事：那会让用户以为拿到了文件。
    if (!delivered.ok) {
      setError(`副本已生成（${result.value.length} 字节）但未能交付：${delivered.reason}`);
      setDone(null);
      return;
    }
    setDone(`已生成副本字节（${result.value.length} 字节）；原文档的未保存状态不变`);
  };

  const restore = () => {
    if (!source) { setError("没有可恢复的保存基线，请先保存或重新选择工程文件"); return; }
    const result = session.restoreSavedBaseline(source.bytes, baseline?.baseAssetId ?? "");
    if (!result.ok) { setError(result.message); setDone(null); return; }
    setError(null);
    setDone("已恢复到上次保存基线（可用撤销还原）");
  };

  if (!sessionSupports(controller, "duplicateDocument")) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="文档副本与恢复" data-files-copy="true">
      <span className="photo-editor__options-title">文档副本与恢复</span>
      <label>副本名称<input maxLength={NEW_DOCUMENT_LIMITS.maxNameChars} value={name} placeholder="留空为「… 副本」"
        disabled={readonly} onChange={(event) => { setName(event.currentTarget.value); setError(null); }} /></label>
      <Button size="sm" disabled={readonly} onClick={duplicate}>复制整份文档</Button>
      <p className="photo-editor__brush-note">副本是自包含工程字节：修改副本不影响原文，也不会清除原文档的未保存标记。</p>
      <p className="photo-editor__brush-note" data-files-baseline={baselineLabel ? "available" : "missing"}>
        {baselineLabel
          ? `保存基线：${baselineLabel}`
          : "尚无可恢复的保存基线：本机浏览器不提供原生命令读写磁盘，请重新选择工程文件"}
      </p>
      {/*
        U03：重新选择基线来源。选择器只把用户显式授予的字节交进来，不把 `File.name`
        当成路径权限，也不冒称能读到磁盘上的最新版本。
      */}
      <label className="photo-editor__file-action">重新选择工程文件<input type="file" hidden
        accept=".pcraft,application/zip"
        data-files-baseline-source="true"
        disabled={readonly}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file || readonly) return;
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length === 0) { setError("所选工程文件为空，请重新选择"); return; }
            setChosen({ bytes, label: file.name });
            setError(null);
            setDone(`已选择基线来源「${file.name}」（${bytes.length} 字节），确认后恢复`);
          } catch (cause) {
            setError(`读取工程文件失败：${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }} /></label>
      <Button size="sm" tone="ghost" disabled={readonly || !source} onClick={restore}>恢复到上次保存</Button>
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {done ? <p className="photo-editor__brush-note" data-files-copy-result="true">{done}</p> : null}
    </section>
  );
}
