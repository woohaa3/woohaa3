import type { ImageDirectorSceneReceipt, ImageDirectorSceneRequest, ImageDirectorSceneReservation, ImageDirectorSceneStage } from "@woohaa3/contracts";
import { AGENT_CONVERSATION_BASE_PATH, CANVAS_API_BASE_PATH } from "./paths.js";
import type { ApplicationRemoteTransport } from "../contract/remote.js";

export type ImageDirectorStatus = { requestId: string; stage: ImageDirectorSceneStage; parentTurnId?: string; conversationId?: string; input?: ImageDirectorSceneRequest; reservation?: ImageDirectorSceneReservation; receipt?: ImageDirectorSceneReceipt; revision?: number; error?: string; canRetryPlacement?: boolean; canRetrySave?: boolean };

/** 图片场景创建的同源路由（Application 承载，复用会话宿主前缀）。 */
const imageDirectorScenePath = `${AGENT_CONVERSATION_BASE_PATH}/image-director-scenes`;

export function createImageDirectorRemote(transport: ApplicationRemoteTransport) {
  return {
    async status(canvasId: string, requestId: string) {
      const query = `canvasId=${encodeURIComponent(canvasId)}&requestId=${encodeURIComponent(requestId)}`;
      return transport.request({ method: "GET", path: `${imageDirectorScenePath}?${query}` });
    },
    async retry(canvasId: string, requestId: string) {
      return transport.request({ method: "POST", path: `${imageDirectorScenePath}/retry-placement`, body: { canvasId, requestId } });
    },
    async retrySave(canvasId: string, requestId: string) {
      return transport.request({ method: "POST", path: `${imageDirectorScenePath}/retry-save`, body: { canvasId, requestId } });
    },
    async refreshCapture(canvasId: string, cameraId: string) {
      return transport.request({ method: "POST", path: `${CANVAS_API_BASE_PATH}/${encodeURIComponent(canvasId)}/captures-refresh`, body: { cameraId } });
    }
  };
}
