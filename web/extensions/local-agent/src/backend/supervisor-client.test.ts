/**
 * Agent Supervisor 客户端：ensure 在请求 supervisor 之前必须建好 cwd。
 *
 * 回归（2026-10-28）：`cwd` 不存在时 supervisor 的 `spawn(command, { cwd })` 只报
 * `spawn <可执行文件> ENOENT`，看起来像 CLI 没装，实际是工作目录缺失。进程内 spawn
 * 路径（process-manager）一直有 mkdir；Supervisor 模式漏了，只有带 prepareConfigDir
 * 钩子的 codex 顺手把目录建出来，opencode 于是长期表现为「已安装可执行文件但启动 ENOENT」。
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisorProcessManager } from "./supervisor-client.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Agent Supervisor 客户端", () => {
  it("ensure 先建好 workDir/config，再向 supervisor 发请求", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "woohaa3-supervisor-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const socketPath = path.join(root, "supervisor.sock");
    const requests: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
    const server = net.createServer(socket => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const message = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          requests.push(message);
          socket.write(`${JSON.stringify({ id: message.id, ok: true, result: { pid: 4321, loopbackUrl: "http://127.0.0.1:42001", startedAt: 1 } })}\n`);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.push(() => server.close());

    const manager = createSupervisorProcessManager(
      {
        workDirRoot: path.join(root, "agents"),
        portRange: { min: 42000, max: 42010 },
        executableFor: () => "/definitely/installed/opencode"
      },
      { socketPath, token: "test-token", workspaceKey: "test-workspace", portRange: { min: 42000, max: 42010 } }
    );

    const handle = await manager.ensure({ adapterId: "opencode-server", owner: "owner", connectionId: "conn", args: ["serve"], kind: "http" });

    // 请求发出去时 cwd 必须已经存在，否则 supervisor 侧只会得到一句误导性的 ENOENT。
    expect(existsSync(handle.workDir)).toBe(true);
    expect(existsSync(handle.configDir)).toBe(true);
    expect(requests.find(request => request.method === "ensure")?.params).toMatchObject({ cwd: handle.workDir });
  });

  it("Supervisor 不在时给出可执行的错误，而不是裸 connect ENOENT", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "woohaa3-supervisor-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const socketPath = path.join(root, "missing.sock");
    const manager = createSupervisorProcessManager(
      {
        workDirRoot: path.join(root, "agents"),
        portRange: { min: 42000, max: 42010 },
        executableFor: () => "/definitely/installed/opencode"
      },
      { socketPath, token: "test-token", workspaceKey: "test-workspace", portRange: { min: 42000, max: 42010 } }
    );

    // dev 启动器会在 2 秒内自动重启 Supervisor，客户端重试后仍失败才报错；
    // 错误必须说明是哪个通道、端点和该怎么恢复，不能只留下 `connect ENOENT`。
    await expect(manager.ensure({ adapterId: "opencode-server", owner: "owner", connectionId: "conn", args: ["serve"], kind: "http" }))
      .rejects.toThrow(/Agent Supervisor 控制通道不可用（ENOENT .*missing\.sock）/);
  });
});
