/**
 * 转换生成端口与媒体读取/抽帧端口的公共契约
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1–2.3 / design D2/D6）。
 *
 * 纯类型 / JSON-only：让 **拥有执行器的扩展**（ChatGPT、语言 Provider）实现生成端口，而
 * **拥有媒体解码的侧**（film-set / Media）实现读取与抽帧端口，两侧都不 import 对方的私有
 * service。Canvas 权威服务按这些契约注入并把冻结来源交给生成器。
 */
import type { ServerCanvas } from "../domain/types.js";
import type {
  FilmSetConversionAdapterCapabilities
} from "./capabilities.js";
import type {
  FilmSetConversionErrorCode,
  FilmSetConversionFrozenSource,
  FilmSetConversionRepair,
  FilmSetConversionSettings,
  FilmSetConversionSourceKind,
  FilmSetConversionStep
} from "./types.js";

/**
 * 有界帧（服务端 CPU 解码产出，覆盖所选范围；`timestampSeconds` 来自真实媒体时间轴）。
 */
export type FilmSetConversionFrame = {
  timestampSeconds: number;
  bytes: Uint8Array;
  contentType: string;
};

/**
 * 媒体读取/抽帧端口（由 Media 能力实现）。
 *
 * - `readAsset`：读取稳定资产原始字节（图片原文件、视频原文件），用于真实视觉输入；
 * - `readVideoFrames`：模型不支持原生视频时，在服务端于所选范围内按预算抽取有时间戳、覆盖
 *   首尾与主要变化的帧组；`maxFrames` 来自模型能力声明，调用方 MUST NOT 静默截断所选范围
 *   （超出预算由调用方拒绝并要求用户重选范围）。
 *
 * 两者都只接触稳定资产（不接触远程 URL），并在失败时给出可读原因。
 */
export type FilmSetConversionMediaReader = {
  /**
   * 读取稳定资产原始字节。
   *
   * `canvasId` 可选：远端画布的素材只在托管存储里（`<canvasId>/media/<key>`），
   * 调用方知道所属画布时必须传，否则会按无作用域读主存储而失败；省略表示与画布无关。
   */
  readAsset(storageKey: string, canvasId?: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  readVideoFrames?(input: {
    storageKey: string;
    /** 素材所属画布（可选，语义同 `readAsset`）；抽帧前读取原件也必须带对作用域。 */
    canvasId?: string;
    range?: { startSeconds: number; endSeconds: number };
    durationSeconds?: number;
    maxFrames: number;
  }): Promise<FilmSetConversionFrame[]>;
};

/** 冻结来源 + 资产解析结果（生成器据 storageKey 读取真实内容）。 */
export type FilmSetConversionMediaInput = {
  /** 来源稳定资产的 storageKey（图片/视频）。 */
  storageKey: string;
  contentType: string;
};

/** 生成端口输入：冻结来源、解析后的媒体引用、实际模型身份与能力。 */
export type FilmSetConversionGenerationInput = {
  /** Public adapter messages, persisted by the trusted host parent turn. */
  emit?: (event: import("../../extension/assistant/conversation.js").AgentConversationAdapterEvent) => void;
  canvasId: string;
  requestId: string;
  frozenSource: FilmSetConversionFrozenSource;
  title: string;
  settings: FilmSetConversionSettings;
  /** 本次实际使用的转换模型身份（服务端已解析）。 */
  modelKey: string;
  /** 该模型声明的能力（服务端已校验；生成器据此选择原生视频或抽帧）。 */
  capabilities?: FilmSetConversionAdapterCapabilities;
  /** 权威画布（只读；生成器用它校验媒体资产引用）。 */
  canvas: ServerCanvas;
  /** 已解析的媒体输入；媒体来源必有，3D 复制不使用生成端口。 */
  media?: FilmSetConversionMediaInput;
  /** 上一次候选被完整校验拒绝时的修复指引；缺省表示首次生成。 */
  repair?: FilmSetConversionRepair;
  /** 请求方可信主体（宿主解析，非请求体）；生成器用它解析个人授权/owner。 */
  subject?: string;
  /**
   * 宿主在 HTTP 边界**已解析**的转换 owner（含提供方前缀，如 `principal:` / `local:`），
   * 由提供方的 `resolveOwner` 产出；生成器**优先**使用它，缺省时才回退到按 `subject` 解析
   * （见 change 2026-10-13 的本地开发会话放通）。
   */
  ownerId?: string;
  signal: AbortSignal;
  /** 真实阶段回调：生成器报告 准备素材/分析内容/生成片场。 */
  onStep?: (step: FilmSetConversionStep) => void;
};

/** 生成端口结果：模型完成但未提交仍算 running（由服务端继续走校验并提交）。 */
export type FilmSetConversionGenerationResult =
  | { ok: true; candidate: unknown; note?: string }
  | { ok: false; code: FilmSetConversionErrorCode; message: string; retryable?: boolean };

export type FilmSetConversionGenerator = (
  input: FilmSetConversionGenerationInput
) => Promise<FilmSetConversionGenerationResult>;

/** 哪些来源种类需要在调用上游之前做能力门禁（model3d 直接复制不需要）。 */
export function filmSetConversionNeedsModel(kind: FilmSetConversionSourceKind): boolean {
  return kind !== "model3d";
}
