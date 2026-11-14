import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createClaudeTransport } from "./claude-transport.js";
import { createCodexTransport } from "./codex-transport.js";
import { buildAgentSdkRestrictions } from "./agent-sdk-adapter.js";

it("Claude uses the exact canvas cwd and builtin tools, with private home and scoped MCP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-"));
  try {
    const cwd = path.join(root, "canvas");
    const transport = createClaudeTransport({ configDir: path.join(root, "private-config"), workspaceDir: path.join(root, "private-work"), createQuery: ({ options }) => {
      expect(options.cwd).toBe(cwd);
      expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
      expect(options.allowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "mcp__woohaa__get_world_context"]));
      expect(options.disallowedTools).not.toContain("Bash");
      expect(options.settingSources).toEqual([]);
      expect(options.env?.CLAUDE_CONFIG_DIR).toContain("private-config");
      expect(options.env?.CLAUDE_CONFIG_DIR).not.toContain(cwd);
      return (async function* () {})();
    } });
    expect(await transport.run({ kind: "claude-agent-sdk", apiKey: "test", model: "test", prompt: "calculate", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: "claude-agent-sdk", workspace: true, workspaceDir: cwd, allowedTools: ["get_world_context"] }), mcp: { name: "woohaa", url: "http://127.0.0.1/mcp", bearerToken: "test" }, signal: new AbortController().signal, onEvent: () => {}, onNativeId: () => {} })).toMatchObject({ ok: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it.each([false, true])("Codex permits native execution only with an attached desktop workspace=%s", async workspace => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-"));
  const cwd = path.join(root, "canvas");
  try {
    const createCodex = vi.fn((options: any) => ({ startThread: (thread: any) => {
      expect(options.config["features.shell_tool"]).toBe(workspace);
      expect(options.env.CODEX_HOME).toContain("private-config");
      expect(thread.workingDirectory).toBe(workspace ? cwd : path.join(root, "private-work", "connection"));
      expect(thread.sandboxMode).toBe(workspace ? "workspace-write" : "read-only");
      return { id: "thread", runStreamed: async () => ({ events: (async function* () {
        yield { type: "item.completed", item: { id: "native", type: "command_execution", command: "node -e 1", aggregated_output: "", exit_code: 0, status: "completed" } };
        yield { type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } };
      })() }) };
    } }));
    const transport = createCodexTransport({ configDir: path.join(root, "private-config"), workspaceDir: path.join(root, "private-work"), createCodex: createCodex as never });
    expect(await transport.run({ kind: "codex-agent-sdk", resourceKey: "connection", apiKey: "test", model: "test", prompt: "calculate", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: "codex-agent-sdk", workspace, workspaceDir: cwd, allowedTools: [] }), mcp: null, signal: new AbortController().signal, onEvent: () => {}, onNativeId: () => {} })).toMatchObject(workspace ? { ok: true } : { ok: false, code: "capability-unsupported" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
