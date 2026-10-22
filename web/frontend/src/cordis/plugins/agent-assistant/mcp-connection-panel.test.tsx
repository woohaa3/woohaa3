/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpInstallationRemote } from "../../services/mcp-installation-remote.js";
import { McpConnectionPanel } from "./mcp-connection-panel.js";
import { setAppBasePathForTesting } from "../../services/app-base-path.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const writeText = vi.fn<(text: string) => Promise<void>>();
let remote: McpInstallationRemote;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const codexClient = {
  id: "codex" as const,
  label: "Codex",
  group: "cli" as const,
  configPath: "/tmp/codex/config.toml",
  configured: false,
  targets: [{ key: "default", label: "用户配置", path: "/tmp/codex/config.toml", configured: false }]
};
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  remote = { detect: vi.fn(async () => ({ ok: true as const, value: { clients: [] } })), install: vi.fn() };
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); document.querySelectorAll(".agent-assistant__mcp-hint").forEach(node => node.remove()); setAppBasePathForTesting(""); vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
async function render(canvasId?: string) { await act(async () => root.render(<McpConnectionPanel canvasId={canvasId} remote={remote} />)); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
const tiles = () => [...host.querySelectorAll<HTMLElement>("[data-mcp-target]")];
const tile = (key: string) => host.querySelector<HTMLElement>(`[data-mcp-target="${key}"]`);
const tileButton = (key: string) => tile(key)!.querySelector("button")!;
async function clickTile(key: string) { await act(async () => tileButton(key).click()); }
/** 悬停提示由 pointer enter 打开（纯图标格子的名称/路径/状态都在提示里）。 */
async function hover(key: string) {
  // 同一时刻只显示一个提示：先让其它格子收到 pointerout，再悬停目标格子。
  await act(async () => {
    for (const other of tiles()) other.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    tile(key)!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  });
}
/** 提示渲染在 body 上的 portal 里（测试没有 UiProvider 的 portal root）。 */
const hint = () => document.querySelector<HTMLElement>(".agent-assistant__mcp-hint");

it.each(["", "/workspace/"])("displays one universal manual guide with the public prefix (%s), without requests or a canvas", async prefix => {
  setAppBasePathForTesting(prefix);
  const fetch = vi.spyOn(globalThis, "fetch");
  await render();
  expect(host.textContent).not.toContain("操作当前画布");
  expect(host.querySelectorAll("code")).toHaveLength(1);
  const publicUrl = `${window.location.origin}${prefix || "/"}mcp/model-canvas`;
  const manual = host.querySelector("details")!;
  expect(manual.open).toBe(false);
  expect([...manual.querySelectorAll("button")].map(button => button.textContent)).toEqual(["复制安装指引"]);
  const content = manual.querySelector("code")!.textContent;
  expect(content).toBe(`安装这个 MCP 服务：${publicUrl}`);
  await click("复制安装指引");
  expect(writeText).toHaveBeenLastCalledWith(content);
  expect(host.textContent).toContain("已复制；请在客户端完成安装。");
  expect(host.textContent).not.toMatch(/已安装|已连接|已授权/);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps selectable content on failure, clears failure on retry and reports each copy separately", async () => {
  await render("canvas-1");
  const content = host.querySelector("code")!.textContent;
  writeText.mockRejectedValueOnce(new Error("denied"));
  await click("复制安装指引");
  expect(host.textContent).toContain("复制失败，请手动选择并复制内容");
  expect(host.textContent).not.toContain("已复制");
  expect(host.querySelector("code")!.textContent).toBe(content);
  await click("复制安装指引");
  expect(host.textContent).not.toContain("复制失败");
  await click("复制画布指引");
  expect(writeText.mock.calls.at(-1)?.[0]).toContain("画布 canvas-1");
  expect(host.querySelectorAll(".agent-assistant__mcp-field > p")).toHaveLength(2);
});

it.each(["resolve", "reject"] as const)("discards late %s feedback after a public URL change, even when switching back", async outcome => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  writeText.mockReturnValueOnce(new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
  await render("canvas-1");
  await click("复制安装指引");
  setAppBasePathForTesting("/changed/"); await render("canvas-1");
  setAppBasePathForTesting(""); await render("canvas-1");
  await act(async () => outcome === "resolve" ? resolve() : reject(new Error("denied")));
  expect(host.textContent).not.toMatch(/已复制|复制失败/);
  await click("复制安装指引");
  expect(host.textContent).toContain("已复制");
});

it("discards late canvas feedback and updates only the canvas payload on a context change", async () => {
  let resolve!: () => void;
  writeText.mockReturnValueOnce(new Promise<void>(yes => { resolve = yes; }));
  await render("canvas-1");
  const installation = host.querySelector("code")!.textContent;
  await click("复制画布指引");
  await render("canvas-2");
  await act(async () => resolve());
  expect(host.textContent).not.toContain("已复制");
  expect(host.textContent).not.toContain("canvas-1");
  expect(host.querySelector("code")!.textContent).toBe(installation);
  await click("复制画布指引");
  expect(writeText.mock.calls.at(-1)?.[0]).toContain("画布 canvas-2");
  await render();
  expect(host.textContent).not.toContain("操作当前画布");
});

it("以宫格展示：每格只有品牌图形，名称与配置路径放在悬停提示里", async () => {
  remote.detect = vi.fn(async () => ({ ok: true as const, value: { clients: [codexClient] } }));
  await render();
  const grid = host.querySelector(".agent-assistant__mcp-grid")!;
  expect(grid).not.toBeNull();
  // 格子里不常驻名称与路径文本，只有图形。
  expect(tile("codex:default")!.textContent).toBe("");
  expect(tile("codex:default")!.querySelector("[data-mcp-client-logo=codex]")).not.toBeNull();
  expect(host.textContent).not.toContain("/tmp/codex/config.toml");
  await hover("codex:default");
  expect(hint()!.textContent).toContain("Codex");
  expect(hint()!.textContent).toContain("/tmp/codex/config.toml");
  expect(hint()!.textContent).toContain("点击安装");
});

it("按命令行/编辑器分组，多目标客户端逐目标一格且独立安装", async () => {
  const harness = {
    ...codexClient,
    id: "deepseek-harness" as const,
    label: "DeepSeek Harness",
    configPath: "/tmp/dsh/profiles/web/cordis.patch.yml",
    targets: [
      { key: "web", label: "web profile", path: "/tmp/dsh/profiles/web/cordis.patch.yml", configured: false },
      { key: "desktop", label: "desktop profile", path: "/tmp/dsh/profiles/desktop/cordis.patch.yml", configured: false, error: "该 profile 未安装 MCP 客户端插件" }
    ]
  };
  remote.detect = vi.fn(async () => ({ ok: true as const, value: { clients: [codexClient, harness] } }));
  remote.install = vi.fn<McpInstallationRemote["install"]>(async (id, targetKey) => {
    const client = id === "deepseek-harness" ? harness : codexClient;
    return { ok: true, value: { client: { ...client, targets: client.targets.map(item => item.key === targetKey ? { ...item, configured: true, error: undefined } : item) }, changed: true } };
  });
  await render();
  expect([...host.querySelectorAll("[data-mcp-group]")].map(node => node.getAttribute("data-mcp-group"))).toEqual(["cli"]);
  expect(tiles()).toHaveLength(3);
  await hover("deepseek-harness:web");
  expect(hint()!.textContent).toContain("DeepSeek Harness — web profile");
  await hover("deepseek-harness:desktop");
  expect(hint()!.textContent).toContain("DeepSeek Harness — desktop profile");
  // 检测阶段就存在的目标错误不需要悬停即可见。
  expect(host.textContent).toContain("该 profile 未安装 MCP 客户端插件");
  expect(tile("deepseek-harness:desktop")!.dataset.state).toBe("error");
  await clickTile("codex:default");
  expect(remote.install).toHaveBeenCalledWith("codex", "default");
  expect(tile("codex:default")!.dataset.state).toBe("installed");
  await clickTile("deepseek-harness:web");
  expect(remote.install).toHaveBeenLastCalledWith("deepseek-harness", "web");
  expect(tile("deepseek-harness:web")!.dataset.state).toBe("installed");
  // 已安装的目标不可重复点击；未安装的仍可点击。
  expect(tileButton("codex:default").disabled).toBe(true);
  expect(tileButton("deepseek-harness:desktop").disabled).toBe(false);
  expect(host.textContent).toContain("DeepSeek Harness — web profile：配置已写入，重新打开客户端后使用。");
  expect(host.textContent).toContain("该 profile 未安装 MCP 客户端插件");
});
it("空态文案不写死客户端名称", async () => {
  await render();
  expect(host.textContent).toContain("未检测到受支持的客户端");
  expect(host.textContent).not.toMatch(/Codex|OpenCode/);
});
it("检测到客户端才显示安装格；点击后由宿主自动写入，安装不当作已连接", async () => {
  remote.detect = vi.fn(async () => ({ ok: true as const, value: { clients: [codexClient] } }));
  remote.install = vi.fn<McpInstallationRemote["install"]>(async (_id, targetKey) => ({ ok: true, value: { client: { ...codexClient, configured: true, targets: codexClient.targets.map(item => item.key === targetKey ? { ...item, configured: true } : item) }, changed: true } }));
  await render("canvas");
  expect(remote.detect).toHaveBeenCalledTimes(1);
  expect(remote.install).not.toHaveBeenCalled();
  expect(tileButton("codex:default").disabled).toBe(false);
  await clickTile("codex:default");
  expect(remote.install).toHaveBeenCalledWith("codex", "default");
  expect(host.textContent).toContain("配置已写入，重新打开客户端后使用");
  expect(host.textContent).not.toContain("已连接");
  expect(tileButton("codex:default").disabled).toBe(true);
  expect(tile("codex:default")!.querySelector(".agent-assistant__mcp-badge")).not.toBeNull();
  expect(writeText).not.toHaveBeenCalled();
});
it("检测错误可重试，安装错误不会标为已安装且允许重试", async () => {
  remote.detect = vi.fn().mockResolvedValueOnce({ ok: false, error: "无法检测", code: "unavailable" })
    .mockResolvedValue({ ok: true, value: { clients: [{ ...codexClient, id: "opencode", label: "OpenCode", configPath: "/tmp/opencode.json", targets: [{ key: "default", label: "用户配置", path: "/tmp/opencode.json", configured: false }] }] } });
  remote.install = vi.fn().mockResolvedValueOnce({ ok: false, error: "文件不可写", code: "conflict" })
    .mockResolvedValue({ ok: true, value: { client: { ...codexClient, id: "opencode", configured: true, targets: codexClient.targets.map(item => ({ ...item, configured: true })) }, changed: true } });
  await render();
  expect(host.textContent).toContain("无法检测");
  expect(tiles()).toHaveLength(0);
  await click("重新检测");
  await clickTile("opencode:default");
  expect(host.textContent).toContain("文件不可写");
  expect(tile("opencode:default")!.dataset.state).toBe("error");
  expect(tileButton("opencode:default").disabled).toBe(false);
  await clickTile("opencode:default");
  expect(host.textContent).toContain("OpenCode：配置已写入，重新打开客户端后使用。");
  expect(host.textContent).not.toContain("文件不可写");
  expect(tile("opencode:default")!.dataset.state).toBe("installed");
});
