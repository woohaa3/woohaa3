/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkAgentSettingsPanel } from "./settings-panel.js";
import type { SdkAgentRemote, SdkAgentConnectionView } from "./remote.js";
import { SDK_AGENT_ADAPTERS } from "../shared.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const ok = <T,>(value: T) => ({ ok: true as const, value });
let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});
function fixture() {
  const connection: SdkAgentConnectionView = {
    connectionId: "c1",
    adapterId: "compat-chat",
    name: "我的兼容服务",
    label: "兼容 API",
    authMode: "api-key",
    runCategory: "http-sdk",
    configRevision: 1,
    credentialEpoch: 1,
    credentialConfigured: false,
    needsLocalRuntime: false,
    allowCustomBaseUrl: true,
    models: ["model-a", "model-b"],
  };
  const connections = [connection];
  const api: SdkAgentRemote = {
    list: vi.fn(async () =>
      ok({
        connections: [...connections],
        adapters: [
          {
            adapterId: "compat-chat",
            label: "兼容 API",
            runCategory: "http-sdk",
            authMode: "api-key",
            officialBaseUrl: "https://api.example/v1",
            allowCustomBaseUrl: true,
            requiresLocalRuntime: true,
            suggestedModels: [],
          },
        ],
      }),
    ),
    configure: vi.fn(async () => {
      connection.credentialConfigured = true;
      return ok({ connectionId: "c1", models: ["model-a", "model-b"] });
    }),
    create: vi.fn(async () => ok({ connectionId: "c2" })),
    saveCredential: vi.fn(async () => {
      connection.credentialConfigured = true;
      connection.credentialEpoch++;
      return ok({
        credentialConfigured: true,
        credentialEpoch: connection.credentialEpoch,
      });
    }),
    clearCredential: vi.fn(async () =>
      ok({ credentialConfigured: false, credentialEpoch: 3 }),
    ),
    remove: vi.fn(async () => ok({ removed: true })),
    check: vi.fn(async () =>
      ok({
        transport: "unknown",
        credential: "ready",
        modelAccess: "unknown",
        tools: "unknown",
        note: "无生成探测",
      }),
    ),
    testGeneration: vi.fn(async () =>
      ok({ ok: true, model: "model-b", assistantText: "ok" }),
    ),
  };
  return { api, connection, connections };
}
async function mount(
  api: SdkAgentRemote,
  props: { reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void } = {},
) {
  await act(async () =>
    root.render(<SdkAgentSettingsPanel remote={api} {...props} />),
  );
}
async function click(text: string) {
  await act(async () =>
    [...el.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === text)!
      .click(),
  );
}
async function input(label: string, value: string) {
  const field = el.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, text: string) {
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent === text)!
      .click(),
  );
}
async function configure(id = "c1") {
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>(`[data-connection-id="${id}"] button`)!
      .click(),
  );
}

describe("设置退出保护上报", () => {
  it("有未保存输入上报 dirty；保存中上报 pending，成功后回到干净", async () => {
    // change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.3。
    const { api } = fixture();
    const reportEditState = vi.fn();
    let release!: () => void;
    api.configure = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              ok({ connectionId: "c1", models: ["model-a", "model-b"] }),
            );
        }),
    ) as SdkAgentRemote["configure"];
    await mount(api, { reportEditState });
    expect(reportEditState).toHaveBeenLastCalledWith({
      dirty: false,
      pending: false,
    });

    await input("Base URL", "https://models.example/v1");
    await input("API Key", "sk-private-value");
    expect(reportEditState).toHaveBeenLastCalledWith({
      dirty: true,
      pending: false,
    });

    await click("保存并读取模型");
    expect(reportEditState).toHaveBeenLastCalledWith({
      dirty: true,
      pending: true,
    });
    await act(async () => release());
    expect(reportEditState).toHaveBeenLastCalledWith({
      dirty: false,
      pending: false,
    });
    // 密钥输入已清空，不进入后续上报。
    expect(
      el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!.value,
    ).toBe("");
  });
});

describe("直接配置模型 API", () => {
  it("四种协议均可填写 Base URL，Responses 与 Chat Completions 明确区分", async () => {
    const { api } = fixture();
    vi.mocked(api.list).mockResolvedValue(ok({ connections: [], adapters: [...SDK_AGENT_ADAPTERS] }));
    await mount(api);
    for (const label of ["OpenAI Responses API", "Anthropic Messages API", "Chat Completions API", "Gemini API"]) {
      await select("API 协议", label);
      const address = el.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!;
      expect(address.disabled).toBe(false);
      await input("Base URL", "https://gateway.example/custom/v1");
      await input("API Key", "protocol-key");
      await click("保存并读取模型");
      expect(api.configure).toHaveBeenLastCalledWith(expect.objectContaining({
        adapterId: SDK_AGENT_ADAPTERS.find(adapter => adapter.label === label)!.adapterId,
        baseUrl: "https://gateway.example/custom/v1", secret: "protocol-key",
      }));
    }
    expect(api.testGeneration).not.toHaveBeenCalled();
  });
  it("初始直接填写地址和 Key，一次保存并读取模型，不创建空连接或触发生成", async () => {
    const { api } = fixture();
    await mount(api);
    expect(el.querySelector('input[aria-label="Base URL"]')).not.toBeNull();
    expect(el.textContent).not.toMatch(/添加连接|连接名称|新建连接/);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    try {
      await input("Base URL", "https://models.example/v1");
      await input("API Key", "sk-private-value");
      await click("保存并读取模型");
      expect(api.configure).toHaveBeenCalledWith({
        adapterId: "compat-chat",
        baseUrl: "https://models.example/v1",
        secret: "sk-private-value",
      });
      expect(api.create).not.toHaveBeenCalled();
      expect(api.saveCredential).not.toHaveBeenCalled();
      expect(api.testGeneration).not.toHaveBeenCalled();
      expect(
        el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!
          .value,
      ).toBe("");
      expect(storage).not.toHaveBeenCalled();
      expect(el.textContent).toContain("已保存");
    } finally {
      storage.mockRestore();
    }
  });
  it("保存失败保留地址和 Key，允许重试", async () => {
    const { api } = fixture();
    api.configure = vi.fn(async () => ({
      ok: false as const,
      error: "保存失败",
    }));
    await mount(api);
    await input("Base URL", "https://models.example/v1");
    await input("API Key", "sk-retry");
    await click("保存并读取模型");
    expect(el.textContent).toContain("保存失败");
    expect(
      el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!.value,
    ).toBe("sk-retry");
    await click("保存并读取模型");
    expect(api.configure).toHaveBeenCalledTimes(2);
  });
  it("模型目录失败时配置已保存，并展开手填模型入口", async () => {
    const { api } = fixture();
    api.configure = vi.fn(async () =>
      ok({ connectionId: "c1", models: [], modelsError: "模型列表不可用" }),
    );
    await mount(api);
    await input("API Key", "sk-value");
    await click("保存并读取模型");
    expect(el.textContent).toContain("地址和 Key 已保存");
    expect(el.querySelector('input[aria-label="模型 ID"]')).not.toBeNull();
    await input("模型 ID", "model-a， model-b");
    await input("API Key", "sk-value");
    await click("保存并读取模型");
    expect(api.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: "c1",
        models: ["model-a", "model-b"],
      }),
    );
  });
  it("编辑其他服务清空 Key；修改地址要求重新填 Key", async () => {
    const { api, connections, connection } = fixture();
    connection.credentialConfigured = true;
    connection.baseUrl = "https://api.example/v1";
    connections.push({ ...connection, connectionId: "c2", name: "第二个服务" });
    await mount(api);
    await configure();
    await input("API Key", "sk-first");
    await configure("c2");
    expect(
      el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!.value,
    ).toBe("");
    await input("Base URL", "https://different.example/v1");
    expect(
      [...el.querySelectorAll("button")].find(
        (button) => button.textContent === "保存并读取模型",
      )!.disabled,
    ).toBe(true);
  });
  it("只有显式测试才生成，并提交所选模型", async () => {
    const { api, connection } = fixture();
    connection.credentialConfigured = true;
    await mount(api);
    await configure();
    await click("测试与维护");
    expect(api.testGeneration).not.toHaveBeenCalled();
    await select("测试模型", "model-b");
    await click("测试生成");
    expect(api.testGeneration).toHaveBeenCalledWith({
      connectionId: "c1",
      model: "model-b",
    });
    expect(el.textContent).toContain("model-b 测试成功");
  });
  it("移除失败时保留服务和失败原因", async () => {
    const { api } = fixture();
    api.remove = vi.fn(async () => ({
      ok: false as const,
      error: "有执行中的任务",
    }));
    await mount(api);
    await configure();
    await click("测试与维护");
    await click("移除服务");
    expect(api.remove).not.toHaveBeenCalled();
    await click("确认移除");
    expect(el.textContent).toContain("有执行中的任务");
    expect(el.querySelector('[data-connection-id="c1"]')).not.toBeNull();
  });
  it("首次读取失败提供重试", async () => {
    const { api } = fixture();
    api.list = vi.fn(async () => ({ ok: false as const, error: "后端不可用" }));
    await mount(api);
    expect(el.textContent).toContain("后端不可用");
    await click("重新加载");
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

it("保存完整接口地址后显示规范化 Base URL，已保存的 Key 可继续保留", async () => {
  const { api, connection } = fixture();
  api.configure = vi.fn(async () => {
    connection.baseUrl = "https://api.example/v1";
    connection.credentialConfigured = true;
    return ok({ connectionId: "c1", models: ["model-a"] });
  });
  await mount(api);
  await input("Base URL", "https://api.example/v1/chat/completions");
  await input("API Key", "sk-value");
  await click("保存并读取模型");
  expect(
    el.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!.value,
  ).toBe("https://api.example/v1");
  expect(
    [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "保存并读取模型",
    )!.disabled,
  ).toBe(false);
});

it("从助手管理编辑时只显示当前服务，保存保留身份与已有 Key", async () => {
  const { api, connection } = fixture();
  connection.credentialConfigured = true;
  connection.baseUrl = "https://api.example/v1";
  const onSaved = vi.fn();
  await act(async () => root.render(<SdkAgentSettingsPanel remote={api} connectionId="c1" onSaved={onSaved} />));
  expect(el.querySelector('[data-connection-id]')).toBeNull();
  expect(el.textContent).not.toContain("配置其他服务");
  expect(el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!.value).toBe("");
  await click("保存并读取模型");
  expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c1", expectedEpoch: 1, expectedRevision: 1 }));
  expect(vi.mocked(api.configure).mock.calls[0]![0]).not.toHaveProperty("secret");
  expect(api.testGeneration).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith("c1");
});

it("失效的管理入口不会退回新建服务", async () => {
  const { api } = fixture();
  await act(async () => root.render(<SdkAgentSettingsPanel remote={api} connectionId="removed" onSaved={vi.fn()} />));
  expect(el.textContent).toContain("此助手已不存在");
  expect(el.querySelector("form")).toBeNull();
  expect(api.configure).not.toHaveBeenCalled();
});

it("通用请求失败提供恢复建议且保留填写内容", async () => {
  const { api } = fixture();
  vi.mocked(api.configure).mockResolvedValue({ ok: false, error: "请求失败" });
  await mount(api);
  await input("Base URL", "https://ui-test.invalid/v1");
  await input("API Key", "ui-test-key-not-real");
  await click("保存并读取模型");
  expect(el.textContent).toContain("请检查服务地址与后端连接后重试");
  expect(el.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!.value).toBe("ui-test-key-not-real");
  expect(api.testGeneration).not.toHaveBeenCalled();
});
