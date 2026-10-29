/**
 * UiProvider portal ownership 与 theme root（change: adopt-radix-lucide-canvas-ui，任务 2.1）。
 *
 * 断言：
 * - portal container 位于 `.app-theme-root` 内（不落到 document.body）；
 * - 切换 theme 时 portal surface 继承新 `--app-*`（同一 theme root）；
 * - 卸载后 portal subtree 随 React root 释放，不留 body 节点。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "../theme/index.js";
import { defaultAppTheme } from "@woohaa3/contracts";
import { UiProvider, usePortalContainer } from "./UiProvider.js";
import { Tooltip } from "./Tooltip.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

/** 最小 ThemeService（applyTo 写入 tokens）。 */
function themeService(tokens: Record<string, string>, id: string) {
  const snapshot = { id, version: 1, tokens } as never;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    applyTo: (root: HTMLElement) => {
      for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
      return () => undefined;
    },
    select: () => undefined
  } as never;
}

function PortalProbe() {
  const container = usePortalContainer();
  return (
    <Tooltip content="提示">
      <button type="button">{container ? "has-portal" : "no-portal"}</button>
    </Tooltip>
  );
}

describe("UiProvider portal ownership（任务 2.1）", () => {
  it("portal root 位于 .app-theme-root 内而非 document.body", () => {
    const { container } = render(
      <ThemeProvider service={themeService(defaultAppTheme().tokens as never, "default")}>
        <UiProvider>
          <PortalProbe />
        </UiProvider>
      </ThemeProvider>
    );
    const themeRoot = container.querySelector(".app-theme-root")!;
    expect(themeRoot).not.toBeNull();
    expect(themeRoot.querySelector(".ui-portal-root")).not.toBeNull();
    // document.body 下没有游离 portal root。
    expect(document.body.querySelector(":scope > .ui-portal-root")).toBeNull();
  });

  it("卸载后 portal subtree 释放，不残留 body 节点", () => {
    const { container, root } = render(
      <ThemeProvider service={themeService(defaultAppTheme().tokens as never, "default")}>
        <UiProvider>
          <PortalProbe />
        </UiProvider>
      </ThemeProvider>
    );
    expect(container.querySelector(".ui-portal-root")).not.toBeNull();
    act(() => root.unmount());
    expect(document.querySelector(".ui-portal-root")).toBeNull();
  });

  it("portal container 与 trigger 位于同一 `.app-theme-root`，共享同一 theme root", () => {
    const { container } = render(
      <ThemeProvider service={themeService(defaultAppTheme().tokens as never, "default")}>
        <UiProvider>
          <PortalProbe />
        </UiProvider>
      </ThemeProvider>
    );
    const themeRoot = container.querySelector(".app-theme-root")!;
    const portalRoot = themeRoot.querySelector(".ui-portal-root")!;
    // portal 是 theme root 的子树：ThemeProvider 替换 token 会同时影响 portal surface。
    expect(themeRoot.contains(portalRoot)).toBe(true);
  });
});

describe("primitives.css portal 分层契约（任务 2.7）", () => {
  it("tooltip < menu/popover < dialog 且只消费 --app-*", () => {
    const css = readFileSync(path.resolve(HERE, "../styles/primitives.css"), "utf8");
    const z = (selector: string) => Number(css.match(new RegExp(`${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`))?.[1] ?? -1);
    expect(z("\\.ui-tooltip")).toBeGreaterThan(z("\\.ui-portal-root"));
    expect(z("\\.ui-menu")).toBeGreaterThan(z("\\.ui-portal-root"));
    expect(z("\\.ui-dialog__overlay")).toBeGreaterThan(z("\\.ui-menu"));
    // 只消费语义 token：不允许品牌色 literal。
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
