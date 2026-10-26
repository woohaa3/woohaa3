/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { setup } from "../src/test-support/photo-editor-harness.js";

it("embedded editor declares chrome mode while keeping the canvas as the host content", () => {
  const { container } = setup(false, { chromeMode: "embedded" });
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  expect(editor.dataset.editorChromeMode).toBe("embedded");
  expect(container.querySelector<HTMLElement>(".photo-editor-theme-scope")?.style.background).toBe("transparent");
  expect(editor.querySelector(".photo-editor-canvas")).not.toBeNull();
  expect(editor.querySelector(".photo-editor__menubar")).not.toBeNull();
  expect(editor.querySelector(".photo-editor__toolrail")).not.toBeNull();
  expect(editor.querySelector(".photo-editor__sidebar")).not.toBeNull();
  expect(editor.querySelector(".photo-editor__status")).not.toBeNull();
});

it("standalone editor keeps its normal chrome mode instead of using embedded offsets", () => {
  const { container } = setup();
  expect(container.querySelector<HTMLElement>(".photo-editor")?.dataset.editorChromeMode).toBe("standalone");
});
