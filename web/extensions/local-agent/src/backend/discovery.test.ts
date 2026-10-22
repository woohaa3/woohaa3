import { mkdtemp, writeFile, chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createLocalAgentDiscovery,
  resolveLocalExecutable,
} from "./discovery.js";
import { LOCAL_AGENT_ADAPTERS } from "../shared.js";
const [codex, opencode, codebuddy] = LOCAL_AGENT_ADAPTERS;
it("从 PATH 找到可执行文件，无需手填部署路径", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-discovery-"));
  try {
    const bin = path.join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    expect(resolveLocalExecutable(null, "codex", { PATH: dir })).toBe(bin);
    expect(resolveLocalExecutable(null, "opencode", { PATH: dir })).toBeNull();
    expect(
      resolveLocalExecutable(path.join(dir, "missing"), "codex", { PATH: dir }),
    ).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("opencode 官方安装目录不在 PATH 时也能发现（显式部署路径仍优先且不做兜底）", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-discovery-home-"));
  try {
    const binDir = path.join(home, ".opencode", "bin");
    await mkdir(binDir, { recursive: true });
    const bin = path.join(binDir, "opencode");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    expect(resolveLocalExecutable(null, "opencode", { HOME: home, PATH: "" })).toBe(bin);
    // 只对 opencode 生效，不把别的工具从固定目录里"变出来"。
    expect(resolveLocalExecutable(null, "codex", { HOME: home, PATH: "" })).toBeNull();
    // 部署显式配置错误时应明确失败，而不是悄悄换用另一份安装。
    expect(
      resolveLocalExecutable(path.join(home, "missing"), "opencode", {
        HOME: home,
        PATH: "",
      }),
    ).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("Windows 上优先选可执行的 .exe/.cmd，跳过同目录不可 spawn 的无扩展名脚本", async () => {
  // npm/pnpm 在 Windows 会同时生成 `codex`（POSIX sh 脚本）与 `codex.cmd`。
  // 无扩展名那个能通过 X_OK，但 spawn 会报 ENOENT/EINVAL/EFTYPE，必须排在后面。
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-discovery-win-"));
  try {
    await writeFile(path.join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(dir, "codex.cmd"), "@echo off\r\n");
    expect(resolveLocalExecutable(null, "codex", { PATH: dir })).toBe(
      path.join(dir, "codex.cmd"),
    );
    // 只有无扩展名脚本时仍会返回它（保留原有兜底），但不优先。
    const bare = await mkdtemp(path.join(os.tmpdir(), "agent-bare-"));
    try {
      await writeFile(path.join(bare, "opencode"), "#!/bin/sh\nexit 0\n");
      expect(resolveLocalExecutable(null, "opencode", { PATH: bare })).toBe(
        path.join(bare, "opencode"),
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("区分未安装、已安装未运行、运行中，Codex 检测不发网络请求", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const absent = createLocalAgentDiscovery({
    executableFor: () => null,
    listProcesses: async () => [],
    fetchImpl,
  });
  expect(await absent(codex, false)).toMatchObject({
    installed: false,
    running: false,
  });
  const installed = createLocalAgentDiscovery({
    executableFor: () => "/bin/codex",
    listProcesses: async () => [],
    fetchImpl,
  });
  expect(await installed(codex, false)).toMatchObject({
    installed: true,
    running: false,
  });
  const running = createLocalAgentDiscovery({
    executableFor: () => "/bin/codex",
    listProcesses: async () => [
      ["/usr/bin/node", "/bin/codex.js", "app-server"],
    ],
    fetchImpl,
  });
  expect(await running(codex, false)).toMatchObject({
    installed: true,
    running: true,
    managed: false,
  });
  expect(await absent(codex, true)).toMatchObject({
    running: true,
    managed: true,
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("只读探测默认端口，支持的协议才标记运行中，共用一次进程快照", async () => {
  const listProcesses = vi.fn(async () => []);
  const fetchImpl = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("4096")
            ? { version: "2.1.0" }
            : { data: { status: "ok" } },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const discover = createLocalAgentDiscovery({
    executableFor: () => null,
    listProcesses,
    fetchImpl,
  });
  const result = await Promise.all([
    discover(opencode, false),
    discover(codebuddy, false),
  ]);
  expect(result.every((item) => item.running && !item.installed)).toBe(true);
  expect(listProcesses).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:4096/api/info",
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:4100/api/v1/health",
    expect.objectContaining({ method: "GET" }),
  );
});
it("HTML、旧版本和需认证响应不冒称协议可用", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const discover = createLocalAgentDiscovery({
    executableFor: () => null,
    listProcesses: async () => [],
    fetchImpl,
  });
  for (const response of [
    new Response("<html>", { headers: { "content-type": "text/html" } }),
    new Response('{"version":"1.0.0"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response("", { status: 401 }),
  ]) {
    fetchImpl.mockResolvedValueOnce(response);
    expect(await discover(opencode, false)).toMatchObject({ running: false });
  }
});
it("端口不可达仍返回安装状态和说明，不启动服务", async () => {
  const discover = createLocalAgentDiscovery({
    executableFor: () => "/bin/opencode",
    listProcesses: async () => [],
    fetchImpl: async () => {
      throw new Error("timeout");
    },
  });
  expect(await discover(opencode, false)).toMatchObject({
    installed: true,
    running: false,
    note: expect.stringContaining("生成时自动启动"),
  });
});
