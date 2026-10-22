/**
 * 平台能力判定（与 socket 实现分开，方便宿主在无 Unix socket 的平台上静态判定）
 * （change: 2026-10-17-add-native-offscreen-film-set-recording）。
 */
export { recordingExecutorPlatformSupported, checkoutIdFor } from "./paths.js";
