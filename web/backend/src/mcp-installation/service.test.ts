import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { createMcpInstaller as create } from "./service.js";
let home: string;
let env: NodeJS.ProcessEnv;
const url = "http://localhost:5173/workspace/mcp/model-canvas";
const name = "woohaa3-model-canvas";
// 固定配置根：Windows 下 `configRoot` 会走 %APPDATA%，而 fixture 按 ~/.config 布局。
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "woohaa-mcp-")); env = { HOME: home, PATH: path.join(home, "bin"), XDG_CONFIG_HOME: path.join(home, ".config") }; await mkdir(env.PATH!); });
const createMcpInstaller = (options: Parameters<typeof create>[0] = {}) => create({ applicationsDir: path.join(home, "Applications"), ...options });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
// Windows 上 `executable()` 先找 `<name>.exe` / `<name>.cmd`，无后缀的脚本不会被认成可执行。
async function installed(id: string) { const exe = path.join(env.PATH!, process.platform === "win32" ? `${id}.cmd` : id); await writeFile(exe, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); return exe; }
async function config(text: string, file = path.join(home, ".config/opencode/opencode.jsonc")) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; }
it("只列出实际发现的客户端；检测不创建配置", async () => {
  const service = createMcpInstaller({ env });
  expect((await service.detect(url)).clients).toEqual([]);
  await installed("opencode");
  const clients = (await service.detect(url)).clients;
  expect(clients.map(c => c.id)).toEqual(["opencode"]);
  expect(clients[0]?.configured).toBe(false);
  await expect(readFile(clients[0]!.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.install("codex", url)).rejects.toThrow("未找到");
});
it("自动创建 OpenCode 配置，重复安装不写入", async () => {
  await installed("opencode");
  const service = createMcpInstaller({ env });
  const result = await service.install("opencode", url);
  expect(result.client.configured).toBe(true);
  expect(parse(await readFile(result.client.configPath, "utf8"))).toEqual({ mcp: { [name]: { type: "remote", url, enabled: true } } });
  expect((await service.install("opencode", url)).changed).toBe(false);
});
it("JSONC 注释、已有配置和其他 MCP 原样保留；JSONC 优先于 JSON", async () => {
  const text = '{\n // keep this comment\n "provider": {"token": "secret"},\n "mcp": { "other": {"type":"local", "command":["test"]}, },\n}\n';
  const file = await config(text);
  const json = await config('{"model":"keep"}', file.replace(/jsonc$/, "json"));
  const service = createMcpInstaller({ env });
  expect((await service.detect(url)).clients[0]?.configPath).toBe(file);
  await service.install("opencode", url);
  const next = await readFile(file, "utf8");
  expect(next).toContain('// keep this comment');
  expect(next).toContain('"provider": {"token": "secret"}');
  expect(parse(next).mcp.other).toEqual(parse(text).mcp.other);
  expect(await readFile(json, "utf8")).toBe('{"model":"keep"}');
  expect(JSON.stringify(await service.detect(url))).not.toContain("secret");
});
it("遵从显式 OpenCode 配置和 XDG 路径", async () => {
  await installed("opencode");
  env.XDG_CONFIG_HOME = path.join(home, "xdg");
  expect((await createMcpInstaller({ env }).detect(url)).clients[0]?.configPath).toBe(path.join(home, "xdg/opencode/opencode.json"));
  env.OPENCODE_CONFIG = path.join(home, "custom.jsonc");
  await config('{/* custom */ "mcp":{}}', env.OPENCODE_CONFIG);
  const result = await createMcpInstaller({ env }).install("opencode", url);
  expect(result.client.configPath).toBe(env.OPENCODE_CONFIG);
  expect(await readFile(env.OPENCODE_CONFIG, "utf8")).toContain("/* custom */");
});
it.each(['{"mcp":', '{"mcp": []}', '{"mcp": {"woohaa3-model-canvas": {"type":"local","command":["other"]}}}'])("错误或冲突配置不修改：%s", async text => {
  const file = await config(text);
  const service = createMcpInstaller({ env });
  await expect(service.install("opencode", url)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(text);
});
it("启用本服务时保留其自定义头和其他字段", async () => {
  const file = await config(JSON.stringify({ mcp: { [name]: { type: "remote", url, enabled: false, headers: { "X-Custom": "keep" } } } }));
  await createMcpInstaller({ env }).install("opencode", url);
  expect(parse(await readFile(file, "utf8")).mcp[name]).toEqual({ type: "remote", url, enabled: true, headers: { "X-Custom": "keep" } });
});
it("Codex 使用固定参数和实际 CODEX_HOME，CLI 失败不宣称已安装", async () => {
  const exe = await installed("codex");
  env.CODEX_HOME = path.join(home, "custom-codex");
  const file = await config('model = "keep"\n', path.join(env.CODEX_HOME, "config.toml"));
  const runCodex = vi.fn(async () => { throw new Error("failed"); });
  const service = createMcpInstaller({ env, runCodex });
  await expect(service.install("codex", url)).rejects.toThrow();
  expect(runCodex).toHaveBeenCalledWith(exe, ["mcp", "add", name, "--url", url], expect.objectContaining({ CODEX_HOME: env.CODEX_HOME }));
  expect(await readFile(file, "utf8")).toBe('model = "keep"\n');
  expect((await service.detect(url)).clients[0]?.configured).toBe(false);
});
it("Codex 已安装状态来自 TOML，不误用其他 MCP 或 disabled 状态", async () => {
  await installed("codex");
  const file = await config(`[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nenabled = true\n`, path.join(home, ".codex/config.toml"));
  const runCodex = vi.fn();
  const service = createMcpInstaller({ env, runCodex });
  expect((await service.install("codex", url)).changed).toBe(false);
  expect(runCodex).not.toHaveBeenCalled();
  await writeFile(file, "bad = [");
  expect((await service.detect(url)).clients[0]?.error).toContain("格式有误");
  await expect(service.install("codex", url)).rejects.toThrow("格式有误");
  expect(runCodex).not.toHaveBeenCalled();
});
// NTFS 没有 POSIX 权限位，`chmod 0o500` 不生效；只有非 Windows、非 root 才能构造"不可写"。
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("不可写目录返回失败并保留原文件", async () => {
  const file = await config('{}');
  await chmod(path.dirname(file), 0o500);
  try { await expect(createMcpInstaller({ env }).install("opencode", url)).rejects.toThrow(); expect(await readFile(file, "utf8")).toBe('{}'); }
  finally { await chmod(path.dirname(file), 0o700); }
});

// Windows 建文件软链要开发者模式/管理员权限，fixture 搭不出来。
it.skipIf(process.platform === "win32")("符号链接配置写到原目标，不替换用户的链接", async () => {
  const destination = await config('{/* linked */ "model":"keep"}', path.join(home, "linked.jsonc"));
  const file = path.join(home, ".config/opencode/opencode.jsonc");
  await mkdir(path.dirname(file), { recursive: true }); await symlink(destination, file);
  await createMcpInstaller({ env }).install("opencode", url);
  expect(parse(await readFile(destination, "utf8")).mcp[name].url).toBe(url);
  expect(await readFile(file, "utf8")).toContain("/* linked */");
});

it("重新安装更新本应用端点且保留其他 MCP", async () => {
  const file = await config(JSON.stringify({ mcp: { [name]: { type: "remote", url: "http://localhost:1111/old/mcp", enabled: true }, other: { type: "remote", url: "https://example.invalid/mcp" } } }));
  const result = await createMcpInstaller({ env }).install("opencode", url);
  expect(result.changed).toBe(true);
  const data = parse(await readFile(file, "utf8"));
  expect(data.mcp[name].url).toBe(url);
  expect(data.mcp.other.url).toBe("https://example.invalid/mcp");
});

it("并发安装不交错写入，成功后释放安装锁", async () => {
  await installed("codex");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runCodex = vi.fn(async () => {
    entered(); await gate;
    await config(`[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\n`, path.join(home, ".codex/config.toml"));
  });
  const service = createMcpInstaller({ env, runCodex });
  const first = service.install("codex", url);
  await started;
  await expect(service.install("codex", url)).rejects.toThrow("正在写入");
  release();
  expect((await first).client.configured).toBe(true);
  expect((await service.install("codex", url)).changed).toBe(false);
  expect(runCodex).toHaveBeenCalledTimes(1);
});
