/**
 * Tauri 自定义协议的跨平台地址。
 *
 * macOS/Linux 直接用 `woohaa-native://localhost`；Windows 的 WebView2 只能通过
 * `http://woohaa-native.localhost` 访问同一协议（Tauri v2 的 Windows 映射）。
 * 平台由桌面壳注入的 bootstrap 决定，不用 UA 猜测。
 */
type NativeProtocolBootstrap = { platform?: string };

const CUSTOM_SCHEME_ORIGIN = "woohaa-native://localhost";
const WINDOWS_SCHEME_ORIGIN = "http://woohaa-native.localhost";

export function nativeProtocolOrigin(target: typeof globalThis = globalThis): string {
  const native = (target as typeof globalThis & { __WOOHAA_NATIVE__?: NativeProtocolBootstrap }).__WOOHAA_NATIVE__;
  const desktop = (target as typeof globalThis & { __WOOHAA_DESKTOP__?: NativeProtocolBootstrap }).__WOOHAA_DESKTOP__;
  return (native?.platform ?? desktop?.platform) === "windows" ? WINDOWS_SCHEME_ORIGIN : CUSTOM_SCHEME_ORIGIN;
}

/** 拼出受控协议 URL；`path` 不带前导斜杠。 */
export function nativeProtocolUrl(path: string, target: typeof globalThis = globalThis): string {
  return `${nativeProtocolOrigin(target)}/${path.replace(/^\/+/, "")}`;
}
