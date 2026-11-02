/** Image preparation ABI: oriented sRGB, straight-alpha RGBA8. */
export const IMAGE_PREPARATION_VERSION = 1 as const;
/** Opaque native pixels; bytes remain in the native process until upload or release. */
export type NativeImageResource = { kind: 'native-image'; handle: string; generation: number; width: number; height: number };
export type ImagePixelSource = Uint8Array | NativeImageResource;
export type PreparedImageResource = { width: number; height: number; sourceWidth: number; sourceHeight: number; pixels: ImagePixelSource };

/** Worst-case job reservation: 1 GiB WASM capacity plus fetch/transfer/encoded staging. Not eagerly allocated. */
export const IMAGE_PROCESSING_RESERVATION_BYTES = 1152 * 1024 * 1024;

/**
 * 一次压缩字节读取的预留（32 MiB 输入上限 + 分块/拼接余量）。
 *
 * 网络读取与解码分开计费：压缩字节在飞时只占传输缓冲，不占 WASM 线性内存，
 * 所以读取阶段用这个小预留，解码阶段才用 `IMAGE_DECODE_RESERVATION_BYTES`。
 */
export const IMAGE_FETCH_RESERVATION_BYTES = 40 * 1024 * 1024;

/**
 * 一次解码作业的预留（RGBA 输出 + codec scratch + 实例开销）。
 *
 * 取实测上界而非 1 GiB 线性内存上限：4096² 源缩到 512 的实测实例容量约 67–71 MiB，
 * 1024² 源约 7 MiB（见 change 2026-11-01 的 cpu-benchmark.json）。96 MiB 留出 4K 源
 * 加编码输出的余量。`IMAGE_PROCESSING_RESERVATION_BYTES` 仍是单实例**硬上限**
 * （防止最坏输入撑爆线性内存），但不再当作每个作业的预订字节数，否则页面解码预算只能
 * 容纳两个作业，档位分级和读取/解码流水线都无从谈起。
 */
export const IMAGE_DECODE_RESERVATION_BYTES = 96 * 1024 * 1024;
