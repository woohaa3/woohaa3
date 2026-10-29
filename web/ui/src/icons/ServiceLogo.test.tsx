/**
 * MCP 客户端品牌图形：覆盖性与渲染安全。
 *
 * 安装宫格用图标代替名称来标识客户端，因此「注册表里的每个客户端都有图形」是界面契约：
 * 缺图形会退回通用图标，届时要在这里补一条并更新来源说明。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { McpClientLogo } from "./ServiceLogo.js";
import { MCP_CLIENT_MARKS } from "./mcp-client-marks.js";

const REGISTRY_IDS = [
  "codex",
  "opencode",
  "claude-code",
  "gemini-cli",
  "qwen-code",
  "amp",
  "factory-droid",
  "qoder",
  "codebuddy",
  "kimi",
  "deepseek-harness",
  "cursor",
  "cline",
  "windsurf",
  "copilot",
  "zed",
  "continue",
  "zcode",
  "workbuddy"
] as const;

describe("MCP 客户端品牌图形", () => {
  it("注册表的每个客户端都有专属图形，未落到通用兜底", () => {
    for (const id of REGISTRY_IDS) {
      const html = renderToStaticMarkup(createElement(McpClientLogo, { client: id }));
      expect(html, id).toContain(`data-mcp-client-logo="${id}"`);
      expect(html, id).not.toContain('data-mcp-client-logo="fallback"');
    }
    expect(Object.keys(MCP_CLIENT_MARKS).sort()).toEqual([...REGISTRY_IDS].sort());
  });

  it("未知客户端回退通用图标，不产生空格子", () => {
    const html = renderToStaticMarkup(createElement(McpClientLogo, { client: "not-a-client" }));
    expect(html).toContain('data-mcp-client-logo="fallback"');
  });

  it("图形原样保留原始配色，不做单色化", () => {
    // 有品牌色的客户端必须输出自己的颜色，而不是 currentColor。
    expect(renderToStaticMarkup(createElement(McpClientLogo, { client: "claude-code" }))).toContain("#D97757");
    expect(renderToStaticMarkup(createElement(McpClientLogo, { client: "kimi" }))).toContain("#1783FF");
    expect(renderToStaticMarkup(createElement(McpClientLogo, { client: "amp" }))).toContain("#F34E3F");
  });

  it("同一页渲染多个同客户端图标时渐变/clip 的 id 不冲突", () => {
    // 宫格里同一客户端可能因多 profile 出现多次：同一棵树内的实例必须拿到不同的 id 后缀。
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(McpClientLogo, { client: "codex" }),
      createElement(McpClientLogo, { client: "codex" })));
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
