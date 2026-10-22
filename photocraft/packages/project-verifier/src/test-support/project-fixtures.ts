/**
 * 工程核验测试夹具（change: 2026-10-21-extract-photocraft-subproject，任务 3.1 / design D6）。
 *
 * 最小 ZIP 构造器与 manifest 工厂。迁移前它们散落在 Media 的测试文件里；现在核验能力归
 * PhotoCraft，Media 仍要测「受限上传拒绝不落合法对象」，因此把这部分夹具作为
 * `@woohaa3/photocraft-project-verifier/test-support` 显式导出，避免两处各写一个 ZIP 构造器
 * 而悄悄漂移。
 *
 * 只被测试使用：不进 `src/index.ts`，不参与运行时代码路径。
 */
import { deflateRawSync } from "node:zlib";

export type ZipFile = { name: string; data: Uint8Array; deflate?: boolean; declaredSize?: number };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造一份最小 ZIP（STORE 或 DEFLATE）；用于生成真实工程字节。 */
export function buildZip(files: ZipFile[]): Uint8Array {
  const chunks: number[] = [];
  const central: number[] = [];
  const push = (target: number[], values: number[]) => target.push(...values);
  const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
  for (const file of files) {
    const nameBytes = [...new TextEncoder().encode(file.name)];
    const stored = file.deflate ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    const declared = file.declaredSize ?? file.data.byteLength;
    const offset = chunks.length;
    push(chunks, u32(0x04034b50));
    push(chunks, u16(20));
    push(chunks, u16(0));
    push(chunks, u16(file.deflate ? 8 : 0));
    push(chunks, [0, 0, 0, 0]);
    push(chunks, u32(crc32(file.data)));
    push(chunks, u32(stored.byteLength));
    push(chunks, u32(declared));
    push(chunks, u16(nameBytes.length));
    push(chunks, u16(0));
    push(chunks, nameBytes);
    push(chunks, [...stored]);

    push(central, u32(0x02014b50));
    push(central, u16(20));
    push(central, u16(20));
    push(central, u16(0));
    push(central, u16(file.deflate ? 8 : 0));
    push(central, [0, 0, 0, 0]);
    push(central, u32(crc32(file.data)));
    push(central, u32(stored.byteLength));
    push(central, u32(declared));
    push(central, u16(nameBytes.length));
    push(central, u16(0));
    push(central, u16(0));
    push(central, u16(0));
    push(central, u16(0));
    push(central, u32(0));
    push(central, u32(offset));
    push(central, nameBytes);
  }
  const centralOffset = chunks.length;
  const out = [...chunks, ...central];
  push(out, u32(0x06054b50));
  push(out, u16(0));
  push(out, u16(0));
  push(out, u16(files.length));
  push(out, u16(files.length));
  push(out, u32(central.length));
  push(out, u32(centralOffset));
  push(out, u16(0));
  return Uint8Array.from(out);
}

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

/** 合法工程 manifest；`overrides` 合并到顶层，`layerOverrides` 替换默认图层。 */
export function manifest(
  overrides: Record<string, unknown> = {},
  layerOverrides: Record<string, unknown>[] = []
): Record<string, unknown> {
  const layers =
    layerOverrides.length > 0
      ? layerOverrides
      : [
          {
            id: "layer-1",
            name: "Background",
            blend: "normal",
            opacity: 1,
            visible: true,
            content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_A }] }
          }
        ];
  return {
    format_version: 1,
    generator: "photocraft-format 0.9.0",
    document: {
      id: "doc-1",
      name: "Untitled",
      size: { width: 1024, height: 768 },
      mode: "rgb",
      depth: "u8",
      layers,
      ...(overrides.document as Record<string, unknown> | undefined)
    },
    thumbnail: null,
    composite: null,
    ...overrides
  };
}

/** 合法工程字节（含 manifest 与一个 blob 资源）。 */
export function projectBytes(
  options: {
    manifest?: Record<string, unknown>;
    extra?: ZipFile[];
    manifestRaw?: string;
    omitManifest?: boolean;
  } = {}
): Uint8Array {
  const files: ZipFile[] = [];
  files.push({ name: `blobs/${HASH_A}.zst`, data: Uint8Array.from([1, 2, 3, 4]), deflate: true });
  files.push({ name: "thumb.png", data: Uint8Array.from([0x89, 0x50]) });
  if (!options.omitManifest) {
    const text = options.manifestRaw ?? JSON.stringify(options.manifest ?? manifest());
    files.push({ name: "manifest.json", data: new TextEncoder().encode(text), deflate: true });
  }
  files.push(...(options.extra ?? []));
  return buildZip(files);
}
