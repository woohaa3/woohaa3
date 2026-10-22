/**
 * 图片工程本地会话（纯逻辑）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.3/3.7 / design D2/D3/D7）。
 *
 * 无 DOM/React 依赖：持有工程会话生命周期、进入基线、净变化判定、v1 标注 → 工程转换计划与
 * 只读/失败状态。取景、选区、活动层、工具偏好与撤销栈**不**属于内容，不参与净变化。
 *
 * 关键约束（design D2/D7）：
 * - 一个节点由一个 owner 管理：纯媒体查看、旧标注会话与工程会话互斥，同一时刻只有一个活动分支；
 * - 工程默认只读查看 PNG；只有显式「打开工程」才进入可编辑工程分支，且要求工程对象与引擎/
 *   格式版本都可用；
 * - v1 标注 → 工程转换只在**本地**进行：超出首期上限时回退旧标注，不静默压平；
 * - 未保存标注切换为工程时，先建立包含当前标注的基线，保留原净变化；
 * - 项目禁止旧标注保存分支（`canSaveAnnotation` 恒为 false）；
 * - 退出/取消/释放后旧代际结果不得再写入。
 */
import {
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_LIMITS,
  SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  fnv1a64Hex,
  imageEditHasNetChange,
  imageProjectContentHash,
  isImageProjectDocument,
  type ImageEditDocument,
  type ImageEditShape,
  type ImageProjectContent,
  type LegacyImageEditDocument
} from "@woohaa3/contracts";
import type { PhotocraftContentState } from "@woohaa3/contracts";

/** 工程会话阶段。 */
export type ProjectSessionPhase =
  | "view"          // 纯媒体/只读查看当前 PNG
  | "annotation"    // 旧标注会话（v1）
  | "loading"       // 正在按需加载编辑器产物
  | "editing"       // 工程可编辑
  | "freezing"      // 冻结修订导出中
  | "saving"        // 等待服务端回执
  | "readonly-project" // 工程只读（缺失/过新/加载失败）
  | "error";

/** 进入工程会话前解析到的当前权威内容。 */
export type ProjectSessionInput = {
  nodeId: string;
  baseAssetId: string;
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  /** 当前编辑定义（v1 标注或工程；无则 null）。 */
  edit: ImageEditDocument | null;
  /** 工程对象是否可解析（storageKey 存在）。 */
  projectObjectAvailable?: boolean;
  /** 工程是否因过新/不匹配而不可编辑。 */
  projectIncompatible?: boolean;
};

/** v1 标注 → 工程转换计划（本地转换，不重依赖来源 URL）。 */
export type V1ConversionPlan =
  | { ok: true; content: ImageProjectContent; annotations: number }
  | { ok: false; reason: "shape-limit" | "canvas-limit" };

export class ProjectSession {
  readonly nodeId: string;
  private input: ProjectSessionInput;
  private phase: ProjectSessionPhase;
  private readonly baseline: ImageEditDocument | null;
  private baselineContentHash: string | null;
  private currentContentState: PhotocraftContentState | null = null;
  private currentHash: string | null;
  private errorMessage: string | null = null;
  private readonly annotations: ImageEditShape[];

  constructor(input: ProjectSessionInput) {
    this.nodeId = input.nodeId;
    this.input = input;
    this.baseline = input.edit;
    this.annotations = input.edit && !isImageProjectDocument(input.edit) ? [...input.edit.shapes] : [];
    // 进入基线：工程用文档内容 hash；v1 标注用规范转换后的内容指纹；纯媒体为 null。
    this.baselineContentHash = baselineHashOf(input);
    this.currentHash = this.baselineContentHash;
    this.phase = initialPhase(input);
  }

  currentPhase(): ProjectSessionPhase {
    return this.phase;
  }

  /** 进入基线内容指纹（用于净变化；纯媒体为 null）。 */
  baselineContent(): string | null {
    return this.baselineContentHash;
  }

  /**
   * 文档内容 hash 是否可用（工程分支）。纯媒体/v1 在转换前无法直接给出工程内容 hash。
   */
  contentHash(): string | null {
    return this.currentHash;
  }

  /** 当前是否可进入工程编辑（工程可用且版本匹配）。 */
  canOpenProject(): boolean {
    return this.phase !== "readonly-project" && this.phase !== "error";
  }

  /**
   * 项目禁止旧标注保存分支（design D7）。
   *
   * 一旦节点承载工程定义，旧标注保存路径必须关闭：否则会丢失工程。
   */
  canSaveAnnotation(): boolean {
    return this.phase === "annotation";
  }

  /** 是否可以保存（存在净变化且未在导出中）。 */
  isDirty(): boolean {
    if (this.phase === "editing" || this.phase === "readonly-project") {
      return this.currentHash !== null && this.currentHash !== this.baselineContentHash;
    }
    if (this.phase === "annotation") {
      return imageEditHasNetChange(this.baseline, this.annotationDocument());
    }
    return false;
  }

  /** 旧标注分支的当前定义（供 v1 保存编排；工程分支返回 null）。 */
  annotationDocument(): LegacyImageEditDocument | null {
    if (this.phase !== "annotation") return null;
    return {
      version: "woohaa-image-edit-v1",
      baseAssetId: this.input.baseAssetId,
      sourceWidth: this.input.sourceWidth,
      sourceHeight: this.input.sourceHeight,
      shapes: this.annotations.map((shape) => ({ ...shape, points: shape.points.map((point) => ({ ...point })) }))
    };
  }

  /**
   * 应用一次编辑器上报的内容状态（含文档内容 hash 与修订号）。
   *
   * 上报内容状态说明编辑器已就绪并可编辑：`loading`（已有工程）与 `view`（首次转为工程）
   * 都进入 `editing`；只读分支不因为收到状态就变成可写。
   */
  applyContentState(state: PhotocraftContentState): void {
    this.currentContentState = state;
    this.currentHash = state.documentContentHash;
    if (this.phase === "loading" || this.phase === "view") this.phase = "editing";
  }

  /** 冻结导出开始：进入 freezing（禁止内容写入）。 */
  beginFreeze(): void {
    if (this.phase !== "editing") throw new Error("当前状态不能冻结导出");
    this.phase = "freezing";
  }

  /** 冻结取消/失败恢复编辑（保留现场）。 */
  resumeEditing(): void {
    if (this.phase === "freezing" || this.phase === "saving") this.phase = "editing";
  }

  /** 保存提交后进入等待回执。 */
  beginSave(): void {
    if (this.phase !== "freezing") throw new Error("未冻结修订不能保存");
    this.phase = "saving";
  }

  /**
   * 保存成功后推进基线（design D7：应用成功后才推进，失败保留草稿）。
   *
   * 内容已权威提交但历史待登记时同样推进：重试不会重复归档。
   */
  commitBaseline(contentHash: string): void {
    this.baselineContentHash = contentHash;
    this.currentHash = contentHash;
    this.phase = "editing";
    this.errorMessage = null;
  }

  /**
   * 把当前内容建立为进入基线（**打开 ≠ 修改**）。
   *
   * 只用于刚打开已核验工程、原图或刚完成 v1 转换。建立后没有编辑就退出不会产生版本。
   * 旧工程可能使用旧版像素指纹，因此净变化比较以实际加载内容为准；服务端并发核验
   * 仍使用进入时捕获的权威描述符身份，不随本地指纹迁移。
   */
  establishBaseline(): void {
    if (this.currentHash !== null) {
      this.baselineContentHash = this.currentHash;
      this.errorMessage = null;
    }
  }

  /**
   * v1 标注已在本地转换为工程图层：会话切到工程分支。
   *
   * 切换后 `annotationDocument()` 返回 null、`canSaveAnnotation()` 为 false，退出聚焦不会再写
   * v1 定义覆盖工程（design D7）。只有转换成功才可调用；失败回退时保持 `annotation` 不变。
   */
  beginProjectConversion(): void {
    if (this.phase === "annotation") this.phase = "editing";
  }

  /** 保存失败：保留现场并回到编辑（不清空工作区）。 */
  failSave(message: string): void {
    this.errorMessage = message;
    if (this.phase === "saving" || this.phase === "freezing") this.phase = "editing";
    else this.phase = "error";
  }

  errorState(): string | null {
    return this.errorMessage;
  }

  contentState(): PhotocraftContentState | null {
    return this.currentContentState;
  }

  /** 进入基线保留的标注数量（切换为工程会话后仍可显示原净变化来源）。 */
  annotationCount(): number {
    return this.annotations.length;
  }

  /** 只读理由（工程缺失/过新/加载失败）；可查看 PNG。 */
  readOnlyReason(): string | null {
    if (this.phase === "readonly-project") {
      if (this.input.projectIncompatible) return "工程版本与当前编辑器不匹配，仅可查看合成图";
      if (this.input.projectObjectAvailable === false) return "工程对象缺失，仅可查看合成图";
      return "工程暂不可编辑，仅可查看合成图";
    }
    return null;
  }

  /** 释放会话：后续旧代际结果一律忽略（由桥的 generation 校验兜底）。 */
  dispose(): void {
    this.phase = "view";
    this.currentContentState = null;
  }

  /**
   * v1 标注 → 工程转换计划（本地转换，design D7）。
   *
   * 每个 shape 转换为一个像素层，背景层保留原图 alpha；超出首期上限时**不压平**，
   * 返回原因由调用方回退旧标注分支。
   */
  planV1Conversion(): V1ConversionPlan {
    const width = this.input.sourceWidth;
    const height = this.input.sourceHeight;
    if (!isPositive(width) || !isPositive(height) || width > IMAGE_PROJECT_LIMITS.maxCanvasSide || height > IMAGE_PROJECT_LIMITS.maxCanvasSide) {
      return { ok: false, reason: "canvas-limit" };
    }
    if (width * height > IMAGE_PROJECT_LIMITS.maxCanvasPixels) return { ok: false, reason: "canvas-limit" };
    // 背景层 + 每 shape 一层；超过首期层数上限时回退（不静默压平）。
    if (this.annotations.length + 1 > IMAGE_PROJECT_LIMITS.maxLayers) return { ok: false, reason: "shape-limit" };
    const background: ImageProjectContent["layers"][number] = {
      id: "background",
      name: "背景",
      kind: "pixel",
      visible: true,
      opacity: 1,
      blend: "normal",
      transform: identityTransform(width, height),
      mask: null,
      pixel: { sourceAssetId: this.input.baseAssetId, contentHash: hashOrZero("background") },
      text: null,
      adjustment: null
    };
    const layers = [background];
    this.annotations.forEach((shape, index) => {
      layers.push({
        id: `annotation-${index + 1}`,
        name: `标注 ${index + 1}`,
        kind: "pixel",
        visible: true,
        opacity: 1,
        blend: "normal",
        transform: identityTransform(width, height),
        mask: null,
        pixel: { sourceAssetId: null, contentHash: shapeContentHash(shape) },
        text: null,
        adjustment: null
      });
    });
    const content: ImageProjectContent = {
      canvasWidth: width,
      canvasHeight: height,
      layers
    };
    // 指纹必须可计算，否则转换无意义（回退旧标注）。
    if (imageProjectContentHash(content) === null) return { ok: false, reason: "canvas-limit" };
    return { ok: true, content, annotations: this.annotations.length };
  }

  /** 转换是否被首期上限拒绝（回旧标注，不静默压平）。 */
  conversionFallbackReason(): "shape-limit" | "canvas-limit" | null {
    const plan = this.planV1Conversion();
    return plan.ok ? null : plan.reason;
  }
}

function initialPhase(input: ProjectSessionInput): ProjectSessionPhase {
  if (input.projectIncompatible) return "readonly-project";
  if (input.edit && isImageProjectDocument(input.edit)) {
    // 过新/不匹配的引擎或格式版本：只读查看 PNG，不进入编辑。
    if (!isSupportedProject(input.edit)) return "readonly-project";
    // 工程定义存在但对象不可解析：只读查看 PNG，不静默建立替代工程。
    if (input.projectObjectAvailable === false) return "readonly-project";
    return "loading";
  }
  if (input.edit) return "annotation";
  return "view";
}

/** 进入基线内容指纹：工程用文档内容 hash；v1 用规范转换后的内容指纹；纯媒体为 null。 */
function baselineHashOf(input: ProjectSessionInput): string | null {
  if (!input.edit) return null;
  if (isImageProjectDocument(input.edit)) {
    if (!isSupportedProject(input.edit)) return null;
    return input.edit.documentContentHash;
  }
  // v1 标注：以「背景 + 每 shape 一层」的规范内容指纹为基线，使转换初始化不产生净变化。
  const width = input.sourceWidth;
  const height = input.sourceHeight;
  if (!isPositive(width) || !isPositive(height)) return null;
  const layers: ImageProjectContent["layers"] = [
    {
      id: "background",
      name: "背景",
      kind: "pixel",
      visible: true,
      opacity: 1,
      blend: "normal",
      transform: identityTransform(width, height),
      mask: null,
      pixel: { sourceAssetId: input.baseAssetId, contentHash: hashOrZero("background") },
      text: null,
      adjustment: null
    }
  ];
  input.edit.shapes.forEach((shape, index) => {
    layers.push({
      id: `annotation-${index + 1}`,
      name: `标注 ${index + 1}`,
      kind: "pixel",
      visible: true,
      opacity: 1,
      blend: "normal",
      transform: identityTransform(width, height),
      mask: null,
      pixel: { sourceAssetId: null, contentHash: shapeContentHash(shape) },
      text: null,
      adjustment: null
    });
  });
  return imageProjectContentHash({ canvasWidth: width, canvasHeight: height, layers });
}

/** 工程定义是否受支持的引擎/格式版本。 */
export function isSupportedProject(doc: { engineVersion: string; formatVersion: number }): boolean {
  return (
    SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS.includes(doc.engineVersion) &&
    SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(doc.formatVersion)
  );
}

/** 工程对象 MIME 判定（宿主上传前置校验）。 */
export function isProjectContentType(contentType: string): boolean {
  return contentType === IMAGE_PROJECT_CONTENT_TYPE;
}

function identityTransform(width: number, height: number): ImageProjectContent["layers"][number]["transform"] {
  void width;
  void height;
  return { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false };
}

/** shape → 稳定内容指纹（同一 shape 在不同会话/重放中映射同一 hash）。 */
function shapeContentHash(shape: ImageEditShape): string {
  const points = shape.points.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`).join(";");
  return hashOrZero(`${shape.tool}|${shape.color}|${shape.widthInSourcePixels}|${points}`);
}

/**
 * 16 位 hex 内容指纹。
 *
 * 直接复用契约层的 `fnv1a64Hex`：它按 **UTF-16 code unit** 迭代（`charCodeAt`），与 Rust
 * `identity.rs` 的 `encode_utf16` 镜像逐字节一致。自己再写一份 UTF-8 版本会让同一 shape
 * 在宿主与编辑器之间得到不同指纹。
 */
function hashOrZero(text: string): string {
  return fnv1a64Hex(text);
}

function isPositive(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
