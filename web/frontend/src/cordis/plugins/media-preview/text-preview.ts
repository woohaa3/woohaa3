import type { ServerCanvas } from "@woohaa3/contracts";
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";

export const TEXT_PREVIEW_DIALOG_ID = "text-preview";

export const textPreviewDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  validatePayload: objectPayload<{ nodeId: string }>("text-preview", (value) =>
    typeof value.nodeId === "string" && value.nodeId ? { nodeId: value.nodeId } : null
  )
};

export function resolveTextPreview(canvas: ServerCanvas | null, nodeId: string) {
  const node = canvas?.document.nodes.find((item) => item.id === nodeId);
  if (!canvas || node?.type !== "text") return null;
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  const assetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  const asset = canvas.assets.find((item) => item.id === assetId && item.mediaKind === "text" && item.status === "ready");
  const result = data?.result && typeof data.result === "object" ? data.result as Record<string, unknown> : null;
  const text = typeof asset?.text === "string" ? asset.text : typeof result?.text === "string" ? result.text : typeof data?.prompt === "string" ? data.prompt : "";
  if (!text.trim()) return null;
  return { title: typeof data?.title === "string" && data.title ? data.title : asset?.title || "文本内容", text };
}
