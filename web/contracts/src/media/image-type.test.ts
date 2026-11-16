import { describe, expect, it } from "vitest";
import { readImageMediaType } from "./image-type.js";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("image media type sniffing", () => {
  it("identifies png, jpeg, webp, gif and avif from signatures", () => {
    expect(readImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(readImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(readImageMediaType(ascii("RIFF\0\0\0\0WEBPVP8X"))).toBe("image/webp");
    expect(readImageMediaType(ascii("GIF89a......"))).toBe("image/gif");
    expect(readImageMediaType(ascii("\0\0\0\0ftypavif...."))).toBe("image/avif");
  });

  it("returns null instead of guessing for unknown or short input", () => {
    expect(readImageMediaType(new Uint8Array())).toBeNull();
    expect(readImageMediaType(ascii("hello"))).toBeNull();
    expect(readImageMediaType(ascii("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(readImageMediaType(ascii("\0\0\0\0ftypisom...."))).toBeNull();
  });
});
