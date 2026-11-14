import type {
  AssistantWorldContextView,
  AssistantWorldFailure,
  AssistantWorldWriteInput,
  AssistantWorldWriteOutcome
} from "../canvas/assistant-world-authority.js";
import type { CanvasTaskCatalog } from "../task/dto.js";

/** Context supplied by the host for one MCP request. */
export type McpToolRegistrationContext = {
  grant: import("../extension/assistant/authoring.js").ApplicationToolGrant | null;
  world?: {
    read(input: { canvasId: string; contextId: string }): Promise<{ ok: true; view: AssistantWorldContextView } | AssistantWorldFailure> | { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure;
    write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  };
  task: {
    catalog(): Promise<CanvasTaskCatalog>;
    submit(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    status(workerTaskKey: string): Promise<Record<string, unknown> | null>;
    cancel(workerTaskKey: string): Promise<void>;
  };
  media: {
    readBytes(input: { canvasId: string; storageKey: string; maxBytes: number }): Promise<Uint8Array>;
    writeBytes(input: { canvasId: string; bytes: Uint8Array; contentType: string }): Promise<{ storageKey: string; contentType: string; size: number; checksum: string; locator?: string }>;
    importLocator(input: { canvasId: string; locator: string; contentType?: string; expected?: { size?: number; checksum?: string } }): Promise<{ storageKey: string; contentType: string; size: number; checksum: string; locator?: string }>;
  };
};

