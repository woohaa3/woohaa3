/**
 * 通用内容录制端口的**宿主 ↔ 扩展**契约
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 2.1 / design D3）。
 *
 * 分层：
 * - **宿主**（canvas-service / backend）只依赖本文件的接口：它负责生命周期、调度、上传与权威提交；
 * - **扩展**（片场）实现本文件：它负责 clip/媒体播放语义、Scene IR/motion 编译，以及提交前的
 *   版本校验与结果命令构造；
 * - 宿主**不 import** 任何扩展实现；缺失该端口时录制能力明确返回 `recording-unavailable`。
 *
 * 本文件只有类型与稳定错误码，没有实现，也不依赖 DOM/Node。
 */
import type { CanvasCommand } from "./commands.js";

/** 录制用途：参考录制可因源变化变 stale；显式导出固定提交时版本。 */
export type ContentRecordingPurpose = "reference" | "export";

/**
 * 录制请求：宿主在**权威画布**上校验后原样传给扩展。
 *
 * 只接受稳定身份 + 用途 + profile；不传像素、不传播放状态、不传 DOM 句柄。
 */
export type ContentRecordingRequest = {
  /** 幂等请求 id：同一 id 的重试不得再创建一个任务。 */
  requestId: string;
  purpose: ContentRecordingPurpose;
  canvasId: string;
  /** 内容节点（片场节点）。 */
  nodeId: string;
  /** 目标片段；参考录制与显式导出都必须指定。 */
  clipId: string;
  /** 调用方期望的 profile key；扩展可拒绝不支持的 profile。 */
  profileKey: string;
};

/**
 * 冻结后的输入：**一次性**编译产物，worker 只消费它，不执行 JS、不读任意路径。
 *
 * 字段名与 `api/gen/es/woohaa/recording/v1alpha1/recording_pb.ts` 的 `RecordingSnapshot`
 * 对齐；宿主负责把这里的 JSON 投影成 protobuf JSON 发送给执行器。
 */
export type ContentRecordingSnapshot = {
  schemaVersion: string;
  compilerVersion: string;
  rendererVersion: string;
  origin: {
    canvasId: string;
    nodeId: string;
    clipId: string;
    sourceIdentity: string;
    canvasRevision: number;
    /** 提交时的来源 incarnation；删除后重建同 id 不会被继承。 */
    sourceIncarnation: string;
  };
  profile: {
    profileKey: string;
    container: "mp4";
    codec: "h264";
    width: number;
    height: number;
    bitrate: number;
    fastStart: boolean;
    includeAudio: boolean;
    rendererVersion: string;
    compilerVersion: string;
    codecVersion: string;
    colorRevision: string;
  };
  timing: {
    frameRateNumer: number;
    frameRateDenom: number;
    durationNumer: number;
    durationDenom: number;
  };
  /** 规范化 Scene IR（`woohaa-model-scene-ir-v2`）。 */
  sceneIrJson: string;
  /** 编译后的动作/镜头轨道。 */
  motionJson: string;
  initialCamera: {
    azimuth: number;
    elevation: number;
    distance: number;
    focusOffset: [number, number, number];
  };
  aspect: string;
  resources: ContentRecordingResource[];
};

/** 一个稳定媒体资源；`checksum` 与 `contentType` 是权威值。 */
export type ContentRecordingResource = {
  resourceId: string;
  storageKey: string;
  checksum: string;
  contentType: string;
  sizeBytes: number;
  /** 该 clip 的局部播放映射，与可见播放规则一致。 */
  playback: {
    startTime: number;
    timeScale: number;
    looped: boolean;
    endTime: number;
    mediaDuration: number;
  };
};

/** 冻结结果：成功给出快照，失败给出稳定码。 */
export type ContentRecordingFreezeResult =
  | { ok: true; snapshot: ContentRecordingSnapshot; referenceIdentity?: { contentIdentity: string; profileKey: string } }
  | { ok: false; code: ContentRecordingErrorCode | (string & {}); message: string };

/**
 * 录制完成后的提交输入：宿主把**已校验**的成片事实交回扩展，由扩展构造规范命令。
 *
 * 扩展负责：最终版本校验（源仍在、版本仍合法）、节点位置（提交时权威布局）与 `origin`。
 */
export type ContentRecordingCommitRequest = {
  requestId: string;
  purpose: ContentRecordingPurpose;
  canvasId: string;
  nodeId: string;
  clipId: string;
  /** 冻结时的来源 incarnation；提交时必须仍匹配。 */
  sourceIncarnation: string;
  contentIdentity: string;
  profileKey: string;
  /** 扩展冻结的下游参考身份，与执行器编码规格分开。 */
  referenceIdentity?: { contentIdentity: string; profileKey: string };
  artifact: {
    storageKey: string;
    checksum: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    durationSeconds: number;
    frameRate: number;
    hasAudio: boolean;
  };
  /** 展示标题（只用于资产/节点命名，不参与身份）。 */
  title: string;
};

/** 扩展构造出的规范命令批次 + 稳定标识。 */
export type ContentRecordingCommitPlan =
  | {
      ok: true;
      /**
       * 单一原子批次：参考只 upsert 资产；显式导出同时创建资产与视频节点。
       * 宿主用固定 `commandId` 提交，重复提交必须幂等。
       */
      commands: CanvasCommand[];
      commandId: string;
      /** 预期产生的节点 id（显式导出）；参考录制为 undefined。 */
      nodeId?: string;
    }
  | { ok: false; code: ContentRecordingErrorCode | (string & {}); message: string };

/**
 * 稳定错误码。宿主与 UI 按这些码给出具体原因，不做「换个浏览器试试」式误导。
 *
 * - `recording-unavailable`：宿主未装配录制端口（浏览器-only 或扩展未启用）；
 * - `recording-unsupported-platform`：当前平台没有本机执行器；
 * - `recording-executor-unavailable`：本机执行器未注册/已失联；
 * - `recording-executor-software-gpu`：只有软件渲染适配器，不满足渲染验收；
 * - `recording-capability-missing`：缺解码/编码/协议能力；
 * - `recording-profile-unsupported`：请求的录制规格与片段不匹配；
 * - `recording-source-invalid`：源节点/片段/脚本/时长/权限不合法；
 * - `recording-source-changed`：冻结后源变了（参考录制 → stale）；
 * - `recording-source-removed`：源节点/片段已删除（阻止提交）；
 * - `recording-budget-exceeded`：素材/帧数/字节超预算；
 * - `recording-cancelled` / `recording-too-late`：取消裁定结果；
 * - `recording-commit-rejected`：权威保存被拒绝。
 */
export type ContentRecordingErrorCode =
  | "recording-unavailable"
  | "recording-unsupported-platform"
  | "recording-executor-unavailable"
  | "recording-executor-software-gpu"
  | "recording-capability-missing"
  | "recording-profile-unsupported"
  | "recording-source-invalid"
  | "recording-source-changed"
  | "recording-source-removed"
  | "recording-budget-exceeded"
  | "recording-cancelled"
  | "recording-too-late"
  | "recording-commit-rejected";

/** 宿主必须能识别的具体不可用原因（用于 `describeUnavailable`）。 */
export type ContentRecordingUnavailableReason =
  | "no-runtime"
  | "unsupported-platform"
  | "no-executor"
  | "software-gpu"
  | "missing-codec"
  | "protocol-mismatch";

/**
 * 内容录制端口：由拥有该内容领域的扩展实现，宿主经 `CanvasContentRuntime.recording` 注入。
 *
 * 所有方法都必须在**权威画布**上工作：调用方给的是 canvasId，实现自己去解析 room/version；
 * 不允许从 working projection 或前端状态取输入。
 */
export type ContentRecordingRuntime = {
  /** 该节点类型是否由本扩展负责录制（宿主据此拒绝其它节点）。 */
  matches(nodeType: string, data: unknown): boolean;
  /**
   * 冻结一次自包含输入。
   *
   * 必须在已提交数据上执行：pending draft 要么等待提交，要么明确 `recording-source-invalid`。
   */
  freeze(input: ContentRecordingRequest & {
    /**
     * 来源 incarnation：由宿主按「来源对象在权威版本中的身份」给出。
     * 删除后重建同 id 必须得到不同值，旧任务据此被拒绝提交。
     */
    sourceIncarnation: string;
    /** 只读历史/预览：不得生成落库任务。 */
    readOnly?: boolean;
    /** 存在未提交 working draft：必须等待提交或明确拒绝，不能与已提交内容混合。 */
    hasPendingDraft?: boolean;
    /** 素材预算（字节）。 */
    maxResourceBytes?: number;
    maxTotalResourceBytes?: number;
    /** 稳定的权威画布快照（扩展不自己读 Y.Doc）。 */
    canvas: {
      revision: number;
      assets: readonly { id: string; storageKey?: string; checksum?: string; contentType?: string; size?: number; metadata?: unknown }[];
      /** 已解码的节点数据（由宿主提供，避免扩展依赖画布内部实现）。 */
      nodeData: unknown;
      /** Authoritative node dimensions used by the shared preview framing. */
      node?: { width?: number; height?: number };
      /** 读取稳定媒体字节（有界、经授权）。 */
      read?: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
    };
  }): Promise<ContentRecordingFreezeResult>;
  /**
   * 构造提交计划；实现必须重新校验源仍在且版本合法。
   *
   * `sourcePosition` 是**提交时**权威画布上的来源布局（显式导出用于放置右侧节点）。
   * 缺失/为 `null` 表示源已删除，实现必须拒绝而不是伪造坐标。
   */
  planCommit(
    input: ContentRecordingCommitRequest & { sourcePosition?: { x: number; y: number; width: number } | null }
  ): Promise<ContentRecordingCommitPlan>;
  /** 该用途/节点的展示标题（活动浮层与文件名用）。 */
  describe(input: { nodeData: unknown; clipId: string }): { title: string; duration: number; aspect: string };
};
