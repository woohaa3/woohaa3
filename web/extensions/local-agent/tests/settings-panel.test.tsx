/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalAgentSettingsPanel } from "../src/frontend/settings-panel.js";
import type { LocalAgentRemote } from "../src/frontend/remote.js";

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
function remote(): LocalAgentRemote {
  return {
    list: vi.fn(async () =>
      ok({
        connections: [],
        adapters: [
          {
            installed: true,
            running: false,
            managed: false,
            note: "已找到工具",
            adapterId: "codex-appserver",
            label: "Codex",
            transport: "stdio-jsonrpc",
            requiresLocalLogin: true,
            supportedVersions: "0.162.x",
          },
        ],
        locationNote: "后端机器",
      }),
    ),
    create: vi.fn(async () => ok({ connectionId: "c1" })),
    check: vi.fn(async () =>
      ok({
        transport: "ready",
        credential: "unknown",
        modelAccess: "unknown",
        tools: "unknown",
        note: "transport=ready",
      }),
    ),
    remove: vi.fn(async () => ok({ removed: true })),
  };
}
async function click(text: string) {
  await act(async () =>
    [...el.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === text)!
      .click(),
  );
}
it("打开即检测安装和运行状态，不出现创建或命名表单", async () => {
  const api = remote();
  await act(async () =>
    root.render(
      <StrictMode>
        <LocalAgentSettingsPanel remote={api} />
      </StrictMode>,
    ),
  );
  expect(api.list).toHaveBeenCalled();
  expect(el.querySelector(".settings-section__badge")).toBeNull();
  expect(el.textContent).not.toContain("已找到工具");
  expect(el.querySelector('[data-adapter-id="codex-appserver"]')?.textContent).toContain("已安装 · 未运行");
  expect(el.textContent).not.toMatch(/诊断|CODEX_HOME|默认端口|配置链接/);
  expect(el.textContent).not.toMatch(/WOOHAA3_LOCAL_AGENT_ENABLED|当前部署尚未开放本机工具/);
  expect(el.querySelector("form")).toBeNull();
  expect(el.textContent).not.toMatch(/添加连接|连接名称|新建连接/);
  await click("使用此工具");
  expect(api.create).toHaveBeenCalledWith({
    adapterId: "codex-appserver",
    useDetected: true,
  });
  expect(api.check).not.toHaveBeenCalled();
});
it("手动重新检测更新运行状态", async () => {
  const api = remote();
  await act(async () => root.render(<LocalAgentSettingsPanel remote={api} />));
  const data = await api.list();
  if (!data.ok) throw new Error();
  api.list = vi.fn(async () =>
    ok({
      ...data.value,
      adapters: data.value.adapters.map((adapter) => ({
        ...adapter,
        running: true,
      })),
    }),
  );
  await click("重新检测");
  expect(el.querySelector('[data-adapter-id="codex-appserver"]')?.textContent).toContain("已安装 · 运行中");
});
it("仅检测到外部服务而没有 CLI 时显示安装指引，不冒称可接管", async () => {
  const api = remote();
  const data = await api.list();
  if (!data.ok) throw new Error();
  api.list = vi.fn(async () =>
    ok({
      ...data.value,
      adapters: data.value.adapters.map((adapter) => ({
        ...adapter,
        installed: false,
        running: true,
      })),
    }),
  );
  await act(async () => root.render(<LocalAgentSettingsPanel remote={api} />));
  expect(el.textContent).toContain("已发现服务；安装对应工具后可使用。");
  expect(
    [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "使用此工具",
    )!.disabled,
  ).toBe(true);
});
it("停用失败保留工具配置和确认状态", async () => {
  const api = remote();
  const data = await api.list();
  if (!data.ok) throw new Error();
  api.list = vi.fn(async () =>
    ok({
      ...data.value,
      connections: [
        {
          connectionId: "c1",
          adapterId: "codex-appserver",
          name: "Codex",
          label: "Codex",
          runCategory: "local-appserver",
          authMode: "local-login",
          configRevision: 1,
          requiresLocalLogin: true,
          executableInstalled: true,
          running: false,
        },
      ],
    }),
  );
  api.remove = vi.fn(async () => ({
    ok: false as const,
    error: "任务执行中，暂时不能停用",
  }));
  await act(async () => root.render(<LocalAgentSettingsPanel remote={api} />));
  await click("停用");
  expect(api.remove).not.toHaveBeenCalled();
  await click("确认停用");
  expect(el.textContent).toContain("暂时不能停用");
  expect(el.textContent).toContain("确认停用");
});
it("每十秒自动更新，卸载后停止检测", async () => {
  vi.useFakeTimers();
  const api = remote();
  try {
    await act(async () =>
      root.render(<LocalAgentSettingsPanel remote={api} />),
    );
    const initial = vi.mocked(api.list).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.list).toHaveBeenCalledTimes(initial + 1);
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(api.list).toHaveBeenCalledTimes(initial + 1);
  } finally {
    vi.useRealTimers();
  }
});

it("管理入口只显示当前助手，停用成功返回列表", async () => {
  const api = remote();
  const data = await api.list();
  if (!data.ok) throw new Error();
  const connection = { connectionId: "c1", adapterId: "codex-appserver", name: "Codex", label: "Codex", runCategory: "local-appserver" as const, authMode: "local-login" as const, configRevision: 1, requiresLocalLogin: true, executableInstalled: true, running: false };
  vi.mocked(api.list).mockResolvedValue(ok({ ...data.value, connections: [connection], adapters: [...data.value.adapters, { ...data.value.adapters[0]!, adapterId: "opencode-appserver", label: "OpenCode" }] }));
  const onSaved = vi.fn();
  await act(async () => root.render(<LocalAgentSettingsPanel remote={api} connectionId="c1" onSaved={onSaved} />));
  expect(el.querySelector('[data-adapter-id="codex-appserver"]')).not.toBeNull();
  expect(el.querySelector('[data-adapter-id="opencode-appserver"]')).toBeNull();
  await click("停用");
  expect(onSaved).not.toHaveBeenCalled();
  await click("确认停用");
  expect(api.remove).toHaveBeenCalledWith("c1");
  expect(onSaved).toHaveBeenCalledWith("");
});
