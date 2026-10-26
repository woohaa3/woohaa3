import {afterEach, expect, it, vi} from "vitest";
import {webcrypto} from "node:crypto";
import {createEditorId} from "./editor-id.js";

afterEach(() => vi.unstubAllGlobals());

it("uses the native UUID method when available", () => {
  const randomUUID = vi.fn(() => "native-id");
  vi.stubGlobal("crypto", {randomUUID});
  expect(createEditorId()).toBe("native-id");
  expect(randomUUID).toHaveBeenCalledOnce();
});

it("creates distinct UUID v4 IDs with HTTP-available getRandomValues", () => {
  vi.stubGlobal("crypto", {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)});
  const ids = Array.from({length: 1000}, createEditorId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
