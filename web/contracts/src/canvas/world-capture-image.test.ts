import { describe, expect, it } from "vitest";
import {
  isInspectableWorldCaptureContentType,
  readWorldCaptureImageDimensions,
  readWorldCaptureImageType
} from "./world-capture-image.js";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + type.
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("world capture image dimensions", () => {
  it("reads exact PNG pixels independently from byte size", () => {
    expect(readWorldCaptureImageDimensions(pngHeader(2048, 1152), "image/png")).toEqual({
      width: 2048,
      height: 1152
    });
    expect(readWorldCaptureImageDimensions(pngHeader(1, 1), "image/png")).toEqual({ width: 1, height: 1 });
  });

  it("rejects malformed, mismatched and unsupported image headers", () => {
    expect(readWorldCaptureImageDimensions(new Uint8Array(), "image/png")).toBeNull();
    expect(readWorldCaptureImageDimensions(pngHeader(0, 10), "image/png")).toBeNull();
    expect(readWorldCaptureImageDimensions(pngHeader(10, 10), "image/jpeg")).toBeNull();
    expect(readWorldCaptureImageDimensions(pngHeader(10, 10), "image/gif")).toBeNull();
  });

  it("only claims media types it can actually inspect", () => {
    expect(isInspectableWorldCaptureContentType("image/png")).toBe(true);
    expect(isInspectableWorldCaptureContentType("image/jpeg")).toBe(true);
    expect(isInspectableWorldCaptureContentType("image/webp")).toBe(true);
    expect(isInspectableWorldCaptureContentType("image/gif")).toBe(false);
    expect(isInspectableWorldCaptureContentType("video/mp4")).toBe(false);
  });
});

describe("world capture image type sniffing", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const webp = (() => {
    const bytes = new Uint8Array(16);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    return bytes;
  })();

  it("identifies the real family from bytes", () => {
    expect(readWorldCaptureImageType(pngHeader(4, 4))).toBe("image/png");
    expect(readWorldCaptureImageType(jpeg)).toBe("image/jpeg");
    expect(readWorldCaptureImageType(webp)).toBe("image/webp");
  });

  it("does not guess from a declared type or accept unsupported families", () => {
    expect(readWorldCaptureImageType(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(readWorldCaptureImageType(new Uint8Array())).toBeNull();
    expect(readWorldCaptureImageType(new TextEncoder().encode("not an image"))).toBeNull();
  });
});
