import { describe, expect, it, vi } from "vitest";
import { createFixedEnginePreparation, componentForEngine, preparationMessage } from "./runtime-preparation.js";
import type { RuntimeComponentManager, RuntimeComponentState } from "@woohaa3/runtime-components";

function state(overrides: Partial<RuntimeComponentState> = {}): RuntimeComponentState {
  return {
    id: "claude", version: "0.3.301", source: "npm-registry", configured: true, status: "ready",
    ...overrides
  };
}

function manager(overrides: Partial<RuntimeComponentManager> = {}): RuntimeComponentManager {
  return {
    configPath: "/tmp/config.json",
    inspect: vi.fn(async () => state()),
    list: vi.fn(async () => []),
    configure: vi.fn(),
    install: vi.fn(async () => state()),
    resolve: vi.fn(),
    remove: vi.fn(),
    discoverLocal: vi.fn(),
    diagnose: vi.fn(),
    policy: () => ({ installEnabled: true, sources: ["npm-registry"], registry: "https://registry.npmjs.org/" }),
    ...overrides
  } as RuntimeComponentManager;
}

describe("固定引擎 runtime 准备", () => {
  it("把固定引擎映射到锁定的 runtime 组件，内置引擎不需要安装", async () => {
    expect(componentForEngine("dsh-agent-sdk")).toBe("dsh");
    expect(componentForEngine("claude-agent-sdk")).toBe("claude");
    expect(componentForEngine("codex-agent-sdk")).toBe("codex");
    expect(componentForEngine("gemini-agent-adk")).toBeNull();
    const fake = manager();
    const preparation = createFixedEnginePreparation(fake);
    await expect(preparation.prepare("gemini-agent-adk")).resolves.toMatchObject({ state: "ready", source: "builtin" });
    expect(fake.inspect).not.toHaveBeenCalled();
  });

  it("已缓存的 runtime 只读检查，不触发安装", async () => {
    const fake = manager();
    const preparation = createFixedEnginePreparation(fake);
    await expect(preparation.prepare("claude-agent-sdk")).resolves.toMatchObject({ state: "ready", component: "claude", version: "0.3.301", source: "npm-registry" });
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("缺失时自动安装，并把并发准备合并为一个 job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const install = vi.fn(async () => { await gate; return state(); });
    const fake = manager({ inspect: vi.fn(async () => state({ status: "missing" })), install });
    const preparation = createFixedEnginePreparation(fake);
    const first = preparation.prepare("claude-agent-sdk");
    const second = preparation.prepare("claude-agent-sdk");
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toMatchObject({ state: "ready" });
    expect(right).toMatchObject({ state: "ready" });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("registry 不可达时返回可行动原因，不把连接标为 ready", async () => {
    const fake = manager({
      inspect: vi.fn(async () => state({ status: "missing" })),
      install: vi.fn(async () => { throw Object.assign(new Error("npm registry HTTP 503"), { code: "REGISTRY_UNAVAILABLE" }); })
    });
    const preparation = createFixedEnginePreparation(fake);
    const result = await preparation.prepare("codex-agent-sdk");
    expect(result.state).toBe("unavailable");
    expect(result.code).toBe("REGISTRY_UNAVAILABLE");
    expect(result.reason).toContain("npm registry 暂不可达");
    expect(result.reason).not.toMatch(/重新安装/);
  });

  it("部署关闭运行时安装时直接返回管理员原因", async () => {
    const fake = manager({ inspect: vi.fn(async () => state({ status: "unavailable", error: "管理员未启用运行时安装" })) });
    const preparation = createFixedEnginePreparation(fake);
    const result = await preparation.prepare("claude-agent-sdk");
    expect(result).toMatchObject({ state: "unavailable", code: "RUNTIME_INSTALL_DISABLED", reason: "管理员未启用运行时安装" });
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("没有 manager 的开发桌面沿用随仓依赖", async () => {
    const preparation = createFixedEnginePreparation();
    await expect(preparation.prepare("dsh-agent-sdk")).resolves.toMatchObject({ state: "ready", source: "development" });
  });

  it("稳定错误码都有可执行恢复文案，且不再指向重装扩展", () => {
    for (const code of ["REGISTRY_UNAVAILABLE", "INVALID_HASH", "INSUFFICIENT_SPACE", "UNAPPROVED_LIFECYCLE_SCRIPT", "NPM_TOOLCHAIN_MISSING", "RUNTIME_INSTALL_DISABLED"]) {
      const message = preparationMessage(code, "detail");
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/重新安装对应平台扩展|重新安装本扩展/);
    }
  });
});
