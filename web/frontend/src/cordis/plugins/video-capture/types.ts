/**
 * 视频 dialogs 的会话级类型契约
 * （change: port-video-editing-dialogs，任务 2.x / 3.x；design D2/D3/D4/D6/D7/D9）。
 *
 * 这些类型只描述 dialog session 边界：稳定视频身份 + 同源播放 URL（由 Media Remote 在
 * 打开时解析，只在 session 内存在）、session 内捕获帧 Blob，以及一次性回传的 intents。
 * canonical 状态只保存稳定媒体身份（由 `@woohaa3/contracts` 的 video-edit contract 强制）。
 */
import type { VideoEditIntent } from "@woohaa3/contracts";

/** dialog 打开时注入的稳定视频身份与会话播放地址。 */
export type VideoDialogPayload = {
  /** 稳定视频资产 id（canonical）。 */
  videoAssetId: string;
  /** 稳定 storageKey（canonical）。 */
  videoStorageKey: string;
  /** 同源可播放 URL；由 Media Remote 从 canonical asset 解析，仅 session 内使用。 */
  videoUrl: string;
  /** 可选 poster（同源稳定 URL）。 */
  posterUrl?: string;
  /** 视频标题/来源节点标签（展示用）。 */
  title?: string;
  /** 目标 `edit_video` 节点 id（用于导入帧/回传 intents）。 */
  targetNodeId: string;
  /** 打开编辑 dialog 时的初始 intents（草稿副本）。 */
  initialIntents?: readonly VideoEditIntent[];
  /** 预选的 intent id（重开某个 chip）。 */
  initialIntentId?: string;
};

/** 会话内的一帧捕获结果。 */
export type CapturedFrame = {
  blob: Blob;
  timeSeconds: number;
};

/** 截帧 dialog 中一帧的 session 记录（含 object URL 与选择态）。 */
export type CapturedFrameEntry = CapturedFrame & {
  id: string;
  /** session object URL（仅展示；关闭/移除时 revoke）。 */
  url: string;
  selected: boolean;
};

/** 逐项上传/导入结果（用于部分失败与幂等重试语义）。 */
export type FrameAddReceipt = {
  /** 稳定 operation identity（同一帧重试复用）。 */
  frameId: string;
  timeSeconds: number;
  ok: boolean;
  /** 成功时的稳定节点 id。 */
  nodeId?: string;
  /** 成功时的稳定资产 id。 */
  assetId?: string;
  /** 失败时的安全错误摘要。 */
  error?: string;
};

/** 截帧 dialog 的添加动作契约（由 Plugin 注入实现）。 */
export type FrameAddAction = (input: {
  instanceId: string;
  targetNodeId: string;
  frames: readonly CapturedFrameEntry[];
  signal?: AbortSignal;
}) => Promise<readonly FrameAddReceipt[]>;

/** 编辑 dialog 的确认动作契约（由 Plugin 注入实现：稳定化 preview 后一次性回传）。 */
export type VideoEditConfirmAction = (input: {
  instanceId: string;
  intents: readonly VideoEditIntent[];
  /** intentId → 标记图 PNG Blob（仅 session 内）。Plugin 负责上传稳定化。 */
  previews: ReadonlyMap<string, Blob>;
}) => Promise<{ ok: true } | { ok: false; error: string }>;
