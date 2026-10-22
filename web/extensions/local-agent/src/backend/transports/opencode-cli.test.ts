/** Opt-in real CLI test. Provider + MCP stay local; no account, canvas or GPU is used. */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProcessManager } from "../process-manager.js";
import { defaultArgs } from "../index.js";
import { createOpenCodeTransport } from "./opencode-transport.js";
import { createModelMcpHttpHandler } from "../../../../../services/mcp-service/src/model-mcp/mcp-http.js";

it.runIf(Boolean(process.env.WOOHAA3_TEST_OPENCODE_CLI))("real OpenCode v2 calls only the current canvas MCP tools and rotates grants on resume", async () => {
  const rounds = {
    "model-turn": ["get_model_node", "get_model_statistics", "submit_model_script"],
    "group-turn": ["get_canvas_graph", "submit_canvas_script"]
  };
  const calls: Array<{ token: string; tool: string }> = [];
  const offered: string[][] = [];
  const modelToolResults: string[] = [];
  const mcp = createModelMcpHttpHandler({
    path: "/dev/fixture/mcp/model-canvas",
    toolGrant: {
      allowedTools: token => rounds[token as keyof typeof rounds] ?? [],
      authorize: ({ token, tool }) => {
        if (!(rounds[token as keyof typeof rounds] ?? []).includes(tool)) return { ok: false, reason: "tool-not-allowed" };
        calls.push({ token, tool });
        return { ok: true };
      }
    },
    service: {
      getModelNode: async () => ({ ok: true, canvasId: "canvas", nodeId: "node", title: "fixture", prompt: "", source: "scene.box({id:'current'});", modelContentHash: "current-hash", references: [], cameras: [] }),
      getModelStatistics: async () => ({ ok: true, canvasId: "canvas", nodeId: "node", source: "current", statistics: { objects: 1, vertices: 8, triangles: 12, groups: 0, materials: 0, animations: 0 }, breakdown: {
        box: { count: 1, vertices: 8, triangles: 12 }, cylinder: { count: 0, vertices: 0, triangles: 0 }, sphere: { count: 0, vertices: 0, triangles: 0 }, capsule: { count: 0, vertices: 0, triangles: 0 }, mesh: { count: 0, vertices: 0, triangles: 0 }
      } }),
      submitScript: async () => ({ ok: true, canvasId: "canvas", nodeId: "node", commandId: "fixture-commit", idempotent: false })
    },
    registerTools: server => {
      for (const name of rounds["group-turn"]) server.registerTool(name, { description: "Fixture group tool" }, async () => ({ content: [{ type: "text", text: "fixture group committed" }] }));
    }
  });
  const server = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/v1/")) { if (!await mcp.handle(req, res)) res.writeHead(404).end(); return; }
      let text = "";
      for await (const chunk of req) text += String(chunk);
      const body = text ? JSON.parse(text) : {};
      if (req.url?.startsWith("/v1/")) {
        const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
        offered.push(tools);
        const lastUser = body.messages.findLastIndex((message: { role: string }) => message.role === "user");
        const user = JSON.stringify(body.messages[lastUser]);
        const round = user.includes("group-turn") ? "group-turn" : "model-turn";
        const completed = body.messages.slice(lastUser + 1).filter((message: { role: string }) => message.role === "tool").length;
        modelToolResults.push(...body.messages.slice(lastUser + 1).filter((message: { role: string }) => message.role === "tool").map((message: unknown) => JSON.stringify(message)));
        const expected = rounds[round].map(tool => `woohaa_fixture_${tool}`);
        if (JSON.stringify([...tools].sort()) !== JSON.stringify([...expected].sort())) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Unexpected tool scope" } }));
          return;
        }
        const finish = completed >= expected.length;
        const delta = finish ? { role: "assistant", content: "fixture updated" } : {
          role: "assistant", tool_calls: [{ index: 0, id: `call-${round}-${completed}`, type: "function", function: { name: expected[completed], arguments: JSON.stringify({ canvasId: "canvas", nodeId: "node", source: "scene.box({id:'updated'});", requestId: "fixture" }) } }]
        };
        const frame = (value: unknown, reason: string | null) => ({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: reason }] });
        res.writeHead(200, { "content-type": "text/event-stream" }).end(
          [frame(delta, null), frame({}, finish ? "stop" : "tool_calls")].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"
        );
        return;
      }
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const portAddress = portProbe.address();
  if (!portAddress || typeof portAddress === "string") throw new Error("port probe has no port");
  const port = portAddress.port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const directory = await mkdtemp(path.join(tmpdir(), "wh-agent-"));
  const manager = createProcessManager({ workDirRoot: directory, portRange: { min: port, max: port }, executableFor: () => process.env.WOOHAA3_TEST_OPENCODE_CLI! });
  try {
    const handle = await manager.ensure({ adapterId: "opencode-server", owner: "fixture", connectionId: "fixture", args: defaultArgs("opencode-server"), kind: "http", env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "woohaa_fixture/fixture", share: "disabled", warming: false, snapshots: false,
        providers: { woohaa_fixture: { name: "Local fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `${origin}/v1`, apiKey: "fixture-only" },
          models: { fixture: { name: "fixture", capabilities: { tools: true }, limit: { context: 32000, output: 4000 } } } } } })
    } });
    const transport = createOpenCodeTransport();
    let nativeId: string | null = null;
    for (const [token, allowedTools] of Object.entries(rounds)) {
      const result = await transport.run({ ...handle, stdio: null, model: "woohaa_fixture/fixture", prompt: token, allowedTools, toolToken: token,
        mcpEndpoint: { name: "woohaa_fixture", url: `${origin}/dev/fixture/mcp/model-canvas` }, resumeNativeId: nativeId, signal: AbortSignal.timeout(30_000), onEvent: () => undefined });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: { assistantText: "fixture updated" } });
      if (result.ok) nativeId = result.nativeId ?? null;
    }
    expect(calls).toEqual([
      { token: "model-turn", tool: "get_model_node" }, { token: "model-turn", tool: "get_model_statistics" }, { token: "model-turn", tool: "submit_model_script" },
      { token: "group-turn", tool: "get_canvas_graph" }, { token: "group-turn", tool: "submit_canvas_script" }
    ]);
    expect(offered).toHaveLength(7);
    expect(modelToolResults.join("\n")).toContain("current-hash");
    expect(modelToolResults.join("\n")).toContain("点数 8");
    expect(modelToolResults.join("\n")).not.toContain("校验失败");
    expect(modelToolResults.join("\n")).toContain("fixture-commit");
  } finally {
    await manager.stopAll();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}, 90_000);
