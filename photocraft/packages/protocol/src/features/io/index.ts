/**
 * 栅格交换域协议（change: 2026-10-22-add-photocraft-raster-interchange，U05/U06/U07）。
 *
 * 这里只有**纯数据与纯函数**：格式 id、导出设置、预设与报告校验、域预算。真正的矩阵与编码
 * 结论由内核给出（`interchangeMatrixJson` / `exportMatrixJson`），本文件不复制第二套能力声明，
 * 也不手写第二组预算数字 —— 预算唯一权威是同目录的 `interchange-budgets.json`，Rust 内核
 * `include_str!` 读取的也是这一份。
 */
import budgetsJson from "./interchange-budgets.json";

export const feature = {
  id: "io",
  capabilities: [
    { stage: "P2", order: 3, id: "file.place-image" },
    { stage: "P3", order: 0, id: "format.psd-import" },
    { stage: "P3", order: 1, id: "format.psd-export" },
    { stage: "P3", order: 2, id: "format.psd-loss-report" },
  ]
} as const;

/** 本域交换预算（唯一权威：`interchange-budgets.json`）。 */
export type InterchangeBudgets = {
  maxExportDimension: number;
  maxExportPixels: number;
  maxLayerBundleFiles: number;
  maxLayerBundlePixels: number;
  maxLayerBundleBytes: number;
  maxAssetFiles: number;
  maxAssetPixels: number;
  maxAssetBytes: number;
  maxFileNameLength: number;
  maxRelativePathLength: number;
  maxExportPresets: number;
  maxPresetNameLength: number;
};

export const INTERCHANGE_BUDGETS: InterchangeBudgets = budgetsJson as InterchangeBudgets;

/**
 * 本 change 新增的能力 id（**域内声明**）。
 *
 * 把它们登记进共享阶段清单需要同时改集成方拥有的 `tests/fixtures/contract.json`、
 * `tests/fixtures/feature-boundary-wasm-baseline.json` 与阶段清单，因此这里只声明、由集成负责人顺序
 * 合入。在此之前入口由本域自己的面板调用，不经共享能力门 —— 不要用「菜单项存在」当作能力已
 * 交付的证据。
 */
export const INTERCHANGE_CAPABILITIES = [
  "format.raster-matrix",
  "format.open-raster",
  "format.export",
  "format.export.save-for-web",
  "format.export.preview",
  "format.export.presets",
  "format.layers.export",
  "format.layers.files",
  "format.image-assets"
] as const;
export type InterchangeCapability = (typeof INTERCHANGE_CAPABILITIES)[number];

/** 通用导出的格式 id（等于首选扩展名，与内核矩阵逐项一致）。 */
export const EXPORT_FORMATS = ["png", "jpg", "webp", "tif", "gif", "bmp", "tga", "ico", "qoi", "pnm"] as const;
export type ExportFormatId = (typeof EXPORT_FORMATS)[number];

/**
 * 宿主文件选择器可列的栅格扩展名（U05 的宿主侧唯一清单）。
 *
 * 顺序与分组来自内核矩阵的可打开行（`status` 为 `open` / `read-only`），暂缓格式不入列 ——
 * 否则用户在对话框里选中一个立刻被拒的格式。`.pcraft` 不在这里：工程打开是另一条管线。
 *
 * 为什么不直接调 `io.openAccept()`：`<input accept>` 在首次渲染时就要有值，而本域端口依赖
 * 内核实例；把它做成异步会让选择器先空后变，用户可能在空窗期点开对话框。因此这里放**静态
 * 清单**，并由 `wasm-integration.test.ts` 用真实产物断言它与 `io.openAccept()` 逐项一致，
 * 两边漂移会让测试失败。
 */
export const OPEN_RASTER_EXTENSIONS = [
  // 可编辑打开
  "png", "apng", "jpg", "jpeg", "jpe", "jfif",
  "tif", "tiff", "webp", "gif", "bmp", "dib",
  "tga", "icb", "vda", "vst", "ico", "qoi",
  "pnm", "pbm", "pgm", "ppm", "pam", "pfm",
  // 只读打开（可建成可编辑文档，但不写回该扩展名）
  "pcx", "xpm", "dds"
] as const;

/** 同一清单的 MIME 形式（写入 `accept` 一并列出，让系统对话框按类型也能选）。 */
export const OPEN_RASTER_MIMES = [
  "image/png", "image/jpeg", "image/tiff", "image/webp", "image/gif",
  "image/bmp", "image/x-tga", "image/x-icon", "image/qoi",
  "image/x-portable-anymap", "image/x-pcx", "image/x-xpixmap", "image/vnd-ms.dds"
] as const;

/**
 * 栅格「打开图片」选择器的 `accept` 值。
 *
 * 与 `OPEN_FILE_ACCEPT`（含 `.pcraft`）分开：把工程扩展名混进图片选择器会让图片入口也能
 * 选到工程，随后在错误的打开链路上失败。
 */
export const OPEN_RASTER_ACCEPT = [
  ...OPEN_RASTER_MIMES,
  ...OPEN_RASTER_EXTENSIONS.map((extension) => `.${extension}`)
].join(",");

/** Save for Web 的格式词（与 `web_cmds::WebFormat` 的可交付子集一致）。 */
export const WEB_FORMATS = ["png24", "png8", "gif", "jpeg"] as const;
export type WebFormatId = (typeof WEB_FORMATS)[number];

/** 元数据策略（JPEG/TIFF/PNG 可嵌入；`none` 是 Export As 的默认）。 */
export const EXPORT_METADATA_POLICIES = ["none", "copyright", "copyrightAndContact", "all"] as const;
export type ExportMetadataPolicy = (typeof EXPORT_METADATA_POLICIES)[number];

/** 一次导出的设置（UI 状态 → WASM 参数，一一对应，不做隐式换算）。 */
export type ExportSettings = {
  mode: "export" | "web";
  format: ExportFormatId | WebFormatId;
  quality?: number;
  webpQuality?: number;
  webpLossless?: boolean;
  chromaSubsampling?: boolean;
  pngCompression?: "none" | "fast" | "default" | "best";
  interlaced?: boolean;
  tiffCompression?: "none" | "lzw" | "deflate" | "packbits";
  transparency?: boolean;
  metadata?: ExportMetadataPolicy;
  embedIcc?: boolean;
  /** 尺寸：三选一，`percent` 与 `width`/`height` 互斥。 */
  width?: number;
  height?: number;
  percent?: number;
  /** Save for Web 的调色板与抖动（只有 `mode = "web"` 使用）。 */
  colors?: number;
  dither?: "none" | "diffusion" | "pattern" | "noise";
  ditherAmount?: number;
  preset?: string;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  mode: "export",
  format: "jpg",
  quality: 90,
  chromaSubsampling: true,
  metadata: "none",
  transparency: false
};

export const DEFAULT_WEB_SETTINGS: ExportSettings = {
  mode: "web",
  format: "png24",
  // 与内核 `WebSettings::default()` 的 60 对齐：界面显示的数字必须就是交付用的数字，
  // 不能显示 90 却按 60 编码。
  quality: 60,
  colors: 256,
  dither: "diffusion",
  ditherAmount: 88,
  transparency: true,
  metadata: "none"
};

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const boundedNumber = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * 校验并归一化导出设置。
 *
 * 只做**能在客户端判定**的检查（枚举、范围、互斥）；格式是否可写、目标是否超预算必须由内核
 * 判定 —— 那取决于真实构建（feature 开关）与当前文档尺寸，客户端不得自行猜测或放宽。
 */
export function normalizeExportSettings(input: unknown): DecodeResult<ExportSettings> {
  if (!isRecord(input)) return { ok: false, message: "导出设置必须是对象" };
  const mode = input.mode === undefined ? "export" : input.mode;
  if (mode !== "export" && mode !== "web") return { ok: false, message: "mode 只能是 export 或 web" };
  const format = input.format;
  if (mode === "web") {
    if (!WEB_FORMATS.includes(format as WebFormatId)) {
      return { ok: false, message: `Save for Web 格式只能是 ${WEB_FORMATS.join(" / ")}` };
    }
  } else if (!EXPORT_FORMATS.includes(format as ExportFormatId)) {
    return { ok: false, message: `导出格式只能是 ${EXPORT_FORMATS.join(" / ")}` };
  }
  const settings: ExportSettings = { mode, format: format as ExportFormatId | WebFormatId };

  if (input.quality !== undefined) {
    if (!boundedInteger(input.quality, 1, 100)) return { ok: false, message: "质量必须在 1–100 之间" };
    settings.quality = input.quality;
  }
  if (input.webpQuality !== undefined) {
    if (!boundedInteger(input.webpQuality, 1, 100)) return { ok: false, message: "WebP 质量必须在 1–100 之间" };
    settings.webpQuality = input.webpQuality;
  }
  for (const key of ["webpLossless", "chromaSubsampling", "interlaced", "transparency", "embedIcc"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") return { ok: false, message: `${key} 必须是布尔值` };
      settings[key] = value;
    }
  }
  if (input.pngCompression !== undefined) {
    const allowed = ["none", "fast", "default", "best"] as const;
    if (!allowed.includes(input.pngCompression as (typeof allowed)[number])) {
      return { ok: false, message: `PNG 压缩只能是 ${allowed.join(" / ")}` };
    }
    settings.pngCompression = input.pngCompression as ExportSettings["pngCompression"];
  }
  if (input.tiffCompression !== undefined) {
    const allowed = ["none", "lzw", "deflate", "packbits"] as const;
    if (!allowed.includes(input.tiffCompression as (typeof allowed)[number])) {
      return { ok: false, message: `TIFF 压缩只能是 ${allowed.join(" / ")}` };
    }
    settings.tiffCompression = input.tiffCompression as ExportSettings["tiffCompression"];
  }
  if (input.metadata !== undefined) {
    if (!EXPORT_METADATA_POLICIES.includes(input.metadata as ExportMetadataPolicy)) {
      return { ok: false, message: `元数据策略只能是 ${EXPORT_METADATA_POLICIES.join(" / ")}` };
    }
    settings.metadata = input.metadata as ExportMetadataPolicy;
  }
  const sizes = [input.width, input.height, input.percent].filter((value) => value !== undefined && value !== null);
  if (sizes.length > 0) {
    if (input.percent !== undefined && input.percent !== null) {
      if (input.width !== undefined || input.height !== undefined) {
        return { ok: false, message: "百分比与宽高只能给一组" };
      }
      if (!boundedNumber(input.percent, 1, 1000)) return { ok: false, message: "百分比必须在 1–1000 之间" };
      settings.percent = input.percent;
    } else {
      for (const key of ["width", "height"] as const) {
        const value = input[key];
        if (value === undefined || value === null) continue;
        if (!boundedInteger(value, 1, INTERCHANGE_BUDGETS.maxExportDimension)) {
          return { ok: false, message: `${key === "width" ? "宽" : "高"}必须在 1–${INTERCHANGE_BUDGETS.maxExportDimension} 之间` };
        }
        settings[key] = value;
      }
    }
  }
  if (input.colors !== undefined) {
    if (!boundedInteger(input.colors, 2, 256)) return { ok: false, message: "调色板颜色数必须在 2–256 之间" };
    settings.colors = input.colors;
  }
  if (input.dither !== undefined) {
    const allowed = ["none", "diffusion", "pattern", "noise"] as const;
    if (!allowed.includes(input.dither as (typeof allowed)[number])) {
      return { ok: false, message: `抖动只能是 ${allowed.join(" / ")}` };
    }
    settings.dither = input.dither as ExportSettings["dither"];
  }
  if (input.ditherAmount !== undefined) {
    if (!boundedNumber(input.ditherAmount, 0, 100)) return { ok: false, message: "抖动强度必须在 0–100 之间" };
    settings.ditherAmount = input.ditherAmount;
  }
  if (input.preset !== undefined) {
    if (typeof input.preset !== "string" || input.preset.length === 0 || input.preset.length > INTERCHANGE_BUDGETS.maxPresetNameLength) {
      return { ok: false, message: "预设名无效" };
    }
    settings.preset = input.preset;
  }
  return { ok: true, value: settings };
}

/** 一条导出预设：名字 + 完整设置（本机存储，不进入内容指纹）。 */
export type ExportPreset = { name: string; settings: ExportSettings };

/** 预设集合校验：有界、名字唯一、设置逐条合法。 */
export function decodeExportPresets(raw: unknown): DecodeResult<ExportPreset[]> {
  if (!Array.isArray(raw)) return { ok: false, message: "预设集合必须是数组" };
  if (raw.length > INTERCHANGE_BUDGETS.maxExportPresets) {
    return { ok: false, message: `预设最多 ${INTERCHANGE_BUDGETS.maxExportPresets} 条` };
  }
  const seen = new Set<string>();
  const presets: ExportPreset[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, message: "预设必须是对象" };
    const name = entry.name;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > INTERCHANGE_BUDGETS.maxPresetNameLength) {
      return { ok: false, message: "预设名无效" };
    }
    if (seen.has(name)) return { ok: false, message: `预设名重复：${name}` };
    seen.add(name);
    const settings = normalizeExportSettings(entry.settings);
    if (!settings.ok) return { ok: false, message: `预设「${name}」无效：${settings.message}` };
    presets.push({ name, settings: settings.value });
  }
  return { ok: true, value: presets };
}

/** 内核 `exportMatrixJson()` 的一行（只声明 UI 消费的字段）。 */
export type ExportMatrixRow = {
  format: string;
  name: string;
  extensions: readonly string[];
  mime: string;
  alpha: boolean;
  lossy: boolean;
  animation: boolean;
  depths: readonly string[];
  options: readonly string[];
  webFormats: readonly string[];
};

/** 内核 `interchangeMatrixJson()`。 */
export type InterchangeMatrix = {
  formats: readonly {
    id: string;
    name: string;
    extensions: readonly string[];
    mime: string;
    read: boolean;
    write: boolean;
    depths: readonly string[];
    layouts: readonly string[];
    alpha: boolean;
    animation: boolean;
    lossy: boolean;
    status: "open" | "read-only" | "deferred";
    reason: string | null;
    exportable: boolean;
  }[];
  openable: readonly string[];
  exportable: readonly string[];
  budgets: InterchangeBudgets;
  capabilities: readonly string[];
};

/** 导出报告（预览与交付共用同一结构）。 */
export type ExportReport = {
  kind: "export" | "layer-export";
  mode?: "export" | "web";
  format: string;
  mime?: string;
  width: number;
  height: number;
  bytes: number;
  revision: number;
  documentContentHash: string;
  settings: Record<string, unknown>;
  warnings: readonly string[];
  lossy: boolean;
  colors: number | null;
  transparentIndex: number | null;
  preview: boolean;
  documentChanged: false;
  layerId?: number;
  layerName?: string | null;
};

/** 内核报告是不可信输入：只接受这里认可的形状，避免把任意 JSON 当类型用。 */
export function decodeExportReport(raw: unknown): DecodeResult<ExportReport> {
  if (!isRecord(raw)) return { ok: false, message: "导出报告必须是对象" };
  const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]);
  const required = ["width", "height", "bytes", "revision"];
  for (const key of required) if (!number(key)) return { ok: false, message: `导出报告缺少 ${key}` };
  if (typeof raw.format !== "string" || raw.format.length === 0) return { ok: false, message: "导出报告缺少 format" };
  if (typeof raw.documentContentHash !== "string") return { ok: false, message: "导出报告缺少内容指纹" };
  if (raw.documentChanged !== false) return { ok: false, message: "导出不得改动文档" };
  if (raw.kind !== "export" && raw.kind !== "layer-export") return { ok: false, message: "导出报告类型无效" };
  return { ok: true, value: raw as unknown as ExportReport };
}

/** 逐层报告的一项。 */
export type LayerBundleFile = {
  fileName: string;
  layerId: number;
  name: string;
  width?: number;
  height?: number;
  bytes?: number;
  ok: boolean;
  error?: string;
};

export type LayerBundleReport = {
  kind: "layers";
  format: string;
  revision: number;
  documentContentHash: string;
  files: readonly LayerBundleFile[];
  okCount: number;
  failedCount: number;
  totalBytes: number;
  renames: readonly { original: string; delivered: string; reason: string }[];
  rejected: readonly Record<string, unknown>[];
  documentChanged: false;
};

export function decodeLayerBundleReport(raw: unknown): DecodeResult<LayerBundleReport> {
  if (!isRecord(raw)) return { ok: false, message: "逐层报告必须是对象" };
  if (raw.kind !== "layers") return { ok: false, message: "逐层报告类型无效" };
  if (!Array.isArray(raw.files)) return { ok: false, message: "逐层报告缺少文件列表" };
  if (typeof raw.okCount !== "number" || typeof raw.failedCount !== "number") {
    return { ok: false, message: "逐层报告缺少计数" };
  }
  if (raw.okCount + raw.failedCount !== raw.files.length) {
    return { ok: false, message: "逐层报告的计数与文件列表不一致" };
  }
  if (raw.documentChanged !== false) return { ok: false, message: "逐层导出不得改动文档" };
  return { ok: true, value: raw as unknown as LayerBundleReport };
}

/** 按名称资产报告的一项。 */
export type AssetFile = {
  fileName: string;
  layerId: number;
  layerName: string;
  requested: string;
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  ok: boolean;
  error?: string;
};

export type AssetReport = {
  kind: "assets";
  revision: number;
  documentContentHash: string;
  files: readonly AssetFile[];
  okCount: number;
  failedCount: number;
  totalBytes: number;
  renames: readonly { original: string; delivered: string; reason: string }[];
  rejected: readonly Record<string, unknown>[];
  documentChanged: false;
};

export function decodeAssetReport(raw: unknown): DecodeResult<AssetReport> {
  if (!isRecord(raw)) return { ok: false, message: "资产报告必须是对象" };
  if (raw.kind !== "assets") return { ok: false, message: "资产报告类型无效" };
  if (!Array.isArray(raw.files)) return { ok: false, message: "资产报告缺少文件列表" };
  if (typeof raw.okCount !== "number") return { ok: false, message: "资产报告缺少计数" };
  if (raw.documentChanged !== false) return { ok: false, message: "资产交付不得改动文档" };
  return { ok: true, value: raw as unknown as AssetReport };
}

/** 交付包复核结果（`inspectIoBundle`）。 */
export type BundleInspection = {
  files: readonly { name: string; bytes: number }[];
  report: Record<string, unknown> | null;
  bytes: number;
};

export function decodeBundleInspection(raw: unknown): DecodeResult<BundleInspection> {
  if (!isRecord(raw)) return { ok: false, message: "包复核结果必须是对象" };
  if (!Array.isArray(raw.files)) return { ok: false, message: "包复核缺少条目列表" };
  if (typeof raw.bytes !== "number") return { ok: false, message: "包复核缺少字节数" };
  const files: { name: string; bytes: number }[] = [];
  for (const file of raw.files) {
    if (!isRecord(file) || typeof file.name !== "string" || typeof file.bytes !== "number") {
      return { ok: false, message: "包条目无效" };
    }
    files.push({ name: file.name, bytes: file.bytes });
  }
  const report = isRecord(raw.report) ? (raw.report as Record<string, unknown>) : null;
  return { ok: true, value: { files, report, bytes: raw.bytes } };
}

/** 交付文件名：去掉目录与不可用字符，保证宿主能落地（扩展名跟随真实格式）。 */
export function deliveryFileName(documentName: string, extension: string): string {
  const cleaned = documentName.replace(/[\\/:*?"<>|]/g, "_");
  const dot = cleaned.lastIndexOf(".");
  // 只有「真有一个 stem」时才把后缀当扩展名去掉：`..hidden` 与 `.gitignore` 的点是文件名
  // 自身的一部分（隐藏文件标记），不是扩展名分隔符。
  const stemBeforeDot = dot > 0 ? cleaned.slice(0, dot) : "";
  const base = stemBeforeDot.replace(/[.\s]/g, "").length > 0 ? stemBeforeDot : cleaned;
  const stem = base
    .replace(/^\.+/, "")
    .trim()
    .slice(0, Math.max(1, INTERCHANGE_BUDGETS.maxFileNameLength - extension.length - 1));
  return `${stem.length > 0 ? stem : "未命名"}.${extension}`;
}
