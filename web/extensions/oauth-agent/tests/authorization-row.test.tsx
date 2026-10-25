/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatGptAuthorizationRow } from "../src/frontend/authorization-row.js";
import type { ChatGptService } from "../src/frontend/service.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.restoreAllMocks();
});
function service(state = "ready"): ChatGptService {
  const snapshot = {
    auth: { state, account: { email: "creator@example.com" } },
    error: null,
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    refresh: vi.fn(),
    disconnect: vi.fn(async () => ({ ok: true })),
    authorize: vi.fn(async () => ({ ok: false, error: "授权服务暂时不可用" })),
  } as unknown as ChatGptService;
}
async function click(text: string) {
  await act(async () =>
    [...el.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === text)!
      .click(),
  );
}
it("账号与授权状态可见，断开连接需要明确确认", async () => {
  const api = service();
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  expect(el.textContent).toContain("creator@example.com");
  expect(el.querySelector(".settings-section__badge")).toBeNull();
  await click("断开连接");
  expect(api.disconnect).not.toHaveBeenCalled();
  await click("取消");
  expect(api.disconnect).not.toHaveBeenCalled();
  await click("断开连接");
  await click("确认断开");
  expect(api.disconnect).toHaveBeenCalledOnce();
});
it("授权失败关闭占位窗口并显示可读错误，允许再次授权", async () => {
  const api = service("disconnected");
  const close = vi.fn();
  vi.spyOn(globalThis, "open").mockReturnValue({
    close,
    closed: false,
    location: { href: "" },
  } as unknown as Window);
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await click("授权 ChatGPT");
  expect(close).toHaveBeenCalledOnce();
  expect(el.textContent).toContain("授权服务暂时不可用");
  expect(
    [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "授权 ChatGPT",
    )!.disabled,
  ).toBe(false);
});

it("订阅与重新授权异常仍然显示恢复入口", async () => {
  await act(async () => root.render(<ChatGptAuthorizationRow service={service("reauthorization-required")} />));
  expect(el.textContent).toContain("需重新授权");
  expect(el.textContent).toContain("重新授权 ChatGPT");
});

function successfulAuthorization(api: ChatGptService) {
  vi.mocked(api.authorize).mockImplementation(async (open) => {
    open("https://auth.example/authorize?state=test");
    return { ok: true };
  });
}

it("弹窗被拦截时给出提示和原生授权链接，不再静默成功", async () => {
  const api = service("disconnected");
  successfulAuthorization(api);
  const open = vi.spyOn(globalThis, "open").mockReturnValue(null);
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await click("授权 ChatGPT");
  expect(open).toHaveBeenCalledOnce(); // 不在 await 后重复尝试被拦截的 window.open。
  expect(el.textContent).toContain("授权窗口未能打开");
  const link = el.querySelector<HTMLAnchorElement>("a")!;
  expect(link.textContent).toBe("打开授权页面");
  expect(link.href).toBe("https://auth.example/authorize?state=test");
  expect(link.target).toBe("woohaa3-chatgpt-auth");
});

it("打开窗口抛错仍获取授权链接，让用户直接点击继续", async () => {
  const api = service("disconnected");
  successfulAuthorization(api);
  vi.spyOn(globalThis, "open").mockImplementation(() => { throw new Error("popup denied"); });
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await click("授权 ChatGPT");
  expect(api.authorize).toHaveBeenCalledOnce();
  expect(el.textContent).toContain("授权窗口未能打开");
  expect(el.querySelector("a")).not.toBeNull();
});

it("授权请求抛错关闭占位窗口、恢复按钮并可重试", async () => {
  const api = service("disconnected");
  vi.mocked(api.authorize).mockRejectedValueOnce(new Error("网络连接中断"));
  const close = vi.fn();
  vi.spyOn(globalThis, "open").mockReturnValue({ close, closed: false } as unknown as Window);
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await click("授权 ChatGPT");
  expect(close).toHaveBeenCalledOnce();
  expect(el.textContent).toContain("网络连接中断");
  expect(el.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  successfulAuthorization(api);
  vi.mocked(globalThis.open).mockReturnValue(null);
  await click("授权 ChatGPT");
  expect(el.textContent).not.toContain("网络连接中断");
  expect(el.querySelector("a")).not.toBeNull();
});

it("正常授权导航并聚焦新窗口，主面板保留继续入口，关闭后刷新状态", async () => {
  vi.useFakeTimers();
  try {
    const api = service("disconnected");
    successfulAuthorization(api);
    const popup = { location: { href: "" }, closed: false, focus: vi.fn() };
    vi.spyOn(globalThis, "open").mockReturnValue(popup as unknown as Window);
    await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
    await click("授权 ChatGPT");
    expect(globalThis.open).toHaveBeenCalledWith("about:blank", "woohaa3-chatgpt-auth", "width=520,height=640");
    expect(popup.location.href).toBe("https://auth.example/authorize?state=test");
    expect(popup.focus).toHaveBeenCalledOnce();
    expect(el.textContent).toContain("请在新窗口中完成 ChatGPT 授权");
    expect(el.querySelector("a")).not.toBeNull();
    popup.closed = true;
    await act(async () => vi.advanceTimersByTime(500));
    expect(api.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("复用窗口无法导航时仍提供授权链接", async () => {
  const api = service("disconnected");
  successfulAuthorization(api);
  const popup = { closed: false, get location(): Location { throw new Error("cross origin"); } };
  vi.spyOn(globalThis, "open").mockReturnValue(popup as unknown as Window);
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await click("授权 ChatGPT");
  expect(el.textContent).toContain("授权窗口未能打开");
  expect(el.querySelector("a")).not.toBeNull();
});

it("运行时引导只导航设置，不触发授权或自动安装", async () => {
  const api = service("disconnected");
  const onOpenRuntimes = vi.fn();
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} onOpenRuntimes={onOpenRuntimes} />));
  expect(el.textContent).toContain("本机 Codex 程序");
  expect(onOpenRuntimes).not.toHaveBeenCalled();
  expect(api.authorize).not.toHaveBeenCalled();
  await click("管理运行时组件");
  expect(onOpenRuntimes).toHaveBeenCalledOnce();
  expect(api.authorize).not.toHaveBeenCalled();
});

it("cancels an in-flight authorization and ignores its late window callback, then allows retry", async () => {
  const api = service("disconnected");
  api.cancelAuthorization = vi.fn(async () => ({ ok: true }));
  let finish!: () => void;
  let navigate!: (url: string) => void;
  vi.mocked(api.authorize).mockImplementationOnce(async open => {
    navigate = open;
    await new Promise<void>(resolve => { finish = resolve; });
    return { ok: true };
  });
  const popup = { location: { href: "" }, closed: false, close: vi.fn(), focus: vi.fn() };
  vi.spyOn(globalThis, "open").mockReturnValue(popup as unknown as Window);
  await act(async () => root.render(<ChatGptAuthorizationRow service={api} />));
  await act(async () => { [...el.querySelectorAll("button")].find(button => button.textContent === "授权 ChatGPT")!.click(); });
  await click("取消授权");
  expect(api.cancelAuthorization).toHaveBeenCalledOnce();
  await act(async () => { navigate("https://auth.example/late"); finish(); });
  expect(popup.location.href).toBe("");
  expect(el.querySelector("a")).toBeNull();
  expect(popup.close).toHaveBeenCalled();
  successfulAuthorization(api);
  vi.mocked(globalThis.open).mockReturnValue(null);
  await click("授权 ChatGPT");
  expect(el.querySelector("a")?.href).toContain("auth.example/authorize");
  await act(async () => root.render(null));
  expect(api.cancelAuthorization).toHaveBeenCalledTimes(2);
});
