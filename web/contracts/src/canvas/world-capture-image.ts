/**
 * Static capture image inspection (T10).
 *
 * The capture pipeline must not trust a producer's self-reported pixel size. Before a
 * temporary image becomes a trusted media receipt, this module reads the exact width
 * and height from the encoded image header. Byte size and pixel size are different
 * facts; neither is derived from the other.
 *
 * Only the static image families this client can actually capture are accepted: PNG,
 * JPEG and WebP. Unknown or malformed input returns `null` and the caller must reject
 * the image instead of assuming a 1x1 or the requested output size.
 */

export type WorldCaptureImageDimensions = {
  readonly width: number;
  readonly height: number;
};

/** True for the exact image media types this module can inspect. */
export function isInspectableWorldCaptureContentType(contentType: string): boolean {
  return contentType === "image/png"
    || contentType === "image/jpeg"
    || contentType === "image/jpg"
    || contentType === "image/webp";
}

/**
 * Read exact positive pixel dimensions, or `null` when the header is malformed,
 * unsupported or does not match the declared media type.
 */
export function readWorldCaptureImageDimensions(
  bytes: Uint8Array,
  contentType: string
): WorldCaptureImageDimensions | null {
  if (bytes.length === 0) return null;
  const dimensions =
    contentType === "image/png"
      ? readPng(bytes)
      : contentType === "image/jpeg" || contentType === "image/jpg"
        ? readJpeg(bytes)
        : contentType === "image/webp"
          ? readWebp(bytes)
          : null;
  if (!dimensions) return null;
  if (!isPositiveSafeInteger(dimensions.width) || !isPositiveSafeInteger(dimensions.height)) return null;
  return dimensions;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readPng(bytes: Uint8Array): WorldCaptureImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // First chunk must be IHDR: length(4) + type(4) + width(4) + height(4).
  if (readAscii(bytes, 12, 4) !== "IHDR") return null;
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20)
  };
}

function readJpeg(bytes: Uint8Array): WorldCaptureImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    // Skip fill bytes.
    let marker = bytes[offset + 1]!;
    offset += 2;
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset]!;
      offset += 1;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return null;
      return {
        width: readUInt16BE(bytes, offset + 5),
        height: readUInt16BE(bytes, offset + 3)
      };
    }
    offset += length;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function readWebp(bytes: Uint8Array): WorldCaptureImageDimensions | null {
  if (bytes.length < 30) return null;
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = readAscii(bytes, 12, 4);
  if (chunk === "VP8X") {
    // flags(4) at 20, canvas width-1 (3 bytes LE) at 24, height-1 at 27.
    return {
      width: readUInt24LE(bytes, 24) + 1,
      height: readUInt24LE(bytes, 27) + 1
    };
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1
    };
  }
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes) then start code 9d 01 2a, then 14-bit width/height.
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff
    };
  }
  return null;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]!);
  }
  return text;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
