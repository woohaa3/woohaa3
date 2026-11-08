/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { api, cleanupHarness, declaredSite, local, render } from "./plugin-harness.js";
afterEach(cleanupHarness);

it("零提供者显示添加入口，Agent 直接显示本地连接和模型提供商按钮", async () => {
  const f = await render([], true);
  expect([...f.el.querySelectorAll('[data-empty="true"]')].map(card => card.getAttribute("data-capability"))).toEqual(["agent", "image", "video", "audio"]);
  expect([...f.el.querySelectorAll('[data-capability="agent"] button')].map(button => button.textContent)).toEqual(["连接本地 Agent", "添加模型提供商"]);
  expect(f.el.querySelector('[data-capability="agent"] [aria-haspopup]')).toBeNull();
  expect(f.el.querySelector('[data-capability="agent"]')?.textContent).not.toContain("已配置 0");
  for (const kind of ["model3d", "hosting"]) {
    expect(f.el.querySelector(`[data-capability="${kind}"]`)?.getAttribute("data-empty")).toBe("false");
    expect(f.el.querySelector(`[data-capability="${kind}"]`)?.textContent).toContain(kind === "model3d" ? "暂未接入" : "上传不可用");
  }
  await f.click("连接本地 Agent");
  expect(f.el.querySelector('[data-ai-page="agents"]')?.closest("[hidden]")).toBeNull();
  expect(f.el.querySelector('[data-ai-page="agents"]')?.textContent).toContain("本机工具配置");
  await f.click("能力总览");
  await f.click("添加模型提供商");
  expect(f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')?.textContent).toContain("添加 Agent提供商");
});

it.each([[local], [api]])("Agent 任一类提供者已配置时保持计数，刷新后恢复添加状态", async connection => {
  let connections = [connection];
  const f = await render(connections, true, undefined, {}, {
    listConnections: async () => ({ ok: true, value: connections }),
    listServiceConnections: async () => ({ ok: true, value: [] }),
  });
  const card = () => f.el.querySelector('[data-capability="agent"]')!;
  expect(card().getAttribute("data-empty")).toBe("false");
  expect(card().querySelector('.agent-assistant__capability-add')).toBeNull();
  connections = [];
  await f.click("本地 Agent");
  // Saving configuration refreshes both authoritative directories.
  await f.click("模型提供商");
  await f.click("添加连接");
  await f.configure("我有 API Key");
  await f.click("保存测试连接");
  await f.click("能力总览");
  expect(card().getAttribute("data-empty")).toBe("true");
});

it("读取中与读取失败均不显示零提供者添加样式", async () => {
  let settle!: (value: any) => void;
  const f = await render([], false, undefined, {}, {
    serviceConnectionDirectory: () => new Promise(resolve => { settle = resolve; }),
  });
  const cards = () => f.el.querySelectorAll('[data-empty="true"]');
  expect(cards()).toHaveLength(0);
  await act(async () => settle({ ok: false, code: "offline", error: "目录读取失败" }));
  expect(cards()).toHaveLength(0);
  expect(f.el.querySelector('[data-capability="image"]')?.textContent).toContain("读取失败");
});

it("已有未授权来源时引导完成配置，不另建连接", async () => {
  const f = await render([], true, undefined, {}, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [declaredSite({ credentialConfigured: false })], providers: [], duplicates: [] } }),
  });
  expect(f.el.querySelector('[data-capability="agent"][data-empty="true"]')?.textContent).toContain("完成配置");
  await f.click("Agent");
  expect(f.el.querySelector('[data-capability-detail="agent"]')?.textContent).toContain("声明提供商");
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')?.textContent).toContain("声明提供商");
});

it("添加卡片的网站链接与配置入口独立，缺少网址时点击不进入配置", async () => {
  const snapshot = { settings: ["linked", "missing"].map(id => ({
    key: `providers.${id}.apiKey`, kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true,
    source: null, lockedBy: null, value: null, configured: false, pendingRestart: false, group: id,
  })), plugins: [{ id: "linked-provider", configPrefix: "providers.linked", label: "linked", description: "", layer: "extension" as const,
    settingCount: 1, siteManaged: false, provider: true, website: "https://provider.example.com", icon: "provider" as const,
  }], files: { config: "c", secrets: "s" } };
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: vi.fn() });
  const f = await render([], true, store);
  await f.click("添加连接");
  const drawer = f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')!;
  const close = drawer.querySelector<HTMLButtonElement>('.agent-assistant__drawer-head button')!;
  expect(close.textContent).toBe("");
  const linked = drawer.querySelector<HTMLElement>('[data-kind="provider:linked"]')!;
  const website = linked.querySelector<HTMLAnchorElement>('a')!;
  expect(website.href).toBe("https://provider.example.com/");
  expect(website.target).toBe("_blank");
  expect(website.rel).toContain("noopener");
  expect(website.querySelector("strong")?.textContent).toBe("linked");
  expect(website.querySelector(".agent-assistant__provider-mark")).not.toBeNull();
  website.addEventListener("click", event => event.preventDefault());
  await act(async () => { website.querySelector<HTMLElement>("strong")!.click(); linked.click(); });
  const missing = drawer.querySelector<HTMLElement>('[data-kind="provider:missing"] a')!;
  expect(missing.hasAttribute("href")).toBe(false);
  await act(async () => missing.click());
  expect(drawer.querySelector('.agent-assistant__add')?.getAttribute("data-step")).toBe("selection");
  expect(drawer.querySelector('[data-kind="login"] a')?.getAttribute("href")).toBe("https://chatgpt.com");
  expect(drawer.querySelector('[data-kind="api-key"] a')?.hasAttribute("href")).toBe(false);
  await act(async () => { linked.querySelector<HTMLButtonElement>("button")!.click(); await import("../settings/provider-settings-cards.js"); });
  expect(drawer.querySelector('.agent-assistant__add')?.getAttribute("data-step")).toBe("configuration");
  expect(drawer.querySelector('[data-setting-key="providers.linked.apiKey"] input')).not.toBeNull();
});

it("添加入口按展示顺序混排接入方式与提供商，能力过滤保持相对顺序", async () => {
  const providers = [
    { id: "tokenhub", label: "TokenHub" },
    { id: "cephalon", label: "端脑云", setupOrder: 30 },
    { id: "fal", label: "fal.ai" },
    { id: "runninghub", label: "RunningHub", setupOrder: 20 },
  ];
  const snapshot = { settings: providers.map(({ id }) => ({
    key: `providers.${id}.apiKey`, kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true,
    source: null, lockedBy: null, value: null, configured: false, pendingRestart: false, group: id,
  })), plugins: providers.map(({ id, label, setupOrder }) => ({
    id: `${id}-provider`, configPrefix: `providers.${id}`, label, setupOrder, description: "", layer: "extension" as const,
    settingCount: 1, siteManaged: false, provider: true, modelTypes: ["image"] as const,
  })), files: { config: "c", secrets: "s" } };
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: vi.fn() });
  const f = await render([], true, store);
  await f.click("添加连接");
  const labels = () => [...f.el.querySelectorAll('.agent-assistant__drawer-layer:not([hidden]) .agent-assistant__method strong')].map(item => item.textContent);
  expect(labels()).toEqual(["我有 API Key", "RunningHub", "端脑云", "我有 ChatGPT 账号", "TokenHub", "fal.ai"]);
  await f.click("关闭详情");
  await f.click("能力总览");
  await f.click("图片");
  expect(labels()).toEqual(["RunningHub", "端脑云", "TokenHub", "fal.ai"]);
});
