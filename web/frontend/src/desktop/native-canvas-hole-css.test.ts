/**
 * 桌面原生画布合成：WKWebView 盖在 Metal NSView 上面。
 * 主题切画布防白闪给 `.bevy-canvas-surface` 铺了 `--app-web-backdrop`；浏览器 WASM
 * 把 iframe 画在这个底色之上没问题，原生模式同一块不透明底会把下层 Bevy 完全挡住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const match = CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则：${selector}`);
  return match[1];
}

describe("原生画布在 WebView 下打洞", () => {
  it("原生模式把画布表面和输入 canvas 设为透明，不盖住 Metal 画面", () => {
    expect(CSS).toMatch(
      /html\[data-native-canvas="true"\] \.bevy-canvas-surface,\s*html\[data-native-canvas="true"\] #bevy-canvas\s*\{[^}]*background:\s*transparent/,
    );
  });

  it("浏览器 WASM 仍用主题底色挡住 iframe 首帧浅色清屏", () => {
    expect(ruleBody(".bevy-canvas-surface")).toMatch(/background:\s*var\(--app-web-backdrop\)/);
  });
});
