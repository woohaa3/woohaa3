import type { PreparedAgentRoleTurn } from "../../assistant/agent-role.js";

/** An installed extension contributes a separately loadable daemon module. Paths are resolved by the loader. */
export type ExtensionExecutorModule = { id: string; module: string; export: string };
export type ExtensionExecutorEvent = { type: string; payload?: unknown };
export type ExtensionExecutorOutcome =
  | { status: "succeeded"; result?: unknown }
  | { status: "failed"; error: { code: string; message: string }; result?: unknown }
  | { status: "cancelled"; error?: { code: string; message: string }; result?: unknown };

/** Bound to the actual activation owner. Secrets and host callbacks never enter the daemon journal. */
export type ApplicationExtensionExecutorFacade = {
  query(input: { executor: string; owner: string; requestId: string }): Promise<ExtensionExecutorOutcome | null>;
  cancel(input: { executor: string; owner: string; requestId: string }): Promise<void>;
  run(input: {
    executor: string;
    owner: string;
    requestId: string;
    prepared: PreparedAgentRoleTurn;
    payload?: unknown;
    signal?: AbortSignal;
    onEvent?: (event: ExtensionExecutorEvent) => void;
    /** A per-turn allowlist implemented by the owning extension; revoked when this run ends. */
    hostCall?: (method: string, params: unknown) => Promise<unknown>;
  }): Promise<ExtensionExecutorOutcome>;
};
