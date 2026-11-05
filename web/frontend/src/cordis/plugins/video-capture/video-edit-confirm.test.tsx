/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createVideoEditRenderer } from "./video-edit-dialog.js";
import type { VideoEditConfirmAction } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.each([true, false])("编辑确认结果%s遵守宿主busy关闭门禁", async (success) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as never);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let hostBusy = false;
  let closed = false;
  const onConfirm = vi.fn<VideoEditConfirmAction>(async () => success ? { ok: true as const } : { ok: false as const, error: "保存失败，请重试" });
  const Renderer = createVideoEditRenderer({ onConfirm });
  await act(async () => root.render(<Renderer
    instance={{
      instanceId: "edit-1", dialogId: "canvas-video-edit", dismissible: true, busy: false, parentInstanceId: null,
      payload: { videoAssetId: "asset-1", videoStorageKey: "key", videoUrl: "/api/media/key", targetNodeId: "video-1", initialIntents: [
        { id: "range-1", startSeconds: 1, endSeconds: 3, prompt: "保留这个区间", annotationShapes: [], frameWidth: 640, frameHeight: 360 }
      ] }
    }}
    setBusy={(value) => { hostBusy = value; }}
    requestClose={() => { if (!hostBusy) closed = true; }}
    replace={() => {}}
  />));
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "确认编辑")!.click(); });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ instanceId: "edit-1", intents: [expect.objectContaining({ id: "range-1", startSeconds: 1, endSeconds: 3 })] });
  expect(hostBusy).toBe(false);
  expect(closed).toBe(success);
  if (!success) {
    expect(container.textContent).toContain("保存失败，请重试");
    expect(container.querySelector("textarea")?.value).toBe("保留这个区间");
  }
  await act(async () => root.unmount());
  container.remove();
});
