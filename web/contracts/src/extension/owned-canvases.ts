import type { CanvasCommand } from "../canvas/commands.js";
import type { ServerCanvas } from "../canvas/domain/index.js";

/** Reserved host storage owner; never handed to an extension. */
export const EXTENSION_CANVAS_REGISTRY_OWNER = "@host/extension-canvases";
export type ExtensionCanvasCommitInput = {
  canvasId: string;
  requestId: string;
  expectedRevision: number;
  commands: readonly CanvasCommand[];
};
export type ExtensionCanvasCommitResult =
  | { ok: true; status: "committed" | "duplicate"; revision: number }
  | { ok: false; code: string; message: string };
/** Identity is bound by the host. Only persistently owned canvases can be accessed. */
export type ApplicationExtensionOwnedCanvases = {
  ensure(input: { canvasId: string; title: string }): Promise<{ canvasId: string; revision: number }>;
  read(input: { canvasId: string }): Promise<ServerCanvas>;
  commit(input: ExtensionCanvasCommitInput): Promise<ExtensionCanvasCommitResult>;
};
