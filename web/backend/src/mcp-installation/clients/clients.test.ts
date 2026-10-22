import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { Document, parse as parseYaml } from "yaml";
import { applyEntry, entryState, parseConfig } from "../config-format.js";
import { amp } from "./amp.js";
import { cline } from "./cline.js";
import { factoryDroid } from "./factory-droid.js";
import { createMcpInstaller as create } from "../service.js";

const url = "http://localhost:5173/workspace/mcp/model-canvas";
const name = "woohaa3-model-canvas";
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "woohaa-clients-"));
  env = { HOME: home, PATH: path.join(home, "bin") };
  await mkdir(env.PATH!);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const installer = (options: Parameters<typeof create>[0] = {}) => create({ applicationsDir: path.join(home, "Applications"), ...options });
async function binary(name: string) { const file = path.join(env.PATH!, name); await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); return file; }
async function file(target: string, content: string) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return target; }
async function app(target: string) { await mkdir(path.join(home, "Applications", `${target}.app`), { recursive: true }); }

describe("检测证据", () => {
  it("仅配置文件命中即发现；检测不创建任何文件", async () => {
    const config = await file(path.join(home, ".continue", "config.yaml"), "name: keep\n");
    const before = await readdir(home);
    const clients = (await installer({ env }).detect(url)).clients;
    expect(clients.map(item => item.id)).toEqual(["continue"]);
    expect(clients[0]?.configPath).toBe(config);
    expect(await readdir(home)).toEqual(before);
  });

  it("仅应用安装位置命中即发现，且不要求 PATH 可执行文件", async () => {
    await app("Zed");
    expect((await installer({ env }).detect(url)).clients.map(item => item.id)).toEqual(["zed"]);
  });

  it("仅旧版归档路径命中仍发现客户端，但安装写新版路径", async () => {
    await file(path.join(home, ".kimi", "mcp.json"), "{}");
    const clients = (await installer({ env }).detect(url)).clients;
    expect(clients.map(item => item.id)).toEqual(["kimi"]);
    const result = await installer({ env }).install("kimi", url);
    expect(result.client.configPath).toBe(path.join(home, ".kimi-code", "mcp.json"));
    expect(result.client.configured).toBe(true);
    expect(parse(await readFile(path.join(home, ".kimi-code", "mcp.json"), "utf8")).mcpServers[name]).toEqual({ url });
    expect(await readFile(path.join(home, ".kimi", "mcp.json"), "utf8")).toBe("{}");
  });

  it("三类证据均未命中时为空态", async () => {
    expect((await installer({ env }).detect(url)).clients).toEqual([]);
  });
});

describe("JSON/JSONC 合并", () => {
  it("新建单级容器且保留同级其他设置", async () => {
    await binary("opencode");
    const target = await file(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({ model: "keep" }));
    await installer({ env }).install("opencode", url);
    expect(parse(await readFile(target, "utf8"))).toEqual({ model: "keep", mcp: { [name]: { type: "remote", url, enabled: true } } });
  });

  it("多级容器 mcp.servers 写入且保留 mcp 下其他键（ZCode 不写 .agents）", async () => {
    await app("ZCode");
    const target = await file(path.join(home, ".zcode/cli/config.json"), JSON.stringify({ mcp: { timeout: 30, servers: {} }, theme: "dark" }));
    await installer({ env }).install("zcode", url);
    expect(parse(await readFile(target, "utf8"))).toEqual({
      mcp: { timeout: 30, servers: { [name]: { type: "http", url } } },
      theme: "dark"
    });
    await expect(readFile(path.join(home, ".agents/mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("已有条目更新地址并保留其他 MCP；同地址再装幂等", async () => {
    await app("Cursor");
    const target = await file(path.join(home, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: { [name]: { url: "https://old.invalid/mcp" }, other: { url: "https://example.invalid/mcp" } }
    }));
    const service = installer({ env });
    expect((await service.install("cursor", url)).changed).toBe(true);
    expect(parse(await readFile(target, "utf8")).mcpServers).toEqual({
      [name]: { url },
      other: { url: "https://example.invalid/mcp" }
    });
    expect((await service.install("cursor", url)).changed).toBe(false);
  });

  it("同名本地进程条目报冲突且不覆盖", async () => {
    await app("Cursor");
    const original = JSON.stringify({ mcpServers: { [name]: { command: "run-local" } } });
    const target = await file(path.join(home, ".cursor/mcp.json"), original);
    await expect(installer({ env }).install("cursor", url)).rejects.toThrow("移除冲突项");
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("Zed 使用 context_servers 且不影响 agent 等顶层键", async () => {
    await app("Zed");
    const target = await file(path.join(home, ".config/zed/settings.json"), '{ // keep\n "agent": {"default_model": "x"}\n}\n');
    await installer({ env }).install("zed", url);
    const next = await readFile(target, "utf8");
    expect(next).toContain("// keep");
    expect(parse(next).agent).toEqual({ default_model: "x" });
    expect(parse(next).context_servers[name]).toEqual({ url });
  });
});

describe("YAML 写入器", () => {
  it("保留注释与锚点，并追加数组条目", async () => {
    await file(path.join(home, ".continue", "config.yaml"), "");
    const original = "name: keep\n# 顶层注释\nmodels: &base\n  - model: a\nmcpServers:\n  # 已有 MCP\n  - name: other\n    type: stdio\n    command: run\nother: *base\n";
    const target = await file(path.join(home, ".continue", "config.yaml"), original);
    const service = installer({ env });
    await service.install("continue", url);
    const next = await readFile(target, "utf8");
    expect(next).toContain("# 顶层注释");
    expect(next).toContain("# 已有 MCP");
    const data = parseYaml(next);
    expect(data.mcpServers).toEqual([
      { name: "other", type: "stdio", command: "run" },
      { name, type: "streamable-http", url }
    ]);
    expect(data.other).toEqual([{ model: "a" }]);
    await service.install("continue", url);
    expect((parseYaml(await readFile(target, "utf8")).mcpServers as unknown[])).toHaveLength(2);
  });

  it("JSONC 与 YAML 解析对损坏输入统一报格式错误", () => {
    expect(() => parseConfig("{", "json")).toThrow("格式有误");
    expect(() => parseConfig("a: [", "yaml")).toThrow("格式有误");
    expect(() => parseConfig("a = [", "toml")).toThrow("格式有误");
  });
});

describe("按优先级挑目标文件", () => {
  const chain = [".codebuddy/.mcp.json", ".codebuddy/mcp.json", ".codebuddy.json"];
  it.each(chain)("写入已存在的最优先文件：%s", async existing => {
    const exe = await binary("codebuddy");
    const target = await file(path.join(home, existing), JSON.stringify({ mcpServers: {} }));
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe(exe);
      expect(args).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", name, url]);
      await writeFile(path.join(home, existing), JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
    });
    const result = await installer({ env, runCommand }).install("codebuddy", url);
    expect(result.client.configPath).toBe(target);
    expect(result.client.targets.map(item => item.path)).toEqual([target]);
    expect(result.client.configured).toBe(true);
  });

  it("三个都不存在时创建最高优先级文件", async () => {
    await binary("codebuddy");
    const runCommand = vi.fn(async () => {
      await file(path.join(home, ".codebuddy/.mcp.json"), JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
    });
    const result = await installer({ env, runCommand }).install("codebuddy", url);
    expect(result.client.configPath).toBe(path.join(home, ".codebuddy/.mcp.json"));
  });
});

describe("国际命令行客户端", () => {
  it("Claude Code 固定参数、CLAUDE_CONFIG_DIR 与实际文件一致", async () => {
    const exe = await binary("claude");
    env.CLAUDE_CONFIG_DIR = path.join(home, "claude-home");
    const target = path.join(env.CLAUDE_CONFIG_DIR, ".claude.json");
    const runCommand = vi.fn(async () => {
      await file(target, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
    });
    const result = await installer({ env, runCommand }).install("claude-code", url);
    expect(runCommand).toHaveBeenCalledWith(exe, ["mcp", "add", "--transport", "http", "--scope", "user", name, url], expect.objectContaining({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR }));
    expect(result.client.configPath).toBe(target);
    expect(result.client.configured).toBe(true);
  });

  it("命令失败时不宣称已安装，且下一次可重试", async () => {
    await binary("claude");
    const runCommand = vi.fn(async () => { throw new Error("failed"); });
    const service = installer({ env, runCommand });
    await expect(service.install("claude-code", url)).rejects.toThrow("failed");
    expect((await service.detect(url)).clients[0]?.configured).toBe(false);
  });

  it("Gemini CLI 写入 httpUrl 并可读回确认", async () => {
    await binary("gemini");
    const target = path.join(home, ".gemini/settings.json");
    const runCommand = vi.fn(async () => {
      await file(target, JSON.stringify({ mcpServers: { [name]: { httpUrl: url } } }));
    });
    const result = await installer({ env, runCommand }).install("gemini-cli", url);
    expect(result.client.configured).toBe(true);
    expect(parse(await readFile(target, "utf8")).mcpServers[name]).toEqual({ httpUrl: url });
  });

  it("Qwen Code 用 httpUrl 并保留同文件其他设置", async () => {
    await file(path.join(home, ".qwen/settings.json"), JSON.stringify({ theme: "keep", mcpServers: { other: { httpUrl: "https://other.invalid" } } }));
    await installer({ env }).install("qwen-code", url);
    expect(parse(await readFile(path.join(home, ".qwen/settings.json"), "utf8"))).toEqual({
      theme: "keep",
      mcpServers: { other: { httpUrl: "https://other.invalid" }, [name]: { httpUrl: url } }
    });
  });

  it("Amp 嵌套容器只写入 amp.mcpServers，不覆盖同级配置", () => {
    const original = JSON.stringify({ amp: { theme: "keep" }, other: true });
    expect(parse(applyEntry(original, "json", amp.entry, url))).toEqual({
      amp: { theme: "keep", mcpServers: { [name]: { url } } },
      other: true
    });
    expect(amp.writer).toMatchObject({ kind: "command", names: ["amp"] });
  });

  it("Factory Droid 固定参数与既有字段保留", async () => {
    const exe = await binary("droid");
    const target = await file(path.join(home, ".factory/mcp.json"), "{}");
    const runCommand = vi.fn(async () => {
      const merged = applyEntry(await readFile(target, "utf8"), "json", factoryDroid.entry, url);
      await file(target, merged);
    });
    const result = await installer({ env, runCommand }).install("factory-droid", url);
    expect(runCommand).toHaveBeenCalledWith(exe, ["mcp", "add", name, url, "--type", "http"], expect.anything());
    expect(parse(await readFile(target, "utf8")).mcpServers[name]).toEqual({ type: "http", url });
    const original = JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.invalid", disabled: true } } });
    expect(parse(applyEntry(original, "json", factoryDroid.entry, url)).mcpServers.other).toEqual({ type: "http", url: "https://other.invalid", disabled: true });
    expect(result.changed).toBe(true);
  });
});

describe("国产客户端", () => {
  it("Qoder 使用固定参数并在失败时保留原文件", async () => {
    const exe = await binary("qoder");
    const target = await file(path.join(home, ".qoder/settings.json"), '{"keep":true}');
    const runCommand = vi.fn(async () => { throw new Error("failed"); });
    await expect(installer({ env, runCommand }).install("qoder", url)).rejects.toThrow();
    expect(runCommand).toHaveBeenCalledWith(exe, ["mcp", "add", name, url], expect.anything());
    expect(await readFile(target, "utf8")).toBe('{"keep":true}');
  });

  it("ZCode 检测应用安装位置并写 mcp.servers", async () => {
    await app("ZCode");
    const result = await installer({ env }).install("zcode", url);
    expect(result.client.targets.map(item => item.path)).toEqual([path.join(home, ".zcode/cli/config.json")]);
    expect(result.client.configured).toBe(true);
  });

  it("WorkBuddy 保留同级配置且同地址幂等", async () => {
    await app("WorkBuddy");
    await file(path.join(home, ".workbuddy/mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://other.invalid" } }, settings: { theme: "keep" } }));
    const service = installer({ env });
    await service.install("workbuddy", url);
    expect((await service.install("workbuddy", url)).changed).toBe(false);
    expect(parse(await readFile(path.join(home, ".workbuddy/mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { url: "https://other.invalid" }, [name]: { url } },
      settings: { theme: "keep" }
    });
  });

  it("Kimi Code 支持 KIMI_CODE_HOME 覆盖", async () => {
    await file(path.join(home, ".kimi/mcp.json"), "{}");
    env.KIMI_CODE_HOME = path.join(home, "kimi-home");
    const result = await installer({ env }).install("kimi", url);
    expect(result.client.configPath).toBe(path.join(home, "kimi-home/mcp.json"));
  });
});

describe("编辑器客户端", () => {
  it("Cline 写 streamableHttp 而不是缺省 SSE，并使用官方命令", async () => {
    const exe = await binary("cline");
    const target = await file(path.join(home, ".cline/data/settings/cline_mcp_settings.json"), "{}");
    const runCommand = vi.fn(async () => {
      await file(target, applyEntry(await readFile(target, "utf8"), "json", cline.entry, url));
    });
    await installer({ env, runCommand }).install("cline", url);
    expect(runCommand).toHaveBeenCalledWith(exe, ["mcp", "add", "--transport", "http", "--yes", name, url], expect.anything());
    expect(parse(await readFile(target, "utf8")).mcpServers[name]).toEqual({ type: "streamableHttp", url });
  });

  it("Windsurf/Devin 写 serverUrl 且不重复写 url", async () => {
    await app("Windsurf");
    const target = path.join(home, ".config/devin/mcp_config.json");
    await installer({ env }).install("windsurf", url);
    expect(parse(await readFile(target, "utf8")).mcpServers[name]).toEqual({ serverUrl: url });
  });

  it("Copilot 写 ~/.copilot/mcp-config.json，不写 .vscode/mcp.json", async () => {
    await app("Visual Studio Code");
    const result = await installer({ env }).install("copilot", url);
    expect(result.client.configPath).toBe(path.join(home, ".copilot/mcp-config.json"));
    await expect(readFile(path.join(home, ".vscode/mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Cursor 已配置判定按 url 命中", async () => {
    await file(path.join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "https://other.invalid/mcp" } } }));
    const service = installer({ env });
    expect((await service.detect(url)).clients[0]?.configured).toBe(false);
    await service.install("cursor", url);
    expect((await service.detect(url)).clients[0]?.configured).toBe(true);
  });
});

describe("DeepSeek Harness profile 级安装", () => {
  const profile = (name: string) => path.join(home, ".dsh", "profiles", name);
  async function profileWith(name: string, plugin: boolean) {
    const dir = profile(name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${name}`, ...(plugin ? { dependencies: { "@deepseek-ai/dsh-mcp-client": "0.2.1" } } : {}) }));
    await writeFile(path.join(dir, "cordis.patch.yml"), "# profile 注释\n- insert:\n    - id: other\n      name: '@scope/other'\n      config:\n        keep: true\n");
    return dir;
  }

  it("多 profile 展开为独立目标，只列有配置或 package.json 的目录", async () => {
    await profileWith("web", true);
    await profileWith("desktop", true);
    await mkdir(path.join(home, ".dsh/profiles/empty"), { recursive: true });
    const clients = (await installer({ env }).detect(url)).clients;
    expect(clients.map(item => item.id)).toEqual(["deepseek-harness"]);
    expect(clients[0]?.targets.map(item => [item.key, item.label])).toEqual([["desktop", "desktop profile"], ["web", "web profile"]]);
  });

  it("空 profile 目录不产生客户端", async () => {
    await mkdir(path.join(home, ".dsh/profiles/empty"), { recursive: true });
    expect((await installer({ env }).detect(url)).clients).toEqual([]);
  });

  it("新增 patch 项并保留注释与其他 insert 项（DSH 顶层数组形态）", async () => {
    const dir = await profileWith("web", true);
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, "# patch 注释\n- id: include\n  insert:\n    - id: other\n      name: '@scope/other'\n      config:\n        keep: true\n");
    const service = installer({ env });
    const result = await service.install("deepseek-harness", url, "web");
    expect(result.changed).toBe(true);
    const text = await readFile(file, "utf8");
    expect(text).toContain("# patch 注释");
    const data = parseYaml(text) as any[];
    expect(data[0].insert[0]).toEqual({ id: "other", name: "@scope/other", config: { keep: true } });
    expect(data[0].insert[1]).toEqual({ id: name, name: "@deepseek-ai/dsh-mcp-client", config: { serverName: name, transport: "streamable-http", url } });
    expect((await service.install("deepseek-harness", url, "web")).changed).toBe(false);
  });

  it("空 patch 文件与顶层映射兼容形态都能写入", async () => {
    const dir = await profileWith("web", true);
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, "# 只有注释\n[]\n");
    await installer({ env }).install("deepseek-harness", url, "web");
    const data = parseYaml(await readFile(file, "utf8")) as any[];
    expect(data[0].insert[0].config).toEqual({ serverName: name, transport: "streamable-http", url });

    const legacy = await profileWith("legacy", true).then(dir => path.join(dir, "cordis.patch.yml"));
    await writeFile(legacy, "# 旧设计形态\ninsert:\n  - id: other\n    name: '@scope/other'\n    config:\n      keep: true\n");
    await installer({ env }).install("deepseek-harness", url, "legacy");
    expect(parseYaml(await readFile(legacy, "utf8")).insert).toEqual([
      { id: "other", name: "@scope/other", config: { keep: true } },
      { id: name, name: "@deepseek-ai/dsh-mcp-client", config: { serverName: name, transport: "streamable-http", url } }
    ]);
  });

  it("同名 stdio 项报冲突；地址不同则更新", async () => {
    const dir = await profileWith("web", true);
    const file = path.join(dir, "cordis.patch.yml");
    const patch = (transport: string) => ["- insert:", `    - id: ${name}`, "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", `        serverName: ${name}`, `        transport: ${transport}`, "        url: https://old.invalid/mcp", ""].join("\n");
    await writeFile(file, patch("stdio"));
    await expect(installer({ env }).install("deepseek-harness", url, "web")).rejects.toThrow("移除冲突项");
    await writeFile(file, patch("streamable-http"));
    expect((await installer({ env }).install("deepseek-harness", url, "web")).changed).toBe(true);
    expect((parseYaml(await readFile(file, "utf8")) as any[])[0].insert[0].config.url).toBe(url);
  });

  it("profile 缺少插件时拒绝写入且文件字节不变", async () => {
    const dir = await profileWith("web", false);
    const file = path.join(dir, "cordis.patch.yml");
    const original = await readFile(file);
    await expect(installer({ env }).install("deepseek-harness", url, "web")).rejects.toThrow("dsh plugin --profile web add");
    expect(await readFile(file)).toEqual(original);
  });

  it("安装一个 profile 不影响另一个", async () => {
    const web = await profileWith("web", true);
    const desktop = await profileWith("desktop", true);
    const desktopBefore = await readFile(path.join(desktop, "cordis.patch.yml"));
    const result = await installer({ env }).install("deepseek-harness", url, "web");
    expect(result.client.targets.map(item => [item.key, item.configured])).toEqual([["desktop", false], ["web", true]]);
    expect(await readFile(path.join(desktop, "cordis.patch.yml"))).toEqual(desktopBefore);
    expect(await readFile(path.join(web, "cordis.patch.yml"), "utf8")).toContain(url);
  });
});

describe("共享安全机制", () => {
  it("并发安装返回正在写入", async () => {
    await binary("claude");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const target = path.join(home, ".claude.json");
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const runCommand = vi.fn(async () => {
      entered(); await gate;
      await writeFile(target, JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }));
    });
    const service = installer({ env, runCommand });
    const first = service.install("claude-code", url);
    await started;
    await expect(service.install("claude-code", url)).rejects.toThrow("正在写入");
    release();
    expect((await first).client.configured).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("不可写目录报错且原文件不变", async () => {
    await app("Cursor");
    const target = await file(path.join(home, ".cursor/mcp.json"), "{}");
    await chmod(path.dirname(target), 0o500);
    try {
      await expect(installer({ env }).install("cursor", url)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("{}");
    } finally { await chmod(path.dirname(target), 0o700); }
  });
});

it("注册表目标写入的 YAML 文档保留锚点语义", () => {
  const shape = { container: ["mcpServers"], array: true, urlField: "url", fields: (value: string) => ({ type: "streamable-http", url: value }) } as const;
  const doc = new Document({ base: [1], alias: [] });
  expect(doc.toString()).toContain("base");
  expect(parseConfig(applyEntry("mcpServers:\n  - name: keep\n    url: https://keep.invalid\n", "yaml", shape, url), "yaml").mcpServers).toEqual([
    { name: "keep", url: "https://keep.invalid" },
    { name, type: "streamable-http", url }
  ]);
  expect(entryState({ mcpServers: [{ name, url }] }, shape, url)).toBe("configured");
});
