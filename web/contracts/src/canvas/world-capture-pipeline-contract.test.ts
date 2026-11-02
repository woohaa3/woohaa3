import { describe, expect, it } from "vitest";
import {
  decodeWorldCaptureGenerationBinding,
  decodeWorldCaptureResourceReadyNotice,
  encodeWorldCaptureGenerationBinding,
  type WorldCaptureGenerationBinding
} from "./world-capture-pipeline-contract.js";

const KEY = {
  canvasId: "canvas-1",
  cameraId: "camera-1",
  worldContentVersion: "world-1",
  cameraSettingsVersion: "camera-1-v1",
  bindingVersion: "binding-1",
  outputVersion: "output-1"
} as const;

const MEDIA = {
  version: "world-capture-media-v2" as const,
  mediaId: "sha256-abc",
  storageKey: `generation-outputs/${"a".repeat(64)}.png`,
  checksum: "a".repeat(64),
  contentType: "image/png",
  size: 1024,
  width: 16,
  height: 9
};

const BINDING: WorldCaptureGenerationBinding = {
  version: "world-capture-generation-binding-v1",
  requestId: "request-1",
  key: KEY,
  contentFingerprint: "0123456789abcdef",
  input: { key: KEY, mediaId: "sha256-abc", checksum: "a".repeat(64) },
  media: MEDIA
};

describe("world capture generation binding", () => {
  it("round-trips the exact key/media identity", () => {
    const decoded = decodeWorldCaptureGenerationBinding(encodeWorldCaptureGenerationBinding(BINDING));
    expect(decoded.ok && decoded.value).toEqual(BINDING);
  });

  it("rejects cross-key, malformed checksum and extra fields", () => {
    expect(decodeWorldCaptureGenerationBinding({
      ...BINDING,
      input: { ...BINDING.input, key: { ...KEY, cameraId: "other" } }
    }).ok).toBe(false);
    expect(decodeWorldCaptureGenerationBinding({
      ...BINDING,
      input: { ...BINDING.input, checksum: "A".repeat(64) }
    }).ok).toBe(false);
    expect(decodeWorldCaptureGenerationBinding({
      ...BINDING,
      input: { ...BINDING.input, url: "https://example.invalid/x.png" }
    }).ok).toBe(false);
    expect(decodeWorldCaptureGenerationBinding({
      ...BINDING,
      contentFingerprint: "not-a-fingerprint"
    }).ok).toBe(false);
    // Optional media stays exact: it cannot point at different bytes than `input`.
    expect(decodeWorldCaptureGenerationBinding({
      ...BINDING,
      media: { ...MEDIA, checksum: "b".repeat(64) }
    }).ok).toBe(false);
    // Legacy bindings without verified media still decode as metadata-only.
    expect(decodeWorldCaptureGenerationBinding({ ...BINDING, media: undefined }).ok).toBe(true);
  });

  it("accepts an optional late resource notice but never invents fields", () => {
    expect(decodeWorldCaptureResourceReadyNotice({ canvasId: "canvas-1" }).ok).toBe(true);
    expect(decodeWorldCaptureResourceReadyNotice({
      canvasId: "canvas-1",
      cameraId: "camera-1",
      requestId: "request-1",
      contentFingerprint: "0123456789abcdef"
    }).ok).toBe(true);
    expect(decodeWorldCaptureResourceReadyNotice({
      canvasId: "canvas-1",
      url: "https://example.invalid"
    }).ok).toBe(false);
    expect(decodeWorldCaptureResourceReadyNotice({ canvasId: "canvas-1", contentFingerprint: "bad" }).ok).toBe(false);
  });
});
