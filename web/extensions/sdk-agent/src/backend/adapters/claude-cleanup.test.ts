import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createLeasedTransport } from "../managed-runtime.js";
import { buildAgentSdkRestrictions } from "./agent-sdk-adapter.js";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { createClaudeTransport } from "./claude-transport.js";

describe("Claude cleanup before managed lease release", () => {
  const directories: string[] = [];
  afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  it.each(["throw-close", "reject-return", "never-return", "throw-constructor", "close-without-exit"])("reaps child before releasing when %s", async failure => {
    const root = await mkdtemp(path.join(os.tmpdir(), "woohaa-claude-cleanup-")); directories.push(root);
    const events: string[] = [];
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { exitCode: null, signalCode: null, kill: vi.fn(() => {
      events.push("kill"); queueMicrotask(() => { Object.assign(child, { exitCode: 0 }); events.push("exit"); child.emit(failure === "close-without-exit" ? "close" : "exit", 0); }); return true;
    }) }); spawn.mockReturnValue(child);
    const release = vi.fn(() => { events.push("release"); expect(child.exitCode).toBe(0); });
    const transport = createLeasedTransport({ resolve: async () => ({ entry: "/fixture/claude", release }) }, "claude", async () => createClaudeTransport({
      configDir: path.join(root, "config"), workspaceDir: path.join(root, "work"), executablePath: "/fixture/claude",
      createQuery: ({ options }) => {
        options.spawnClaudeCodeProcess!({ command: "/fixture/claude", args: [], cwd: root, env: {}, signal: new AbortController().signal });
        if (failure === "throw-constructor") throw new Error("query constructor failed");
        return {
          async *[Symbol.asyncIterator]() { /* complete without external API */ },
          close: () => { events.push("close"); if (failure === "throw-close") throw new Error("close failed"); },
          return: () => { events.push("return"); return failure === "never-return" ? new Promise(() => {}) : Promise.reject(new Error("return failed")); }
        };
      }
    }));
    await transport.run({ kind: "claude-agent-sdk", apiKey: "fixture", model: "test", prompt: "test", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: "claude-agent-sdk", workspaceDir: root, allowedTools: [] }), mcp: null, signal: new AbortController().signal, onEvent: () => {}, onNativeId: () => {} });
    expect(release).toHaveBeenCalledOnce(); expect(events.indexOf("exit")).toBeLessThan(events.indexOf("release"));
    if (failure !== "throw-constructor") { expect(events).toContain("return"); expect(events.indexOf("exit")).toBeLessThan(events.indexOf("close")); }
  });
});
