import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createEndpointPolicy, createModelTransport } from "@woohaa3/agent-connections";
import { createFixedEngineRuntime } from "../fixed-engine-runtime.js";
import { buildAgentSdkRestrictions } from "./agent-sdk-adapter.js";

const sse = (name: string, body: unknown) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
it.each(["claude-agent-sdk", "dsh-agent-sdk"] as const)("%s uses native files in the canvas cwd and reports actual shell availability", async engine => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-harness-runtime-"));
  const cwd = path.join(root, "canvas"); fs.mkdirSync(path.join(cwd, "shared"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "shared/input.json"), "[17,23,2]");
  const script = "const fs=require('fs');const n=JSON.parse(fs.readFileSync('shared/input.json','utf8'));fs.writeFileSync('shared/result.txt',String(n.reduce((a,b)=>a+b,0)));console.log('computed');";
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
  const native = engine === "claude-agent-sdk" ? "Bash" : "bash";
  let step = 0, nativeAdvertised = false;
  const toolResults: unknown[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":1}'); return; }
    toolResults.push(...(body.messages ?? []).filter((m: any) => m.role === "tool"));
    nativeAdvertised ||= (body.tools ?? []).some((t: any) => (t.name ?? t.function?.name) === native);
    const sequence = engine === "claude-agent-sdk" ? [native] : ["write", "read", native];
    const tool = sequence[step++];
    const useTool = tool !== undefined;
    const args = tool === "write" ? { file_path: "shared/helper.cjs", content: script }
      : tool === "read" ? { file_path: "shared/input.json" }
      : { command, description: "Compute the sum in the canvas workspace" };
    res.setHeader("content-type", "text/event-stream");
    if (engine === "claude-agent-sdk") {
      const message = { id: "msg_native", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      const block = useTool ? { type: "tool_use", id: "native_1", name: tool, input: {} } : { type: "text", text: "" };
      const delta = useTool ? { type: "input_json_delta", partial_json: JSON.stringify(args) } : { type: "text_delta", text: "native-done" };
      res.end(sse("message_start", { type: "message_start", message }) + sse("content_block_start", { type: "content_block_start", index: 0, content_block: block }) + sse("content_block_delta", { type: "content_block_delta", index: 0, delta }) + sse("content_block_stop", { type: "content_block_stop", index: 0 }) + sse("message_delta", { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) + sse("message_stop", { type: "message_stop" }));
    } else {
      const delta = useTool ? { role: "assistant", tool_calls: [{ index: 0, id: "native_1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "native-done" };
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "chat_native", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, useTool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const relay = await createModelTransport({ apiType: engine === "claude-agent-sdk" ? "anthropic" : "chat-completions", upstream, apiKey: "fixture-key", policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }), valid: () => true });
  try {
    const runtime = createFixedEngineRuntime({ configDir: path.join(root, "private-config"), workspaceDir: path.join(root, "private-work") });
    const transport = await runtime.resolve(engine);
    const result = await transport.run({ kind: engine, apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey: "connection", model: engine === "claude-agent-sdk" ? "claude-sonnet-4-6" : "controlled", prompt: "Compute using the native shell tool", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: engine, workspace: true, workspaceDir: cwd, allowedTools: [] }), mcp: null, signal: AbortSignal.timeout(30000), onEvent: () => {}, onNativeId: () => {} });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(nativeAdvertised).toBe(true);
    expect(fs.existsSync(cwd)).toBe(true);
    if (engine === "dsh-agent-sdk") {
      expect(fs.readFileSync(path.join(cwd, "shared/helper.cjs"), "utf8")).toBe(script);
      expect(JSON.stringify(toolResults)).toContain("[17,23,2]");
      if (JSON.stringify(toolResults).includes("no sandbox backend is usable")) {
        expect(fs.existsSync(path.join(cwd, "shared/result.txt"))).toBe(false);
        console.info(JSON.stringify({ engine, nativeFiles: "verified", shell: "unavailable", reason: "DSH workspace-write sandbox backend cannot run on this host" }));
        return;
      }
    }
    expect(fs.existsSync(path.join(cwd, "shared/result.txt")), JSON.stringify(toolResults)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "shared/result.txt"), "utf8")).toBe("42");
  } finally { await relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 45000);
