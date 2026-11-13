import type { ApplicationExtensionExecutorFacade } from "@woohaa3/contracts";
import type { CodexAdapter, CodexAdapterDependencies, CodexRunEvent, CodexRunInput } from "./codex-adapter.js";

export function createExecutorCodexAdapter(options: Omit<CodexAdapterDependencies, "createCodex"> & { executor?: ApplicationExtensionExecutorFacade }): CodexAdapter {
  const active = new Map<string, Set<AbortController>>();
  const runStreamed: CodexAdapter["runStreamed"] = async (input, onEvent) => {
    if (!options.executor) throw new Error("宿主未配置 OAuth 独立执行器");
    if (!input.prepared || !input.requestId) throw new Error("OAuth execution requires a prepared role turn and requestId");
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const ownerRuns = active.get(input.ownerId) ?? new Set<AbortController>();
    ownerRuns.add(controller); active.set(input.ownerId, ownerRuns);
    const { signal: _signal, mcpGrantToken: _grant, ...serializable } = input;
    try {
      const outcome = await options.executor.run({ executor: "oauth-agent", owner: input.ownerId, requestId: input.requestId,
        prepared: input.prepared, signal: controller.signal,
        payload: { input: { ...serializable, images: input.images?.map(image => ({ ...image, bytes: Buffer.from(image.bytes).toString("base64") })) },
          deployment: { codexHomeDir: options.codexHomeDir, workspaceDir: options.workspaceDir, codexBin: options.codexBin,
            mcpTools: options.mcpTools ? { name: options.mcpTools.name, url: options.mcpTools.url } : null } },
        hostMethods: ["oauth.access-token", "oauth.tool-grant"],
        hostCall: async method => {
          if (controller.signal.aborted) throw new Error("OAuth execution cancelled");
          if (method === "oauth.access-token") return options.accessTokenFor(input.ownerId);
          if (method === "oauth.tool-grant") return input.mcpGrantToken;
          throw new Error(`Unknown OAuth host method: ${method}`);
        },
        onEvent: event => { if (event.type === "oauth-event") onEvent(event.payload as CodexRunEvent); }
      });
      if (outcome.status !== "succeeded") throw new Error(outcome.error?.message ?? "OAuth executor failed");
      const result = outcome.result as { finalResponse?: string } | undefined;
      if (typeof result?.finalResponse !== "string") throw new Error("OAuth executor returned no response");
      return { finalResponse: result.finalResponse };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      ownerRuns.delete(controller); if (!ownerRuns.size) active.delete(input.ownerId);
    }
  };
  const cancel = (ownerId: string) => { for (const controller of active.get(ownerId) ?? []) controller.abort(); };
  return { run: (input: CodexRunInput) => runStreamed(input, () => undefined), runStreamed, cancel, disposeOwner: cancel,
    dispose: () => { for (const owner of active.keys()) cancel(owner); } };
}
