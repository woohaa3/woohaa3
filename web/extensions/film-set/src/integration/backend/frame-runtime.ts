/**
 * 片场内容帧端口实现（`ContentFrameRuntime`）：预览帧、历史缩略图帧与渲染身份判定。
 *
 * `canvas-service` 只依赖 `@woohaa3/contracts` 里的端口类型；本实现由 backend 宿主在装配时注入，
 * 片场领域逻辑（解码、运动编译、原生媒体帧）留在扩展内。
 */
import { decodeFilmSetNodeData, isFilmSetNode, type ContentFrameRuntime } from "@woohaa3/contracts";
import { prepareFilmSetHistoryFrame } from "../../preview/backend/history-frame.js";
import { prepareFilmSetPreviewFrame } from "../../preview/backend/preview-frame.js";
import { previewIdentityMatches } from "../../preview/backend/preview-identity.js";

export const filmSetFrameRuntime: ContentFrameRuntime = {
  matches: (nodeType, data) => isFilmSetNode(nodeType, data),
  async preparePreviewFrame(input) {
    const decoded = decodeFilmSetNodeData(input.data);
    if (!decoded.ok) return { ok: false, code: "invalid-film-set", message: decoded.reason };
    return prepareFilmSetPreviewFrame({
      nodeId: input.nodeId,
      node: input.node,
      animation: decoded.value,
      assets: input.assets,
      ...(input.clipId !== undefined ? { clipId: input.clipId } : {}),
      timeSeconds: input.timeSeconds,
      ...(input.read ? { read: input.read } : {})
    });
  },
  prepareHistoryFrame: (input) =>
    prepareFilmSetHistoryFrame({
      nodeId: input.nodeId,
      definition: input.payload,
      assets: input.assets,
      ...(input.read ? { read: input.read } : {})
    }),
  identityMatches: (before, after, clipId) => previewIdentityMatches(before, after, clipId)
};
