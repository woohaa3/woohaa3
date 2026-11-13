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
    onEvent?: (event: ExtensionExecutorEvent, cursor?: number) => void;
    /**
     * 宿主重启接管：从执行器 journal 的该 cursor 继续；`"head"` 表示跳过历史重放。
     * `turn.run` 对同一 turnId/requestId 幂等，因此接管不会重新推理。
     */
    since?: number | "head";

    /** A per-turn allowlist implemented by the owning extension; revoked when this run ends. */
    hostCall?: (method: string, params: unknown) => Promise<unknown>;
    /**
     * 本回合允许的 host-call 方法名（由通道按自己的 switch 声明）。
     *
     * 写入回合授权的持久方法白名单；接管时新宿主据此校验同一 lease，不扩大范围。
     */
    hostMethods?: readonly string[];
  }): Promise<ExtensionExecutorOutcome>;
};
