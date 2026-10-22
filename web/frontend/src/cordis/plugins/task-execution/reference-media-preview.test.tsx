/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { UiProvider } from "../../../shared/ui/index.js";
import { ReferenceTileStrip } from "./reference-chips.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
it("hover opens a bounded full-image popup without moving input focus, leaving cleans it up", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const input = document.createElement("input"); document.body.append(input); input.focus();
  root = createRoot(container);
  await act(async () => root.render(<UiProvider><ReferenceTileStrip items={[{
    slotId: "image-1", sourceNodeId: "node-1", role: "reference_image", mentionType: "input_image",
    label: "图片 1", mediaKind: "image", previewUrl: "/api/media/full.png", assetId: "asset-1", status: "ready", blockingReason: null
  }]} /></UiProvider>));
  const tile = container.querySelector(".ref-tile")!;
  await act(async () => tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  const preview = container.querySelector<HTMLImageElement>(".ref-preview img")!;
  expect(preview.getAttribute("src")).toBe("/api/media/full.png");
  expect(preview.style.maxHeight).toBe("228px");
  expect(preview.closest("[data-ui-portal-root]")).not.toBeNull();
  expect(tile.querySelector(".ui-popover__anchor")).toBeNull();
  expect(document.activeElement).toBe(input);
  await act(async () => tile.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(container.querySelector(".ref-preview")).toBeNull();
});
