/**
 * 栅格交换面板（change: 2026-10-22-add-photocraft-raster-interchange，U05/U06/U07）。
 *
 * 一块面板串起三组能力，全部走本域会话（`controller.features.io`）：
 * - **格式矩阵**：真实构建的读写/位深/打开准入与暂缓原因（U05）；
 * - **导出 / Save for Web**：格式、质量、压缩、尺寸、透明、元数据、真实编码预览、预设与交付（U06）；
 * - **逐层与资产**：计划（含改写与失败项）、逐层包、单层 Export As、按名称资产包（U07）。
 *
 * 不使用菜单占位：每个按钮都真实调用内核，并把内核报告里的失败项显示出来。预览用的对象 URL
 * 在替换/卸载时释放；面板不做后台任务，也不写磁盘（交付 = 下载或宿主端口）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  INTERCHANGE_BUDGETS,
  type ExportSettings
} from "@woohaa3/photocraft-protocol";
import { ExportPresetStore } from "./export-presets.js";
import { previewObjectUrl, startDownload } from "./delivery.js";
import { currentInterchangeRequest, subscribeInterchange } from "./menu-request.js";
import { isRecord } from "../shared/panels.js";

/** 本域会话端口（`controller.features.io`）。组件只依赖这些方法。 */
type InterchangePort = {
  matrix(): { ok: boolean; value?: unknown; message?: string };
  exportOptions(): { ok: boolean; value?: unknown; message?: string };
  inspectOpenRaster(bytes: Uint8Array): { ok: boolean; value?: unknown; message?: string };
  inspectExport?(settings: unknown): { ok: boolean; value?: unknown; message?: string };
  previewExport(settings: unknown): { ok: boolean; value?: InterchangeDelivery; message?: string };
  exportRaster(settings: unknown): { ok: boolean; value?: InterchangeDelivery; message?: string };
  inspectLayerExport(params: unknown): { ok: boolean; value?: unknown; message?: string };
  exportLayerBundle(params: unknown): { ok: boolean; value?: InterchangeDelivery; message?: string };
  exportLayerAs(params: unknown): { ok: boolean; value?: InterchangeDelivery; message?: string };
  inspectImageAssets(): { ok: boolean; value?: unknown; message?: string };
  exportImageAssets(): { ok: boolean; value?: InterchangeDelivery; message?: string };
};

type InterchangeDelivery = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  report?: Record<string, unknown>;
};

/**
 * 取本域会话端口。
 *
 * `required` 是本场景真正会用到的那个方法：导出面板要求完整导出入口，打开预检只要求
 * `inspectOpenRaster`。用「所有方法都在」当门槛会把只跑预检的调用方误判成不支持。
 */
const port = (controller: EditorWorkspaceController, required: keyof InterchangePort = "exportRaster"): InterchangePort | null => {
  const features = (controller as unknown as { features?: { io?: unknown } }).features;
  const io = features?.io as InterchangePort | undefined;
  return io && typeof io[required] === "function" ? io : null;
};

/**
 * 矩阵行（U05 的权威表）。
 *
 * 读写、位深/布局、metadata 与 feature 标志全部来自内核真实能力；界面不再只挑几项显示，
 * 否则「矩阵里没写」会被误读成「这个格式不支持」。
 */
type MatrixRow = {
  id: string;
  name: string;
  extensions: readonly string[];
  mime: string;
  read: boolean;
  write: boolean;
  depths: readonly string[];
  layouts: readonly string[];
  alpha: boolean;
  icc: boolean;
  exif: boolean;
  xmp: boolean;
  dpi: boolean;
  text: boolean;
  animation: boolean;
  lossy: boolean;
  status: string;
  reason: string | null;
  exportable: boolean;
};

function matrixRows(value: unknown): MatrixRow[] {
  if (!isRecord(value) || !Array.isArray(value.formats)) return [];
  return value.formats.flatMap((row): MatrixRow[] => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return [];
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return [{
      id: row.id,
      name: row.name,
      extensions: strings(row.extensions),
      mime: typeof row.mime === "string" ? row.mime : "",
      read: row.read === true,
      write: row.write === true,
      depths: strings(row.depths),
      layouts: strings(row.layouts),
      alpha: row.alpha === true,
      icc: row.icc === true,
      exif: row.exif === true,
      xmp: row.xmp === true,
      dpi: row.dpi === true,
      text: row.text === true,
      animation: row.animation === true,
      lossy: row.lossy === true,
      status: typeof row.status === "string" ? row.status : "deferred",
      reason: typeof row.reason === "string" ? row.reason : null,
      exportable: row.exportable === true
    }];
  });
}

const STATUS_LABEL: Record<string, string> = { open: "可编辑打开", "read-only": "只读打开", deferred: "暂缓" };

/** 矩阵行的 metadata / feature 标志（内核真实能力，不是前端常量）。 */
function matrixFlags(row: MatrixRow): string {
  return [
    row.icc ? "ICC" : "",
    row.exif ? "EXIF" : "",
    row.xmp ? "XMP" : "",
    row.dpi ? "DPI" : "",
    row.text ? "文本" : "",
    row.animation ? "动画" : "",
    row.lossy ? "有损" : ""
  ].filter(Boolean).join("/");
}

/**
 * 「换没换文档」的身份：活动标签 + 名字 + 尺寸。
 *
 * 内核的 `revision` 在新文档上会重置，单看它会漏掉「换了文档但修订号相同」的情况；
 * 而名字与尺寸在换文档时几乎必变。两者都进指纹，宁可多判一次切换。
 */
function documentSwitchKey(controller: EditorWorkspaceController): string {
  const view = controller.currentView();
  const document = view.document;
  if (!document) return `none:${String(view.sessionActiveIndex)}`;
  return [String(view.sessionActiveIndex), document.name, `${document.width}x${document.height}`].join("|");
}

/**
 * 「当前快照还对不对得上」的身份：在上面的基础上加修订号与所选层。
 *
 * 预览、逐层计划、资产计划和目标尺寸都是**某一份文档某一时刻**的快照。编辑内容或改变所选层
 * 之后，旧清单就不再描述当前输入：继续显示等于让用户拿上一份清单确认这一份，
 * 而「打包下载」用的是当前文档——界面与实际交付会对不上。
 */
function documentSnapshotKey(controller: EditorWorkspaceController): string {
  const view = controller.currentView();
  const document = view.document;
  if (!document) return documentSwitchKey(controller);
  return [
    documentSwitchKey(controller),
    document.revision,
    [...document.selectedLayerIds].sort((a, b) => a - b).join(",")
  ].join("|");
}

/** 同步的当前选择 → 逐层参数。 */
function layerParams(controller: EditorWorkspaceController, format: string): Record<string, unknown> {
  const document = controller.currentView().document;
  const selected = document?.selectedLayerIds ?? [];
  return selected.length > 0 ? { format, layers: [...selected] } : { format };
}

export function InterchangePanel({ controller, readonly }: { controller: EditorWorkspaceController; readonly: boolean }) {
  const io = port(controller);
  const [tab, setTab] = useState<"matrix" | "export" | "layers">("export");
  const [mode, setMode] = useState<"export" | "web">("export");
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<MatrixRow[]>([]);
  const [exportable, setExportable] = useState<string[]>([]);
  /** 每个可写格式真实支持的参数（来自内核 `exportMatrix`，不在这里复制规则）。 */
  const [formatOptions, setFormatOptions] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; bytes: number; lossy: boolean; warnings: string[] } | null>(null);
  const [layerPlan, setLayerPlan] = useState<Record<string, unknown> | null>(null);
  const [assetPlan, setAssetPlan] = useState<Record<string, unknown> | null>(null);
  const presets = useMemo(() => new ExportPresetStore(), []);
  const [, bumpPresets] = useState(0);
  const previewUrl = useRef<string | null>(null);
  const [presetName, setPresetName] = useState("");
  /** 逐层/单层交付的格式（与通用导出同一份可写格式列表）。 */
  const [layerFormat, setLayerFormat] = useState<string>("png");
  /** 内核预检给出的目标尺寸（不编码）；设置非法时为空。 */
  const [target, setTarget] = useState<{ width: number; height: number } | null>(null);
  /** 已应用过的菜单意图序号（同一请求只应用一次）。 */
  const appliedRequest = useRef(0);
  /** 当前文档：`switchKey` 变了是换了文档，`docKey` 变了是内容/选择变了。 */
  const [switchKey, setSwitchKey] = useState(() => documentSwitchKey(controller));
  const [docKey, setDocKey] = useState(() => documentSnapshotKey(controller));

  useEffect(() => {
    const nextSwitch = documentSwitchKey(controller);
    const nextSnapshot = documentSnapshotKey(controller);
    setSwitchKey((current) => (current === nextSwitch ? current : nextSwitch));
    setDocKey((current) => (current === nextSnapshot ? current : nextSnapshot));
  });

  // 内容或选择一变，预览与两张计划就描述不了当前文档了：留着等于让用户拿上一份清单
  // 去确认这一份，而「打包下载」用的是当前文档——界面清单与实际交付会对不上。
  useEffect(() => {
    // 预览持有 blob URL，必须一并释放，否则每改一次就漏一张图。
    if (previewUrl.current) {
      URL.revokeObjectURL?.(previewUrl.current);
      previewUrl.current = null;
    }
    setPreview(null);
    setLayerPlan(null);
    setAssetPlan(null);
    // 只在快照失效时清理；`previewUrl` 是 ref，不参与依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // 换文档还会让目标尺寸与上一条提示失去意义：前者按旧画布算的，后者解释的是旧产物。
  useEffect(() => {
    setTarget(null);
    setMessage(null);
  }, [switchKey]);

  // 菜单意图（文件 ▸ 导出为… / Save for Web…）：打开面板时落在对应页签与模式上。
  // 记住已应用的 nonce，避免之后的渲染把用户手动切换的页签覆盖回菜单里的值。
  useEffect(() => {
    const apply = () => {
      const request = currentInterchangeRequest();
      if (!request || request.nonce <= appliedRequest.current) return;
      appliedRequest.current = request.nonce;
      setTab(request.tab);
      setMessage(null);
      if (request.mode) {
        setMode(request.mode);
        setSettings(request.settings ?? (request.mode === "web" ? DEFAULT_WEB_SETTINGS : DEFAULT_EXPORT_SETTINGS));
        clearPreview();
      }
    };
    apply();
    return subscribeInterchange(apply);
    // `clearPreview` 只读 ref 并 setState，整个订阅只装一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时释放预览 URL（避免把 blob 生命周期绑到内核）。
  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL?.(previewUrl.current); }, []);

  // 首次进入拉一次真实矩阵（构建能力，不是前端常量）。
  useEffect(() => {
    if (!io) return;
    const formats = io.matrix();
    if (formats.ok) setMatrix(matrixRows(formats.value));
    // 矩阵读不到时必须说出来：否则用户会以为「没有可选格式」而不是「内核不匹配」。
    else setMessage(formats.message ?? "无法读取格式矩阵");
    const options = io.exportOptions();
    if (options.ok && isRecord(options.value) && Array.isArray(options.value.formatRows)) {
      setExportable(options.value.formatRows.filter((row): row is string => typeof row === "string"));
    } else if (options.ok && Array.isArray(options.value)) {
      const rows = options.value.filter(isRecord);
      setExportable(rows.flatMap((row) => (typeof row.format === "string" ? [row.format] : [])));
      // 「这个格式有哪些参数」由内核矩阵决定：界面只显示真正能编码的选项，
      // 不复制一份会与内核漂移的格式规则表。
      const table: Record<string, string[]> = {};
      for (const row of rows) {
        if (typeof row.format !== "string" || !Array.isArray(row.options)) continue;
        table[row.format] = row.options.filter((option): option is string => typeof option === "string");
      }
      setFormatOptions(table);
    }
  }, [io]);

  // 设置一变就用内核预检问一次目标尺寸：不在界面里复制格式/尺寸规则，也避免用户等到
  // 点「导出」才发现参数不可用。预检不编码，成本与一次解析相当。
  useEffect(() => {
    if (!io || tab !== "export" || typeof io.inspectExport !== "function") return;
    const result = io.inspectExport(settings);
    if (result.ok && isRecord(result.value) && typeof result.value.width === "number" && typeof result.value.height === "number") {
      setTarget({ width: result.value.width, height: result.value.height });
    } else {
      setTarget(null);
    }
  }, [io, settings, tab]);

  if (!io) return null;

  /**
   * 丢弃当前预览。
   *
   * 设置一旦改变，屏幕上那张图就不再对应这组设置；继续显示等于让用户拿旧候选去确认新参数。
   */
  /** 当前格式在内核里是否支持某个参数（未知格式时保守显示，交给内核给出真实拒绝原因）。 */
  const supports = (option: string): boolean => {
    const options = formatOptions[String(settings.format)];
    if (!options || options.length === 0) return true;
    return options.includes(option);
  };

  const clearPreview = () => {
    if (previewUrl.current) {
      URL.revokeObjectURL?.(previewUrl.current);
      previewUrl.current = null;
    }
    setPreview(null);
  };

  /** 所有设置改动都走这里：改参数即失效旧预览。 */
  const patchSettings = (patch: Partial<ExportSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    clearPreview();
  };

  const applyPreset = (name: string) => {
    const preset = presets.find(name);
    if (!preset) return;
    setMode(preset.mode);
    setSettings(preset);
    clearPreview();
    setMessage(null);
  };

  const previewNow = () => {
    const result = io.previewExport(settings);
    if (!result.ok || !result.value) {
      // 失败时不能把上一次成功的图留在界面上，否则看起来像这组设置也能用。
      clearPreview();
      setMessage(result.message ?? "预览失败");
      return;
    }
    const report = result.value.report ?? {};
    if (previewUrl.current) URL.revokeObjectURL?.(previewUrl.current);
    const url = previewObjectUrl(result.value.bytes, result.value.contentType);
    previewUrl.current = url;
    setPreview(url ? {
      url,
      width: Number(report.width ?? 0),
      height: Number(report.height ?? 0),
      bytes: Number(report.bytes ?? result.value.bytes.length),
      lossy: report.lossy === true,
      // 内核会把真实能力损失写进 warnings（例如 GIF 量化、DPI 被丢弃）：
      // 用户在确认前必须看得到，否则「预览成功」会掩盖掉不可逆损失。
      warnings: Array.isArray(report.warnings)
        ? report.warnings.filter((warning): warning is string => typeof warning === "string")
        : []
    } : null);
    setMessage(url ? null : "预览已编码，但当前环境无法显示（缺少对象 URL 支持）");
  };

  const deliver = (result: { ok: boolean; value?: InterchangeDelivery; message?: string }) => {
    if (!result.ok || !result.value) {
      setMessage(result.message ?? "交付失败");
      return;
    }
    const outcome = startDownload(result.value);
    if (!outcome.ok) {
      setMessage(outcome.message);
      return;
    }
    const warnings = (result.value.report?.warnings ?? []) as unknown;
    const lost = Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : [];
    // 能力损失必须随交付一起说出来，不能让「下载已发起」把量化/丢 DPI 盖过去。
    setMessage(`已发起下载：${outcome.fileName}（${outcome.bytes} 字节）。下载不等于已保存工程。${lost.length > 0 ? `损失提示：${lost.join("；")}` : ""}`);
  };

  const planLayers = () => {
    const result = io.inspectLayerExport(layerParams(controller, layerFormat));
    if (!result.ok || !isRecord(result.value)) {
      setLayerPlan(null);
      setMessage(result.message ?? "无法生成逐层计划");
      return;
    }
    setLayerPlan(result.value);
    setMessage(null);
  };

  const planAssets = () => {
    const result = io.inspectImageAssets();
    if (!result.ok || !isRecord(result.value)) {
      setAssetPlan(null);
      setMessage(result.message ?? "没有按资产语法命名的图层");
      return;
    }
    setAssetPlan(result.value);
    setMessage(null);
  };

  /** 计划里被拒绝的目标（超预算/目标层失效）：必须能和成功项一起被看到。 */
  const rejected = (report: Record<string, unknown> | null): { label: string; reason: string }[] => {
    if (!report || !Array.isArray(report.rejected)) return [];
    return report.rejected.flatMap((item) => {
      if (!isRecord(item)) return [];
      const label = typeof item.fileName === "string"
        ? item.fileName
        : typeof item.name === "string"
          ? item.name
          : typeof item.layerId === "number" ? `图层 ${item.layerId}` : "目标";
      return [{ label, reason: typeof item.reason === "string" ? item.reason : "被拒绝" }];
    });
  };

  /** 命名改写（重名/非法字符/保留名）：报告能解释文件名为什么变了。 */
  const renames = (report: Record<string, unknown> | null): { original: string; delivered: string; reason: string }[] => {
    if (!report || !Array.isArray(report.renames)) return [];
    return report.renames.flatMap((item) => {
      if (!isRecord(item) || typeof item.delivered !== "string") return [];
      return [{
        original: typeof item.original === "string" ? item.original : "",
        delivered: item.delivered,
        reason: typeof item.reason === "string" ? item.reason : ""
      }];
    });
  };

  const failures = (report: Record<string, unknown> | null): { fileName?: string; error?: string }[] => {
    if (!report || !Array.isArray(report.files)) return [];
    return report.files.flatMap((file) => {
      if (!isRecord(file) || file.ok !== false) return [];
      return [{ fileName: typeof file.fileName === "string" ? file.fileName : undefined, error: typeof file.error === "string" ? file.error : "失败" }];
    });
  };

  const layerReport = isRecord(layerPlan) ? layerPlan : null;
  const assetReport = isRecord(assetPlan) ? assetPlan : null;

  return (
    <section className="photo-editor__advanced-group" aria-label="格式与导出" data-interchange-panel="true">
      <span className="photo-editor__options-title">格式与导出</span>
      <div role="tablist" className="photo-editor__io-tabs">
        {(["export", "layers", "matrix"] as const).map((id) => (
          <Button key={id} size="sm" tone={tab === id ? "primary" : "ghost"} onClick={() => { setTab(id); setMessage(null); }}>
            {id === "export" ? "导出" : id === "layers" ? "逐层与资产" : "格式矩阵"}
          </Button>
        ))}
      </div>

      {tab === "export" ? (
        <>
          <label>
            模式
            <select value={mode} disabled={readonly} onChange={(event) => {
              const next = event.currentTarget.value as "export" | "web";
              setMode(next);
              setSettings(next === "web" ? DEFAULT_WEB_SETTINGS : DEFAULT_EXPORT_SETTINGS);
              clearPreview();
            }}>
              <option value="export">导出为（逐格式）</option>
              <option value="web">Save for Web</option>
            </select>
          </label>
          <label>
            预设
            <select value="" disabled={readonly} onChange={(event) => { applyPreset(event.currentTarget.value); }}>
              <option value="">选择预设…</option>
              {presets.all().map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
            </select>
          </label>
          <label>
            格式
            <select value={String(settings.format)} disabled={readonly} onChange={(event) => {
              const format = event.currentTarget.value;
              patchSettings({ format: format as ExportSettings["format"] });
            }}>
              {(mode === "web" ? ["png24", "png8", "gif", "jpeg"] : (exportable.length > 0 ? exportable : ["png", "jpg", "webp", "tif"])).map((format) => (
                <option key={format} value={format}>{format}</option>
              ))}
            </select>
          </label>
          {mode === "web" ? (
            <>
              <label>颜色数<input type="number" min={2} max={256} value={settings.colors ?? 256} disabled={readonly} onChange={(event) => patchSettings({ colors: Number(event.currentTarget.value) })} /></label>
              <label>
                抖动
                <select value={settings.dither ?? "diffusion"} disabled={readonly} onChange={(event) => patchSettings({ dither: event.currentTarget.value as ExportSettings["dither"] })}>
                  <option value="diffusion">扩散</option>
                  <option value="pattern">图案</option>
                  <option value="noise">噪点</option>
                  <option value="none">无</option>
                </select>
              </label>
              <label>抖动强度<input type="number" min={0} max={100} value={settings.ditherAmount ?? 88} disabled={readonly} onChange={(event) => patchSettings({ ditherAmount: Number(event.currentTarget.value) })} /></label>
            </>
          ) : null}
          {settings.format === "jpg" || settings.format === "jpeg" ? (
            <>
              {/* Export As 与 Save for Web 的质量默认值不同（90 / 60）：显示哪一个由模式决定，
                  否则用户看到的数字不是实际交付用的那个。 */}
              <label>质量<input type="number" min={1} max={100} value={settings.quality ?? (mode === "web" ? 60 : 90)} disabled={readonly} onChange={(event) => patchSettings({ quality: Number(event.currentTarget.value) })} /></label>
              {supports("chromaSubsampling") ? <label><input type="checkbox" checked={settings.chromaSubsampling !== false} disabled={readonly} onChange={(event) => patchSettings({ chromaSubsampling: event.currentTarget.checked })} />色度抽样</label> : null}
            </>
          ) : null}
          {settings.format === "webp" ? (
            <>
              <label><input type="checkbox" checked={settings.webpLossless === true} disabled={readonly} onChange={(event) => patchSettings({ webpLossless: event.currentTarget.checked })} />无损</label>
              {settings.webpLossless !== true ? <label>质量<input type="number" min={1} max={100} value={settings.webpQuality ?? 80} disabled={readonly} onChange={(event) => patchSettings({ webpQuality: Number(event.currentTarget.value) })} /></label> : null}
            </>
          ) : null}
          {settings.format === "png" || settings.format === "png24" || settings.format === "png8" ? (
            <>
              {/* Save for Web 走自己的优化器，不读 `pngCompression`：在 web 模式下摆这个
                  下拉会让用户以为调了压缩级别，实际被忽略。 */}
              {mode === "export" ? (
                <label>
                  PNG 压缩
                  <select value={settings.pngCompression ?? "default"} disabled={readonly} onChange={(event) => patchSettings({ pngCompression: event.currentTarget.value as ExportSettings["pngCompression"] })}>
                    <option value="none">不压缩</option>
                    <option value="fast">快速</option>
                    <option value="default">默认</option>
                    <option value="best">最优</option>
                  </select>
                </label>
              ) : null}
              {mode === "web" || supports("interlaced") ? <label><input type="checkbox" checked={settings.interlaced === true} disabled={readonly} onChange={(event) => patchSettings({ interlaced: event.currentTarget.checked })} />交错</label> : null}
            </>
          ) : null}
          {settings.format === "tif" ? (
            <label>
              TIFF 压缩
              <select value={settings.tiffCompression ?? "none"} disabled={readonly} onChange={(event) => patchSettings({ tiffCompression: event.currentTarget.value as ExportSettings["tiffCompression"] })}>
                <option value="none">无</option><option value="lzw">LZW</option><option value="deflate">Deflate</option><option value="packbits">PackBits</option>
              </select>
            </label>
          ) : null}
          {supports("transparency") ? <label><input type="checkbox" checked={settings.transparency === true} disabled={readonly} onChange={(event) => patchSettings({ transparency: event.currentTarget.checked })} />保留透明</label> : null}
          <label>
            元数据
            <select value={settings.metadata ?? "none"} disabled={readonly} onChange={(event) => patchSettings({ metadata: event.currentTarget.value as ExportSettings["metadata"] })}>
              <option value="none">无</option>
              <option value="copyright">版权</option>
              <option value="copyrightAndContact">版权与联系人</option>
              <option value="all">全部</option>
            </select>
          </label>
          {supports("embedIcc") ? <label><input type="checkbox" checked={settings.embedIcc === true} disabled={readonly} onChange={(event) => patchSettings({ embedIcc: event.currentTarget.checked })} />嵌入 ICC</label> : null}
          <label>宽度<input type="number" min={1} max={INTERCHANGE_BUDGETS.maxExportDimension} value={settings.width ?? ""} disabled={readonly || settings.percent !== undefined} onChange={(event) => patchSettings({ width: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
          <label>高度<input type="number" min={1} max={INTERCHANGE_BUDGETS.maxExportDimension} value={settings.height ?? ""} disabled={readonly || settings.percent !== undefined} onChange={(event) => patchSettings({ height: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
          <label>百分比<input type="number" min={1} max={1000} value={settings.percent ?? ""} disabled={readonly || settings.width !== undefined || settings.height !== undefined} onChange={(event) => patchSettings({ percent: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
          {target ? (
            <p className="photo-editor__option-hint" data-io-target-size="true">目标尺寸 {target.width} × {target.height}</p>
          ) : null}
          <div className="photo-editor__io-actions">
            <Button size="sm" disabled={readonly} onClick={previewNow}>真实预览</Button>
            <Button size="sm" tone="primary" disabled={readonly} onClick={() => deliver(io.exportRaster(settings))}>导出并下载</Button>
          </div>
          {preview ? (
            <div className="photo-editor__io-preview" data-io-preview="true">
              <img src={preview.url} alt="导出预览" />
              <span className="photo-editor__option-hint">{preview.width} × {preview.height} · {preview.bytes} 字节{preview.lossy ? " · 有损" : ""}</span>
              {preview.warnings.length > 0 ? (
                <ul className="photo-editor__io-list" data-io-warnings="true">
                  {preview.warnings.map((warning, index) => (
                    <li key={index}><span className="photo-editor__option-hint">{warning}</span></li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="photo-editor__io-presets">
            <label>预设名<input value={presetName} maxLength={INTERCHANGE_BUDGETS.maxPresetNameLength} disabled={readonly} onChange={(event) => setPresetName(event.currentTarget.value)} /></label>
            <Button size="sm" disabled={readonly || !presetName.trim()} onClick={() => {
              const saved = presets.save(presetName, settings);
              setMessage(saved ? `已保存预设「${presetName.trim()}」` : presets.lastError);
              if (saved) { setPresetName(""); bumpPresets((value) => value + 1); }
            }}>保存预设</Button>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
              const name = presetName.trim();
              if (!presets.remove(name)) { setMessage("内置预设不能删除"); return; }
              setMessage(`已删除预设「${name}」`);
              setPresetName("");
              bumpPresets((value) => value + 1);
            }}>删除预设</Button>
          </div>
          {presets.lastError && !message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{presets.lastError}</p> : null}
        </>
      ) : null}

      {tab === "layers" ? (
        <>
          <label>
            逐层格式
            <select value={layerFormat} disabled={readonly} onChange={(event) => { setLayerFormat(event.currentTarget.value); setLayerPlan(null); }}>
              {(exportable.length > 0 ? exportable : ["png", "jpg", "webp", "tif"]).map((format) => (
                <option key={format} value={format}>{format}</option>
              ))}
            </select>
          </label>
          <div className="photo-editor__io-actions">
            <Button size="sm" onClick={planLayers}>查看逐层计划</Button>
            <Button size="sm" tone="primary" disabled={readonly} onClick={() => deliver(io.exportLayerBundle(layerParams(controller, layerFormat)))}>逐层打包下载</Button>
            <Button size="sm" disabled={readonly} onClick={() => deliver(io.exportLayerAs({ format: layerFormat }))}>导出当前图层</Button>
          </div>
          {layerReport && Array.isArray(layerReport.layers) ? (
            <ul className="photo-editor__io-list" data-io-layer-plan="true">
              {layerReport.layers.filter(isRecord).map((layer, index) => (
                <li key={`${String(layer.layerId)}-${index}`}>
                  <span>{String(layer.fileName ?? "")}</span>
                  <span className="photo-editor__option-hint">
                    {layer.empty === true ? `跳过：${String(layer.error ?? "无可见像素")}` : `${String(layer.width ?? 0)} × ${String(layer.height ?? 0)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {failures(layerReport).map((failure, index) => (
            <p key={index} className="photo-editor__brush-note photo-editor__brush-note--error">{failure.fileName ?? "图层"}：{failure.error}</p>
          ))}
          {rejected(layerReport).map((item, index) => (
            <p key={`rejected-${index}`} className="photo-editor__brush-note photo-editor__brush-note--error">{item.label}：{item.reason}</p>
          ))}
          {renames(layerReport).length > 0 ? (
            <ul className="photo-editor__io-list" data-io-renames="true">
              {renames(layerReport).map((rename, index) => (
                <li key={index}>
                  <span>{rename.original || "（无名称）"} → {rename.delivered}</span>
                  <span className="photo-editor__option-hint">{rename.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="photo-editor__io-actions">
            <Button size="sm" onClick={planAssets}>查看资产计划</Button>
            <Button size="sm" tone="primary" disabled={readonly} onClick={() => deliver(io.exportImageAssets())}>生成资产包下载</Button>
          </div>
          {assetReport && Array.isArray(assetReport.assets) ? (
            <ul className="photo-editor__io-list" data-io-asset-plan="true">
              {assetReport.assets.filter(isRecord).map((asset, index) => (
                <li key={`${String(asset.layerId)}-${index}`}>
                  <span>{String(asset.fileName ?? "")}</span>
                  <span className="photo-editor__option-hint">
                    {asset.ok === false ? `失败：${String(asset.error ?? "")}` : `${String(asset.width ?? 0)} × ${String(asset.height ?? 0)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {rejected(assetReport).map((item, index) => (
            <p key={`asset-rejected-${index}`} className="photo-editor__brush-note photo-editor__brush-note--error">{item.label}：{item.reason}</p>
          ))}
          {renames(assetReport).length > 0 ? (
            <ul className="photo-editor__io-list" data-io-asset-renames="true">
              {renames(assetReport).map((rename, index) => (
                <li key={index}>
                  <span>{rename.original || "（无名称）"} → {rename.delivered}</span>
                  <span className="photo-editor__option-hint">{rename.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="photo-editor__option-hint">
            按资产语法命名的图层会被生成（例如 <code>图标.png</code>、<code>200% logo@2x.png</code>、
            <code>48x48 icons/a.png</code>）。<code>default 50% low/, 200% @2x</code> 图层会为每个资产
            额外生成变体。一次生成后下载，不启动后台监听。
          </p>
        </>
      ) : null}

      {tab === "matrix" ? (
        <>
          <p className="photo-editor__option-hint">矩阵来自当前真实构建（feature 开关与编码器一致），不是前端常量。</p>
          <ul className="photo-editor__io-list" data-io-matrix="true">
            {matrix.map((row) => (
              <li key={row.id} data-io-matrix-row={row.id}>
                <span>
                  {row.name}
                  {row.read ? " 读" : ""}
                  {row.write ? " 写" : ""}
                  {row.depths.length > 0 ? ` · ${row.depths.join("/")}` : ""}
                  {row.layouts.length > 0 ? ` · ${row.layouts.join("/")}` : ""}
                  {row.alpha ? " · Alpha" : ""}
                  {row.extensions.length > 0 ? ` · ${row.extensions.join("/")}` : ""}
                </span>
                <span className="photo-editor__option-hint">
                  {STATUS_LABEL[row.status] ?? row.status}
                  {matrixFlags(row) ? ` · ${matrixFlags(row)}` : ""}
                  {row.reason ? ` · ${row.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {message ? <p className="photo-editor__brush-note">{message}</p> : null}
    </section>
  );
}

/**
 * 打开前的准入检查（拖入/选择文件时调用）。
 *
 * 只返回预检结论；真正的打开仍走共享打开管线，避免绕过视图发布与保存基线。
 * 暂缓格式与只读格式都必须带得出原因/标志，否则调用方只能给出「打不开」这种无用提示。
 */
export function inspectRasterFile(
  controller: EditorWorkspaceController,
  bytes: Uint8Array
): { ok: boolean; message?: string; format?: string; readOnly?: boolean } {
  const io = port(controller, "inspectOpenRaster");
  if (!io) return { ok: false, message: "当前环境不支持栅格交换" };
  const result = io.inspectOpenRaster(bytes);
  if (!result.ok) return { ok: false, message: result.message ?? "无法打开该文件" };
  const value = isRecord(result.value) ? result.value : {};
  const format = typeof value.format === "string" ? value.format : undefined;
  const name = typeof value.name === "string" ? value.name : format;
  if (value.openable !== true) {
    const reason = typeof value.reason === "string" && value.reason.length > 0 ? value.reason : "本构建不支持该格式";
    return { ok: false, format, message: `${name ?? "该格式"} 暂不支持打开：${reason}` };
  }
  return { ok: true, format, readOnly: value.status === "read-only" };
}
