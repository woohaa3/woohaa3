import { expect, it } from "vitest";
import { filmSetConversionAssistantKey, readFilmSetConversionAssistant } from "./assistant.js";
import { normalizeFilmSetConversionSettings } from "./request.js";

it("助手连接、模型和 Variant 在规范请求中完整往返，支持长模型 ID", () => {
  const selection = { connection: { connectionId: "connection-" + "a".repeat(100), adapterId: "openai-responses", configRevision: 5, credentialEpoch: 2 }, model: "provider/" + "model".repeat(40), reasoningEffort: "ultra" as const };
  const modelKey = filmSetConversionAssistantKey(selection);
  expect(modelKey.length).toBeGreaterThan(200);
  expect(readFilmSetConversionAssistant(modelKey)).toEqual(selection);
  expect(normalizeFilmSetConversionSettings({ modelKey })).toEqual({ ok: true, value: { modelKey } });
});

it.each(["assistant:broken", 'assistant:%5B%22id%22%5D', "p:" + "a".repeat(210)])("非法或不完整选择不能作为长助手 key: %s", modelKey => {
  expect(readFilmSetConversionAssistant(modelKey)).toBeNull();
});
