import { createHash, randomUUID } from "node:crypto";
import type { ApplicationBackendExtensionDefinition, ApplicationExtensionExecutorFacade, ExtensionExecutorOutcome } from "@woohaa3/contracts";
import { createExecutorClient, followTurn } from "woohaa3-executor/client";
import type { HostRuntimeOptions } from "./agent-runtime-adapter.js";

export function createExtensionExecutorRuntime(options: HostRuntimeOptions | undefined) {
  const bindings = new Map<string, { options: HostRuntimeOptions; dispose(): Promise<void> }>();
  const key = (id: string, version: number) => JSON.stringify([id, version]);
  return {
    optionsFor(id: string, version: number, executor: string): HostRuntimeOptions | undefined {
      const binding = bindings.get(key(id, version));
      return binding ? { ...binding.options, executor: `${binding.options.executor}/${executor}` } : undefined;
    },
    async activate(definition: ApplicationBackendExtensionDefinition, version: number): Promise<{ service: ApplicationExtensionExecutorFacade; dispose(): Promise<void> } | undefined> {
      if (!definition.executors?.length) return undefined;
      if (!options?.hostCalls) throw new Error("宿主未配置扩展独立执行器");
      const client = createExecutorClient(options);
      const registrationId = `${definition.extensionId}:${version}:${randomUUID()}`;
      const ids = new Set(definition.executors.map(item => item.id));
      let disposed = false;
      const controllers = new Set<AbortController>();
      const turnControllers = new Map<string, Set<AbortController>>();
      const running = new Set<Promise<unknown>>();
      const ensure = async () => {
        if (disposed) throw new Error("Executor extension is disabled");
        await client.call("executor.register", { registrationId, modules: definition.executors });
      };
      await ensure();
      const binding = {
        options: { ...options, executor: registrationId, ensure },
        async dispose() {
          disposed = true;
          if (bindings.get(key(definition.extensionId, version)) === binding) bindings.delete(key(definition.extensionId, version));
          for (const controller of controllers) controller.abort();
          await Promise.allSettled([...running]);
          await client.call("executor.unregister", { registrationId });
        }
      };
      bindings.set(key(definition.extensionId, version), binding);
      const turnIdFor = (input: { executor: string; owner: string; requestId: string }) => createHash("sha256").update(JSON.stringify([definition.extensionId, input.executor, input.owner, input.requestId])).digest("hex");
      const check = (executor: string) => { if (disposed || !ids.has(executor)) throw new Error("Executor is not declared by this extension"); };
      const service: ApplicationExtensionExecutorFacade = {
        async query(input) {
          check(input.executor);
          const view = await client.queryTurn(turnIdFor(input));
          if (!view || view.status === "queued" || view.status === "running") return null;
          return { status: view.status, ...(view.result !== undefined ? { result: view.result } : {}), ...(view.error ? { error: view.error } : {}) } as ExtensionExecutorOutcome;
        },
        async cancel(input) {
          check(input.executor);
          const turnId = turnIdFor(input);
          for (const controller of turnControllers.get(turnId) ?? []) controller.abort();
          await client.cancelTurn(turnId);
          await client.call("turn.drain", { turnId });
        },
        run(input) {
          const operation = (async (): Promise<ExtensionExecutorOutcome> => {
            if (disposed || !ids.has(input.executor)) throw new Error("Executor is not declared by this extension");
            if (!input.prepared) throw new Error("Executor requires a prepared role turn");
            const controller = new AbortController();
            controllers.add(controller);
            const abort = () => controller.abort();
            input.signal?.addEventListener("abort", abort, { once: true });
            if (input.signal?.aborted) abort();
            const turnId = turnIdFor(input);
            const activeControllers = turnControllers.get(turnId) ?? new Set<AbortController>();
            activeControllers.add(controller);
            turnControllers.set(turnId, activeControllers);
            const lease = options.hostCalls!.registerCall(async (method, params) => {
              if (disposed || controller.signal.aborted || !input.hostCall) throw new Error("Executor host lease is revoked");
              const result = await input.hostCall(method, params);
              if (disposed || controller.signal.aborted) throw new Error("Executor host lease is revoked");
              return result;
            });
            let submitted = false;
            const cancel = () => { void client.cancelTurn(turnId).catch(() => undefined); };
            controller.signal.addEventListener("abort", cancel, { once: true });
            try {
              if (controller.signal.aborted) return { status: "cancelled" };
              await ensure();
              if (controller.signal.aborted || disposed) return { status: "cancelled" };
              await client.runTurn({ turnId, requestId: input.requestId, kind: "agent", executor: `${registrationId}/${input.executor}`,
                prepared: input.prepared, payload: input.payload, host: { ...options.bridge, leaseId: lease.leaseId } });
              submitted = true;
              if (controller.signal.aborted) cancel();
              await followTurn(client, turnId, { intervalMs: 50, onEvent: event => input.onEvent?.(event) });
              await client.call("turn.drain", { turnId });
              const view = await client.queryTurn(turnId);
              if (!view) throw new Error("Executor did not return a terminal view");
              return { status: view.status as ExtensionExecutorOutcome["status"], ...(view.result !== undefined ? { result: view.result } : {}), ...(view.error ? { error: view.error } : {}) } as ExtensionExecutorOutcome;
            } catch (error) {
              if (submitted) await client.cancelTurn(turnId).catch(() => undefined);
              throw error;
            } finally {
              try { if (submitted) await client.call("turn.drain", { turnId }); }
              finally {
                lease.release();
                controller.signal.removeEventListener("abort", cancel);
                input.signal?.removeEventListener("abort", abort);
                controllers.delete(controller);
                activeControllers.delete(controller);
                if (!activeControllers.size) turnControllers.delete(turnId);
              }
            }
          })();
          running.add(operation);
          void operation.finally(() => running.delete(operation)).catch(() => undefined);
          return operation;
        }
      };
      return { service, dispose: () => binding.dispose() };
    }
  };
}
