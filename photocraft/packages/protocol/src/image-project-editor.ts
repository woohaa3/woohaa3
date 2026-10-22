/**
 * React 图像编辑器内核契约：能力清单、命令注册表、状态与导出摘要校验
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.1/3.7 / design D1/D3/D8）。
 *
 * 编辑内核是同一个 wasm 模块（`photocraft/rust/crates/editor-core`），React 直接调用
 * 它的方法，不再有 iframe、origin、session/generation 消息或桥协议。因此本模块只定义：
 *
 * - **首期能力清单**：菜单、工具栏、快捷键、命令面板与命令分派共用同一份；
 * - **命令注册表解码**：`commandsJson()` 的结果必须有界、可核对，并带 `allowed` 门；
 * - **文档状态解码**：`stateJson()` 的图层树/选区/历史折叠成 UI 需要的稳定形状；
 * - **导出摘要校验**：保存时核对「工程 + PNG 成对、同修订、不超限」。
 *
 * 所有函数都是纯函数、无副作用、不接触 DOM 或 wasm。
 */
import { isBoundedId, isJsonObject, isNonNegativeInteger } from "./validation.js";
import { IMAGE_PROJECT_LIMITS, SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS } from "./image-edit.js";

/** 固定上游提交；`buildInfoJson()` 必须回传同一值。 */
export const PHOTOCRAFT_ENGINE_COMMIT = "4e7a17cd5d5723313f459753663d0d155f047e19" as const;

/** 首期开放的能力 id（与 notes/scope.md 六组一一对应）。 */
export const PHOTOCRAFT_CAPABILITIES = [
  "layers.composite",
  "layers.fill-opacity",
  "layers.styles.resource-free",
  "layers.styles.patterns",
  "layers.groups",
  "layers.blend.pass-through",
  "layers.blend.photoshop",
  "layers.blend.normal",
  "layers.blend.multiply",
  "layers.blend.screen",
  "compose.transform",
  "selection.rect",
  "selection.lasso",
  "selection.feather",
  "mask.pixel",
  "paint.brush",
  "paint.eraser",
  "text.horizontal",
  "adjust.brightness-contrast",
  "adjust.hue-saturation",
  "adjust.curves"
] as const;
export type PhotocraftCapability = (typeof PHOTOCRAFT_CAPABILITIES)[number];

/**
 * 首期**明确关闭**的能力 id（design D3/D8、notes/scope.md）。
 *
 * 这些 id 来自同一清单：菜单、快捷键、命令面板与命令分派都必须拒绝，而不是只隐藏图标。
 */
export const PHOTOCRAFT_DISABLED_FEATURES = [
  "format.psd-import",
  "format.psd-export",
  "format.psb",
  "layer.smart-object",
  "vector.path",
  "filter.complex",
  "filter.liquify",
  "tool.healing",
  "tool.clone",
  "tool.magic-wand",
  "selection.ai-subject",
  "selection.hair-refine",
  "adjust.channel-curves",
  "adjust.lut",
  "color.icc",
  "color.cmyk",
  "color.hdr",
  "brush.external-abr",
  "type.path",
  "type.vertical",
  "print",
  "plugin",
  "automation.mcp",
  "batch.background",
  "file.open-external",
  "file.export-local"
] as const;
export type PhotocraftDisabledFeature = (typeof PHOTOCRAFT_DISABLED_FEATURES)[number];

const CAPABILITY_SET = new Set<string>(PHOTOCRAFT_CAPABILITIES);
const DISABLED_SET = new Set<string>(PHOTOCRAFT_DISABLED_FEATURES);

/** 首期能力清单（唯一来源；UI 与命令门共用）。 */
export function photocraftCapabilityManifest(): {
  engine: "photocraft";
  engineCommit: typeof PHOTOCRAFT_ENGINE_COMMIT;
  formatVersions: readonly number[];
  capabilities: PhotocraftCapability[];
  disabled: PhotocraftDisabledFeature[];
  limits: typeof IMAGE_PROJECT_LIMITS;
} {
  return {
    engine: "photocraft",
    engineCommit: PHOTOCRAFT_ENGINE_COMMIT,
    formatVersions: SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
    capabilities: [...PHOTOCRAFT_CAPABILITIES],
    disabled: [...PHOTOCRAFT_DISABLED_FEATURES],
    limits: IMAGE_PROJECT_LIMITS
  };
}

/** 能力是否开放：未声明与显式关闭都返回 false。 */
export function isPhotocraftCapabilityEnabled(id: string): id is PhotocraftCapability {
  if (DISABLED_SET.has(id)) return false;
  return CAPABILITY_SET.has(id);
}

/** 判断某功能 id（能力或关闭项）是否允许执行；UI 与命令门共用同一判定。 */
export function isPhotocraftFeatureAllowed(featureId: string): boolean {
  if (DISABLED_SET.has(featureId)) return false;
  return CAPABILITY_SET.has(featureId);
}

/**
 * 校验一组能力 id 必须是首期清单的子集且不与关闭清单冲突；返回被拒绝的 id。
 */
export function checkPhotocraftCapabilities(input: unknown): { ok: true } | { ok: false; rejected: string[] } {
  if (!Array.isArray(input)) return { ok: false, rejected: ["<not-an-array>"] };
  const rejected: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !isPhotocraftCapabilityEnabled(raw)) {
      rejected.push(typeof raw === "string" ? raw : "<non-string>");
    }
  }
  return rejected.length === 0 ? { ok: true } : { ok: false, rejected };
}

/** 内核拒绝原因（跨层按字符串判定，测试与 UI 共用）。 */
export const PHOTOCRAFT_REJECTIONS = [
  "invalid-message",
  "capability-disabled",
  "size-exceeded"
] as const;
export type PhotocraftRejection = (typeof PHOTOCRAFT_REJECTIONS)[number];

/** 内核错误：`{ code, message }`，由 wasm 层抛出。 */
export type PhotocraftEditorError = { code: string; message: string };

/** 从 wasm 抛出的错误值解析稳定 code/message；非法输入退化为通用错误。 */
export function decodePhotocraftError(input: unknown): PhotocraftEditorError {
  if (typeof input === "string") {
    try {
      return decodePhotocraftError(JSON.parse(input));
    } catch {
      return { code: "unknown", message: input.slice(0, 500) };
    }
  }
  if (isJsonObject(input)) {
    const code = typeof input.code === "string" && input.code.length > 0 ? input.code.slice(0, 120) : "unknown";
    const message = typeof input.message === "string" ? input.message.slice(0, 500) : "";
    return { code, message };
  }
  return { code: "unknown", message: "" };
}

/** 一条命令注册表记录（`commandsJson()` 的元素）。 */
export type PhotocraftCommand = {
  id: string;
  label: string;
  menu: string[];
  shortcut: string | null;
  params: string;
  /** engine 自报的启用状态（文档/选择等上下文）。 */
  enabled: boolean;
  disabledReason: string | null;
  needsDocument: boolean;
  /** 是否属于首期能力清单；false 表示 UI 不得渲染或分派。 */
  allowed: boolean;
  keywords?: string[];
};

/**
 * 校验并归一化命令注册表。
 *
 * 只接受有界结构；`allowed` 必须存在。返回顺序保持引擎顺序（菜单结构稳定）。
 */
export function decodePhotocraftCommands(
  input: unknown
): { ok: true; commands: PhotocraftCommand[] } | { ok: false; code: PhotocraftRejection; message: string } {
  if (!Array.isArray(input)) return { ok: false, code: "invalid-message", message: "命令注册表必须是数组" };
  const commands: PhotocraftCommand[] = [];
  for (const raw of input) {
    const command = decodePhotocraftCommand(raw);
    if (!command) return { ok: false, code: "invalid-message", message: "命令记录结构非法" };
    commands.push(command);
  }
  return { ok: true, commands };
}

function decodePhotocraftCommand(input: unknown): PhotocraftCommand | null {
  if (!isJsonObject(input)) return null;
  if (!isBoundedId(input.id, 200)) return null;
  if (typeof input.label !== "string" || input.label.length === 0 || input.label.length > 200) return null;
  if (!Array.isArray(input.menu) || !input.menu.every((m) => typeof m === "string" && m.length <= 120)) return null;
  if (input.shortcut !== null && (typeof input.shortcut !== "string" || input.shortcut.length > 120)) return null;
  if (typeof input.params !== "string" || input.params.length > 2000) return null;
  if (typeof input.enabled !== "boolean" || typeof input.needsDocument !== "boolean") return null;
  if (input.disabledReason !== null && (typeof input.disabledReason !== "string" || input.disabledReason.length > 500)) {
    return null;
  }
  if (typeof input.allowed !== "boolean") return null;
  const command: PhotocraftCommand = {
    id: input.id,
    label: input.label,
    menu: [...(input.menu as string[])],
    shortcut: input.shortcut,
    params: input.params,
    enabled: input.enabled,
    disabledReason: input.disabledReason,
    needsDocument: input.needsDocument,
    allowed: input.allowed
  };
  if (Array.isArray(input.keywords)) {
    command.keywords = input.keywords.filter((k): k is string => typeof k === "string");
  }
  return command;
}

/** 命令是否可以被 React 分派：引擎允许 + 首期能力清单允许。 */
export function isPhotocraftCommandDispatchable(command: PhotocraftCommand): boolean {
  return command.allowed && !DISABLED_SET.has(command.id);
}

/** 轻量内容状态：不含像素/字体/文档树。 */
export type PhotocraftContentState = {
  canvasWidth: number;
  canvasHeight: number;
  layerCount: number;
  activeLayerIndex: number;
  /** 规范文档内容 hash（16 位小写 hex）。 */
  documentContentHash: string;
  /**
   * 编辑器当前修订号（非负安全整数）。
   *
   * 宿主用它冻结导出：保存时携带该修订，回传的 `exportResult.revision` 必须相同，否则拒绝
   * （避免把旧修订的字节当成当前修订写回）。
   */
  revision: number;
  /** 会话内是否有未提交的内容变化。 */
  dirty: boolean;
  /** 冻结期间不接受内容写入。 */
  frozen: boolean;
};

/** 严格解析轻量内容状态。 */
export function decodeContentState(input: unknown): PhotocraftContentState | null {
  if (!isJsonObject(input)) return null;
  const { canvasWidth, canvasHeight, layerCount, activeLayerIndex, documentContentHash, revision, dirty, frozen } = input;
  if (!isNonNegativeInteger(canvasWidth) || !isNonNegativeInteger(canvasHeight) || !isCanvasSize(canvasWidth, canvasHeight)) {
    return null;
  }
  if (!isNonNegativeInteger(layerCount) || layerCount > IMAGE_PROJECT_LIMITS.maxLayers) return null;
  if (!isNonNegativeInteger(activeLayerIndex)) return null;
  if (!isNonNegativeInteger(revision)) return null;
  if (typeof documentContentHash !== "string" || !/^[0-9a-f]{16}$/.test(documentContentHash)) return null;
  if (typeof dirty !== "boolean" || typeof frozen !== "boolean") return null;
  return { canvasWidth, canvasHeight, layerCount, activeLayerIndex, revision, documentContentHash, dirty, frozen };
}

/** 产物摘要（bytes 与摘要分离；此处只声明身份与大小）。 */
export type PhotocraftArtifactSummary = {
  role: "project" | "output";
  byteLength: number;
  /** 字节 sha256（64 位小写 hex）。 */
  sha256: string;
  contentType: string;
};

/** 导出结果：同一冻结修订的工程与合成 PNG。 */
export type PhotocraftExportResult = {
  requestId: string;
  /** 冻结修订号；与保存请求一致才接受。 */
  revision: number;
  documentContentHash: string;
  canvasWidth: number;
  canvasHeight: number;
  artifacts: PhotocraftArtifactSummary[];
};

/** 严格解析导出结果（含产物配对与上限校验）。 */
export function decodeExportResult(
  input: unknown
): { ok: true; value: PhotocraftExportResult } | { ok: false; code: PhotocraftRejection; message: string } {
  if (!isJsonObject(input)) return { ok: false, code: "invalid-message", message: "exportResult 必须是对象" };
  const { revision, documentContentHash, canvasWidth, canvasHeight } = input;
  if (!isNonNegativeInteger(revision)) return { ok: false, code: "invalid-message", message: "exportResult 缺少合法 revision" };
  if (typeof documentContentHash !== "string" || !/^[0-9a-f]{16}$/.test(documentContentHash)) {
    return { ok: false, code: "invalid-message", message: "exportResult 文档内容 hash 非法" };
  }
  if (!isNonNegativeInteger(canvasWidth) || !isNonNegativeInteger(canvasHeight) || !isCanvasSize(canvasWidth, canvasHeight)) {
    return { ok: false, code: "size-exceeded", message: "exportResult 画布尺寸非法或超限" };
  }
  if (!Array.isArray(input.artifacts)) return { ok: false, code: "invalid-message", message: "exportResult 缺少产物" };
  const artifacts: PhotocraftArtifactSummary[] = [];
  let project: PhotocraftArtifactSummary | null = null;
  let output: PhotocraftArtifactSummary | null = null;
  for (const raw of input.artifacts) {
    const artifact = decodeArtifactUnknown(raw);
    if (!artifact) return { ok: false, code: "invalid-message", message: "exportResult 产物摘要非法" };
    if (artifact.role === "project") {
      if (project) return { ok: false, code: "invalid-message", message: "exportResult 含重复工程产物" };
      project = artifact;
    } else {
      if (output) return { ok: false, code: "invalid-message", message: "exportResult 含重复输出产物" };
      output = artifact;
    }
    artifacts.push(artifact);
  }
  // 配对：工程与 PNG 必须来自同一冻结修订，缺一不可（不允许拼接两次导出）。
  if (!project || !output) {
    return { ok: false, code: "invalid-message", message: "exportResult 必须同时包含工程与合成输出" };
  }
  return {
    ok: true,
    value: {
      requestId: typeof input.requestId === "string" ? input.requestId : "",
      revision,
      documentContentHash,
      canvasWidth,
      canvasHeight,
      artifacts
    }
  };
}

function decodeArtifactUnknown(input: unknown): PhotocraftArtifactSummary | null {
  if (!isJsonObject(input)) return null;
  if (input.role !== "project" && input.role !== "output") return null;
  if (!isNonNegativeInteger(input.byteLength) || input.byteLength === 0) return null;
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) return null;
  const contentType = typeof input.contentType === "string" ? input.contentType : "";
  if (contentType.length === 0 || contentType.length > 120) return null;
  if (input.role === "project" && input.byteLength > IMAGE_PROJECT_LIMITS.maxProjectBytes) return null;
  return { role: input.role, byteLength: input.byteLength, sha256: input.sha256, contentType };
}

function isCanvasSize(width: unknown, height: unknown): boolean {
  if (!isNonNegativeInteger(width) || !isNonNegativeInteger(height)) return false;
  if (width < 1 || height < 1) return false;
  if (width > IMAGE_PROJECT_LIMITS.maxCanvasSide || height > IMAGE_PROJECT_LIMITS.maxCanvasSide) return false;
  return width * height <= IMAGE_PROJECT_LIMITS.maxCanvasPixels;
}
