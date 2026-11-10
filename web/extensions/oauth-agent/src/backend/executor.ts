import type { Executor } from "woohaa3-executor/protocol";
import { createCodexAdapter, type CodexRunInput, type CodexAdapterDependencies } from "./codex-adapter.js";

/** OAuth authentication stays in the host; the SDK and streamed inference run here. */
export function createExecutor(options: Pick<CodexAdapterDependencies, "createCodex"> = {}): Executor {
  return { id: "oauth-agent", kind: "agent", async run(turn, context) {
    if (!turn.prepared || !context.host) throw new Error("OAuth executor requires a prepared turn and host lease");
    const host = context.host;
    const payload = turn.payload as { input: Omit<CodexRunInput, "signal">; deployment: { codexHomeDir: string; workspaceDir: string; codexBin?: string | null; mcpTools?: CodexAdapterDependencies["mcpTools"] } };
    const input = payload.input;
    if (input.noTools && turn.prepared.tools.length) throw new Error("Discussion cannot carry prepared tools");
    if (!input.noTools && turn.prepared.tools.length === 0 && !input.outputSchema) throw new Error("OAuth turn has neither tools nor a candidate schema");
    const adapter = createCodexAdapter({ ...payload.deployment, ...options,
      accessTokenFor: () => host.call<string>("oauth.access-token"),
      logger: event => context.emit("log", event) });
    try {
      const grant = input.noTools ? undefined : await host.call<string | undefined>("oauth.tool-grant");
      const result = await adapter.runStreamed({ ...input, prepared: turn.prepared, signal: context.signal,
        images: input.images?.map(image => ({ ...image, bytes: Buffer.from(image.bytes as unknown as string, "base64") })),
        ...(grant ? { mcpGrantToken: grant } : {}) }, event => context.emit("oauth-event", event));
      return { status: "succeeded", result };
    } finally { adapter.dispose(); }
  } };
}
