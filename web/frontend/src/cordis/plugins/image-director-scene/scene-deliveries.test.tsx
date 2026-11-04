// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { DirectorSceneDeliveries } from "./scene-deliveries.js";

it("adopts delivery and refreshes capture from the director scene after the source has been removed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = createEmptyWoohaa3ServerCanvas("director-delivery");
  canvas.document.nodes.push({ id: "director", type: "scene-area", position: { x: 0, y: 0 } }, { id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.director = { imageDirectorGeneration: { requestId: "request" } };
  canvas.nodeData.camera = { worldCamera: JSON.parse(JSON.stringify(createDefaultWorldCameraData("camera-id", "v", { u: 0, v: 0 }))) };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const receipt = { areaNodeId: "director", cameraNodeId: "camera", modelNodeIds: ["model"] };
  const request = vi.fn(async ({ path }: { path: string }) => path.includes("captures-refresh") ? { ok: false, error: "renderer unavailable" } : { ok: true, data: { requestId: "request", stage: "delivered", reservation: { nodeId: "director" }, receipt, revision: 2 } });
  const adoptImageDirector = vi.fn(async () => ({ ok: true }));
  const ctx = { applicationRemote: { transport: { request } }, canvasEdit: { adoptImageDirector } };
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<DirectorSceneDeliveries ctx={ctx as never} canvasId={canvas.id} />));
  expect(adoptImageDirector).toHaveBeenCalledWith({ canvasId: canvas.id, receipt, revision: 2, allowNew: true });
  expect(request.mock.calls.map(([input]) => input.path)).toEqual([
    "/api/agent-conversations/image-director-scenes?canvasId=director-delivery&requestId=request",
    "/api/canvases/director-delivery/captures-refresh",
  ]);
  expect(host.textContent).toBe("");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
