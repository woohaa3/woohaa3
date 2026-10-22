import { expect, it } from "vitest";
import { nativeProtocolOrigin, nativeProtocolUrl } from "./native-protocol.js";

it("uses the WebView2 http mapping on Windows", () => {
  const target = { __WOOHAA_NATIVE__: { platform: "windows" } } as unknown as typeof globalThis;
  expect(nativeProtocolOrigin(target)).toBe("http://woohaa-native.localhost");
  expect(nativeProtocolUrl("rpc", target)).toBe("http://woohaa-native.localhost/rpc");
  expect(nativeProtocolUrl("/window", target)).toBe("http://woohaa-native.localhost/window");
});

it("keeps the custom scheme on macOS, Linux and older hosts", () => {
  for (const platform of ["macos", "linux", undefined]) {
    const target = { __WOOHAA_NATIVE__: { platform } } as unknown as typeof globalThis;
    expect(nativeProtocolOrigin(target)).toBe("woohaa-native://localhost");
  }
  const desktopOnly = { __WOOHAA_DESKTOP__: { platform: "windows" } } as unknown as typeof globalThis;
  expect(nativeProtocolOrigin(desktopOnly)).toBe("http://woohaa-native.localhost");
});
