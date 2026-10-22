/**
 * 视频 dialogs 的 definition（payload 校验与默认策略）
 * （change: port-video-editing-dialogs，任务 2.1 / 4.1；design D2/D7）。
 *
 * 纯数据 + 纯校验，不 import React。payload 只携带稳定视频身份与同源播放 URL、
 * 目标节点 id 与初始 intents；任何临时 URL/Blob 都不经过 payload 进入规范状态。
 */
import { isValidStorageKey } from "@woohaa3/contracts";
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";
import type { VideoDialogPayload } from "./types.js";

/** 校验并规范化视频 dialog payload。 */
export function validateVideoDialogPayload(payload: unknown): { ok: true; payload: VideoDialogPayload } | { ok: false; error: string } {
  return objectPayload<VideoDialogPayload>("video-dialog", (value) => {
    const videoAssetId = typeof value.videoAssetId === "string" && value.videoAssetId !== "" ? value.videoAssetId : null;
    if (!videoAssetId) return null;
    const videoStorageKey = value.videoStorageKey;
    if (!isValidStorageKey(videoStorageKey)) return null;
    const videoUrl = typeof value.videoUrl === "string" && value.videoUrl !== "" ? value.videoUrl : null;
    if (!videoUrl) return null;
    const targetNodeId = typeof value.targetNodeId === "string" && value.targetNodeId !== "" ? value.targetNodeId : null;
    if (!targetNodeId) return null;
    const normalized: VideoDialogPayload = { videoAssetId, videoStorageKey, videoUrl, targetNodeId };
    if (typeof value.posterUrl === "string" && value.posterUrl !== "") normalized.posterUrl = value.posterUrl;
    if (typeof value.title === "string" && value.title !== "") normalized.title = value.title;
    if (Array.isArray(value.initialIntents)) {
      normalized.initialIntents = value.initialIntents as VideoDialogPayload["initialIntents"];
    }
    if (typeof value.initialIntentId === "string" && value.initialIntentId !== "") {
      normalized.initialIntentId = value.initialIntentId;
    }
    return normalized;
  })(payload);
}

/** 截帧 dialog：不可 singleton（允许从不同节点并行打开），可隐式关闭。 */
export const frameCaptureDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  variant: "media",
  size: "lg",
  validatePayload: validateVideoDialogPayload
};

/** 编辑 dialog：不可 singleton（重开同一个 chip 也创建独立草稿），可隐式关闭。 */
export const videoEditDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  variant: "media",
  size: "fullscreen",
  validatePayload: validateVideoDialogPayload
};
