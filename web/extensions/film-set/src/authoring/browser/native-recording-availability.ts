/**
 * 原生录制能力探测（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.3）。
 *
 * 只判断「是否跑在桌面壳里」：真正的执行器/编码/GPU 能力由宿主在 submit 时判定并返回
 * 具体原因（`recording-executor-unavailable` 等）。**不**在浏览器里假装支持原生录制。
 *
 * 纯函数，便于单测；不读 DOM 之外的全局。
 */
export type NativeRecordingEnvironment = {
  /** 桌面壳注入的原生桥（与画布 native 协议同一来源）。 */
  nativeBridge?: unknown;
  userAgent?: string;
};

/** 当前是否为桌面壳（有原生桥）。 */
export function isDesktopShell(env: NativeRecordingEnvironment = detectEnvironment()): boolean {
  if (env.nativeBridge !== undefined && env.nativeBridge !== null) return true;
  // `woohaa-desktop` 会把自己的标识放进 UA；浏览器版不会。
  return typeof env.userAgent === "string" && /woohaa-desktop/i.test(env.userAgent);
}

/**
 * 是否启用宿主录制路径。
 *
 * 显式关闭用 `WOOHAA3_NATIVE_RECORDING=0`（排障/回退到浏览器适配器时使用）；
 * 未设置时：桌面壳走宿主，浏览器走现有适配器。
 */
export function nativeRecordingAvailable(env: NativeRecordingEnvironment = detectEnvironment()): boolean {
  if (env.nativeBridge === DISABLED) return false;
  return isDesktopShell(env);
}

const DISABLED = Symbol("recording-disabled") as unknown as object;

function detectEnvironment(): NativeRecordingEnvironment {
  if (typeof globalThis === "undefined") return {};
  const bridge = (globalThis as { __WOOHAA_NATIVE__?: unknown }).__WOOHAA_NATIVE__;
  const flag = (globalThis as { __WOOHAA_NATIVE_RECORDING__?: unknown }).__WOOHAA_NATIVE_RECORDING__;
  if (flag === false) return { nativeBridge: DISABLED };
  const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return {
    ...(bridge !== undefined ? { nativeBridge: bridge } : {}),
    ...(userAgent ? { userAgent } : {})
  };
}
