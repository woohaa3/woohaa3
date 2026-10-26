import { describe, expect, it } from "vitest";
import {
  EXTENSION_HOST_ERROR_CODES,
  EXTENSION_HOST_IDEMPOTENT_METHODS,
  EXTENSION_HOST_LIMITS,
  EXTENSION_HOST_METHODS,
  EXTENSION_HOST_PROTOCOL_VERSION,
  isExtensionHostErrorCode,
  type ExtensionHostFrame,
  type ExtensionHostProviderRegistration,
  type ExtensionHostStartParams
} from "./extension-host.js";
import {
  APPLICATION_EXTENSION_ACTUAL_STATES,
  EXTENSION_CRASH_LOOP_DIAGNOSTIC,
  isApplicationExtensionActualState
} from "../extension/state.js";
import { SETTING_DEFINITIONS } from "../settings/index.js";

describe("Extension Host 协议契约", () => {
  it("方法名覆盖控制、流、ctx、provider、gateway、storage 六组且互不重复", () => {
    const names = Object.values(EXTENSION_HOST_METHODS);
    expect(new Set(names).size).toBe(names.length);
    for (const prefix of ["$/", "stream.", "ctx.", "provider.", "gateway.", "storage."]) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(true);
    }
    expect(EXTENSION_HOST_METHODS.hello).toBe("$/hello");
    expect(EXTENSION_HOST_METHODS.cancel).toBe("$/cancel");
    expect(EXTENSION_HOST_PROTOCOL_VERSION).toBe(1);
  });

  it("错误码稳定，含设计要求的全部码", () => {
    for (const code of [
      "permission-denied",
      "rpc-timeout",
      "rpc-busy",
      "frame-too-large",
      "extension-crashed",
      "extension-replaced",
      "extension-unavailable",
      "extension-host-limit",
      "extension-host-unsupported",
      "EXTENSION_NETWORK_DENIED"
    ]) {
      expect(isExtensionHostErrorCode(code)).toBe(true);
    }
    expect(isExtensionHostErrorCode("nope")).toBe(false);
    expect(new Set(EXTENSION_HOST_ERROR_CODES).size).toBe(EXTENSION_HOST_ERROR_CODES.length);
  });

  it("限额与设计一致；生成提交不在幂等方法里", () => {
    expect(EXTENSION_HOST_LIMITS.maxFrameBytes).toBe(1024 * 1024);
    expect(EXTENSION_HOST_LIMITS.maxChunkBytes).toBe(256 * 1024);
    expect(EXTENSION_HOST_LIMITS.initialStreamCredit).toBe(8);
    expect(EXTENSION_HOST_LIMITS.maxInFlight).toBe(256);
    expect(EXTENSION_HOST_LIMITS.heartbeatTimeoutMs).toBe(15_000);
    expect(EXTENSION_HOST_IDEMPOTENT_METHODS).not.toContain(EXTENSION_HOST_METHODS.providerModelCall);
    expect(EXTENSION_HOST_IDEMPOTENT_METHODS).not.toContain(EXTENSION_HOST_METHODS.providerJobsCall);
  });

  it("类型形状：帧、启动参数与 Provider 登记", () => {
    const frames: ExtensionHostFrame[] = [
      { jsonrpc: "2.0", id: 1, method: EXTENSION_HOST_METHODS.ping },
      { jsonrpc: "2.0", method: EXTENSION_HOST_METHODS.ctxLog, params: { message: "x" } },
      { jsonrpc: "2.0", id: 1, result: "pong" },
      { jsonrpc: "2.0", id: 2, error: { code: "rpc-timeout", message: "超时" } }
    ];
    const start: ExtensionHostStartParams = {
      instanceId: "i-1",
      entry: "/x/backend-dist/entry.mjs",
      factory: "createPlugin",
      kind: "provider",
      values: {},
      capabilities: { extensionId: "x", routePrefixes: ["/api/extensions/x/"], storageNamespaces: [], network: [] }
    };
    const registration: ExtensionHostProviderRegistration = { providerId: "p", available: true, models: [], members: ["describe"] };
    expect(frames).toHaveLength(4);
    expect(start.kind).toBe("provider");
    expect(registration.members).toEqual(["describe"]);
  });
});

describe("quarantined 状态与 Extension Host 设置", () => {
  it("实际状态含 quarantined，诊断码 crash-loop", () => {
    expect(APPLICATION_EXTENSION_ACTUAL_STATES).toContain("quarantined");
    expect(isApplicationExtensionActualState("quarantined")).toBe(true);
    expect(EXTENSION_CRASH_LOOP_DIAGNOSTIC).toBe("crash-loop");
  });

  it("extensions.host.* 设置有界", () => {
    expect(SETTING_DEFINITIONS["extensions.host.isolation"]).toMatchObject({ kind: "boolean", default: true });
    expect(SETTING_DEFINITIONS["extensions.host.maxOldSpaceMb"]).toMatchObject({ default: 256, min: 64, max: 2048 });
    expect(SETTING_DEFINITIONS["extensions.host.maxProcesses"]).toMatchObject({ default: 16, min: 1 });
    expect(SETTING_DEFINITIONS["extensions.host.drainTimeoutMs"]).toMatchObject({ default: 600000, min: 1000 });
  });
});
