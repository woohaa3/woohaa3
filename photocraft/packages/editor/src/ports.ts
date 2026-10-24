/**
 * 编辑器对外端口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3）。
 *
 * 这些类型是编辑器与宿主之间**唯一**的耦合面：受控对话框栈、内核实测插桩与静态资源地址。
 * 端口只描述能力，不暴露 Cordis Context、DialogsService、Y.Doc、StoredAsset 或宿主 controller
 * 构造器。宿主在自己的装配层实现它们。
 */
import type { ReactNode } from "react";

/** 编辑会话身份（用于校验命名弹窗仍属于同一会话）。 */
export type EditorEditingOwner = {
  canvasId: string;
  /** 节点文档的节点身份；独立文件文档缺省。 */
  nodeId?: string;
  /** 独立文件文档的不透明 id；节点文档缺省。 */
  documentId?: string;
  sessionId: string;
};

/** 弹窗实例描述（纯数据，可序列化）。 */
export type EditorDialogInstance = {
  instanceId: string;
  dialogId: string;
  payload?: unknown;
};

/** 弹窗 renderer 能力（由宿主 Dialog Host 注入）。 */
export type EditorDialogRendererProps = {
  instance: EditorDialogInstance;
  requestClose: () => void;
  setBusy: (busy: boolean) => void;
  replace: (payload: unknown) => void;
};

/** 一次弹窗类型注册。 */
export type EditorDialogRegistration = {
  definition: {
    editingOwner?: () => EditorEditingOwner | null;
    dismissible?: boolean;
    singleton?: boolean;
    size?: "sm" | "md" | "lg" | "fullscreen";
    variant?: "standard" | "alert" | "media" | "sheet";
    validatePayload: (payload: unknown) => { ok: true; payload: unknown } | { ok: false; error: string };
  };
  renderer: (props: EditorDialogRendererProps) => ReactNode;
};

/**
 * 受控对话框端口。
 *
 * 编辑器只请求打开/关闭与注册 renderer；栈顺序、焦点、Escape、遮罩与关闭策略始终归宿主的
 * Dialog Host。`open` 失败返回稳定诊断而不是抛异常。
 */
export type EditorDialogPort = {
  subscribe(listener: () => void): () => void;
  isModalActive(): boolean;
  registerDialog(id: string, registration: EditorDialogRegistration): () => void;
  open(request: { dialogId: string }): { ok: true; instance: EditorDialogInstance } | { ok: false; error: string };
  top(): EditorDialogInstance | null;
  close(instanceId?: string): void;
};

/** 内核调用插桩端口（缺省为零成本直通）。 */
export type EditorInstrumentation = {
  phase<T>(name: string, run: () => T): T;
  metric<T>(name: string, run: () => T, bytes?: number): T;
  preview<T>(kind: string, run: () => T): T;
};

let instrumentation: EditorInstrumentation = {
  phase: (_name, run) => run(),
  metric: (_name, run) => run(),
  preview: (_kind, run) => run()
};

/** 装配层在启动时注入宿主性能插桩；传 null 恢复零成本直通。 */
export function setEditorInstrumentation(value: EditorInstrumentation | null): void {
  instrumentation = value ?? {
    phase: (_name, run) => run(),
    metric: (_name, run) => run(),
    preview: (_kind, run) => run()
  };
}

export function editorPhase<T>(name: string, run: () => T): T {
  return instrumentation.phase(name, run);
}

export function editorMetric<T>(name: string, run: () => T, bytes?: number): T {
  return instrumentation.metric(name, run, bytes);
}

export function editorPreview<T>(kind: string, run: () => T): T {
  return instrumentation.preview(kind, run);
}

/** 静态资源地址端口：宿主按根路径/子路径部署给出可访问 URL。 */
export type EditorAssetPort = (path: string) => string;

/**
 * 本地文件交付端口（change: 2026-10-21-add-photocraft-document-workspace，design D5）。
 *
 * 独立文件文档保存工程与导出 PNG 都经宿主交付，**不**要求画布节点身份、不上传 Canvas、
 * 不产生节点历史。结果必须区分四种情况：
 * - `written`：宿主确认已写入目标磁盘（只有这种情况允许自动推进本地保存基线）；
 * - `download-started`：只能发起浏览器下载，**不得**宣称已落盘或清除未保存状态；
 * - `cancelled`：用户取消（保留现场）；
 * - `failed`：失败并给出可重试原因。
 */
export type EditorFileDelivery = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
};

/** 导出格式选项（I045）：与内核 `export_request.rs` 同名的字段。 */
export type EditorExportOptions = {
  format: "png"|"jpeg"|"webp"|"tiff"|"tga"|"bmp"|"gif"|"ico";
  jpegQuality: number;
  jpegChromaSubsampling: boolean;
  pngCompression: "default"|"fast"|"best"|"none";
  pngInterlaced: boolean;
  webpLossless: boolean;
  webpQuality: number;
  tiffCompression: "none"|"lzw"|"deflate"|"packbits";
  embedMetadata: boolean;
  scale: number;
};

export const DEFAULT_EXPORT_OPTIONS: EditorExportOptions = {
  format:"png", jpegQuality:90, jpegChromaSubsampling:true, pngCompression:"default", pngInterlaced:false,
  webpLossless:false, webpQuality:85, tiffCompression:"lzw", embedMetadata:true, scale:1
};

/** 各格式的 MIME 与扩展名；只列固定编码器真实支持的类型。 */
export const EXPORT_FORMATS: Readonly<Record<EditorExportOptions["format"], {label:string;extension:string;contentType:string}>> = {
  png:{label:"PNG",extension:"png",contentType:"image/png"},
  jpeg:{label:"JPEG",extension:"jpg",contentType:"image/jpeg"},
  webp:{label:"WebP",extension:"webp",contentType:"image/webp"},
  tiff:{label:"TIFF",extension:"tiff",contentType:"image/tiff"},
  tga:{label:"Targa",extension:"tga",contentType:"image/x-tga"},
  bmp:{label:"BMP",extension:"bmp",contentType:"image/bmp"},
  gif:{label:"GIF",extension:"gif",contentType:"image/gif"},
  ico:{label:"ICO",extension:"ico",contentType:"image/x-icon"}
};

export type EditorFileDeliveryResult =
  | { ok: true; status: "written" | "download-started" }
  | { ok: false; status: "cancelled" | "failed"; message?: string };

export type EditorFilePort = (file: EditorFileDelivery) => Promise<EditorFileDeliveryResult>;
