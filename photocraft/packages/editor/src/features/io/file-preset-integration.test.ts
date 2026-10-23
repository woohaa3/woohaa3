// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { resolveExportPresetPort } from "../files/export-bridge.js";
import { ExportPresetStore } from "./export-presets.js";
import { createSession } from "./workspace.js";
import { currentInterchangeRequest, requestExportPreset, resetInterchangeRequest } from "./menu-request.js";

afterEach(() => { localStorage.clear(); resetInterchangeRequest(); });

it("shares io presets with the file panel and restores their actual export parameters", () => {
  const io = createSession(() => { throw new Error("本机预设不应读取文档或推进历史"); });
  const port = resolveExportPresetPort({ io });
  expect(port.available).toBe(true);
  if (!port.available) throw new Error(port.reason);
  expect(port.save?.("交付", { mode: "export", format: "jpg", quality: 73, metadata: "all" })).toEqual({ ok: true });
  const reloaded = new ExportPresetStore().find("交付");
  expect(reloaded).toMatchObject({ quality: 73, format: "jpg", metadata: "all" });
  const listed = port.list();
  if (!listed.ok) throw new Error(listed.reason);
  const entry = listed.presets.find(preset => preset.name === "交付")!;
  expect(requestExportPreset(entry.settings)).toEqual({ ok: true });
  expect(currentInterchangeRequest()).toMatchObject({ tab: "export", mode: "export", settings: reloaded });
  expect(requestExportPreset({ format: "not-a-format" }).ok).toBe(false);
  expect(currentInterchangeRequest()?.nonce).toBe(1);
  expect(port.remove?.("交付")).toEqual({ ok: true });
  expect(new ExportPresetStore().find("交付")).toBeNull();
});
