import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectionCodexHome,
  inheritedMcpServerNames,
  inheritedPluginNames,
  parseMcpServerNames,
  parsePluginNames,
  prepareCodexConfigDir,
  resolveCodexHome,
} from "./codex-home.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "woohaa-codex-home-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex 本机配置复用", () => {
  it("解析来源 home：CODEX_HOME 优先，否则 HOME/.codex", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    expect(resolveCodexHome({ HOME: home, CODEX_HOME: "" })).toBe(path.resolve(codex));

    const explicit = path.join(root, "explicit-codex");
    mkdirSync(explicit, { recursive: true });
    expect(resolveCodexHome({ HOME: home, CODEX_HOME: explicit })).toBe(path.resolve(explicit));
    expect(resolveCodexHome({ HOME: path.join(root, "missing"), CODEX_HOME: "" })).toBeNull();
  });

  it("连接进程的 home 跟 configDir，只有子进程继承了 CODEX_HOME 才用它", () => {
    const root = tempRoot();
    const configDir = path.join(root, "connection", "config");
    expect(connectionCodexHome(configDir, { CODEX_HOME: "" })).toBe(path.resolve(configDir, ".codex"));
    const explicit = path.join(root, "explicit");
    expect(connectionCodexHome(configDir, { CODEX_HOME: explicit })).toBe(path.resolve(explicit));
  });

  // Windows 建文件软链要开发者模式/管理员权限；生产代码在链接失败时会优雅降级，
  // 但这几条用例断言的是"链接建成了"，fixture 在 Windows 上搭不出来。
  it.skipIf(process.platform === "win32")("为连接创建只读配置链接，不覆盖已存在的专用配置", () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const configDir = path.join(root, "connection", "config");
    mkdirSync(source, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(source, "config.toml"), 'model_provider = "custom"\n');
    writeFileSync(path.join(source, "auth.json"), '{"token":"secret"}\n');

    const first = prepareCodexConfigDir(configDir, source);
    expect(first.sourceFound).toBe(true);
    expect(first.linked.sort()).toEqual(["auth.json", "config.toml"]);
    expect(readFileSync(path.join(configDir, ".codex", "config.toml"), "utf8")).toContain("custom");

    // 用户给该连接单独准备的配置优先，不被来源覆盖。
    const own = path.join(configDir, ".codex", "config.toml");
    rmSync(own);
    writeFileSync(own, 'model = "own"\n');
    const second = prepareCodexConfigDir(configDir, source);
    expect(second.linked).toEqual([]);
    expect(readFileSync(own, "utf8")).toContain("own");
  });

  it("只从 config.toml 提取 MCP server 名，不读取配置值", () => {
    expect(
      parseMcpServerNames(
        [
          "[mcp_servers.model-canvas]",
          'url = "http://localhost:5320"',
          '[mcp_servers."with space"]',
          'url = "http://localhost:1"',
          "[mcp_servers.other] # trailing comment",
          'url = "http://localhost:2"',
          "[mcp_servers.other.env]",
          'A = "1"',
          "# [mcp_servers.commented]",
          "[model_providers.custom]",
          'experimental_bearer_token = "secret"',
        ].join("\n"),
      ),
    ).toEqual(["model-canvas", "with space", "other"]);
  });

  it("读取连接目录中链接后的继承 MCP 名", () => {
    const root = tempRoot();
    const configDir = path.join(root, "config");
    mkdirSync(path.join(configDir, ".codex"), { recursive: true });
    writeFileSync(
      path.join(configDir, ".codex", "config.toml"),
      "[mcp_servers.model-canvas]\nurl = \"http://localhost:5320\"\n",
    );
    expect(inheritedMcpServerNames(configDir)).toEqual(["model-canvas"]);
    expect(inheritedMcpServerNames(path.join(root, "missing"))).toEqual([]);
  });

  it("只从 config.toml 提取插件名，不读取配置值", () => {
    expect(
      parsePluginNames(
        [
          '[plugins."codex-app-tools@openai-bundled"]',
          "enabled = true",
          '[plugins."browser@openai-bundled"]',
          "enabled = true",
          "[plugins.local_search]",
          "enabled = true",
          "# [plugins.commented]",
          "[mcp_servers.node_repl]",
          'command = "/bin/false"',
        ].join("\n"),
      ),
    ).toEqual(["codex-app-tools@openai-bundled", "browser@openai-bundled", "local_search"]);
  });

  it("读取连接目录中链接后的继承插件名", () => {
    const root = tempRoot();
    const configDir = path.join(root, "config");
    mkdirSync(path.join(configDir, ".codex"), { recursive: true });
    writeFileSync(
      path.join(configDir, ".codex", "config.toml"),
      '[plugins."documents@openai-primary-runtime"]\nenabled = true\n',
    );
    expect(inheritedPluginNames(configDir)).toEqual(["documents@openai-primary-runtime"]);
    expect(inheritedPluginNames(path.join(root, "missing"))).toEqual([]);
  });
});
