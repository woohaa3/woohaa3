/** Desktop-owned local workspace contracts. Absolute locations are never canvas data. */
export type CanvasWorkspaceHandle = {
  schemaVersion: 1;
  owner: string;
  canvasId: string;
  requestId: string;
  directoryKey: string;
  runKey: string;
  generation: number;
};
export function decodeCanvasWorkspaceHandle(value: unknown): CanvasWorkspaceHandle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fields = ["schemaVersion", "owner", "canvasId", "requestId", "directoryKey", "runKey", "generation"];
  if (Object.keys(v).some(key => !fields.includes(key)) || v.schemaVersion !== 1) return null;
  if (![v.owner, v.canvasId, v.requestId].every(x => typeof x === "string" && x.length > 0 && x.length <= 512)) return null;
  if (![v.directoryKey, v.runKey].every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x))) return null;
  if (!Number.isSafeInteger(v.generation) || Number(v.generation) < 1) return null;
  return { schemaVersion: 1, owner: v.owner as string, canvasId: v.canvasId as string, requestId: v.requestId as string, directoryKey: v.directoryKey as string, runKey: v.runKey as string, generation: v.generation as number };
}
export type CanvasWorkspaceErrorCode =
  | "workspace-unavailable" | "workspace-forbidden" | "workspace-migrating"
  | "workspace-conflict" | "workspace-stale" | "workspace-path-invalid"
  | "workspace-io-failed" | "runtime-missing" | "execution-not-found";
export type CanvasWorkspaceFailure = { ok: false; code: CanvasWorkspaceErrorCode; message: string };
export type CanvasWorkspaceResult<T> = { ok: true; value: T } | CanvasWorkspaceFailure;
export type WorkspaceExecutionStatus = "queued" | "running" | "cancel-requested" | "exited" | "failed" | "interrupted" | "unknown";
export type WorkspaceExecution = {
  executionId: string;
  requestId: string;
  status: WorkspaceExecutionStatus;
  createdAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  cursor: number;
};
export type WorkspaceOutput = { cursor: number; stream: "stdout" | "stderr"; text: string };
export type WorkspaceExecuteInput = {
  operationId: string;
  command: string;
  args?: string[];
  /** Relative to the canvas root; defaults to this turn's runs directory. */
  cwd?: string;
  shell?: boolean;
};
export type WorkspaceMigration = {
  operationId: string;
  source: string;
  target: string;
  expectedRootRevision: number;
  phase: "validating" | "waiting-for-idle" | "copying" | "verifying" | "switching" | "completed" | "failed" | "recovering" | "cancelled";
  error?: string;
  cleanupPending?: boolean;
};
export type CanvasWorkspaceSettings = {
  available: boolean;
  rootPath: string;
  rootRevision: number;
  generation: number;
  migration?: WorkspaceMigration;
};
export type WorkspaceFile = { path: string; kind: "file" | "directory"; size: number };
export type CanvasWorkspacePort = {
  acquire(input: { owner: string; canvasId: string; requestId: string }): Promise<CanvasWorkspaceHandle>;
  release(handle: CanvasWorkspaceHandle, outcome: "terminal" | "unknown"): Promise<void>;
  cancel(handle: CanvasWorkspaceHandle): Promise<void>;
  list(handle: CanvasWorkspaceHandle, path?: string): Promise<WorkspaceFile[]>;
  read(handle: CanvasWorkspaceHandle, path: string): Promise<{ content: string; hash: string }>;
  write(handle: CanvasWorkspaceHandle, input: { path: string; content: string; expectedHash?: string | null }): Promise<{ hash: string }>;
  mkdir(handle: CanvasWorkspaceHandle, path: string): Promise<void>;
  execute(handle: CanvasWorkspaceHandle, input: WorkspaceExecuteInput): Promise<WorkspaceExecution>;
  query(handle: CanvasWorkspaceHandle, input: { executionId: string; after?: number }): Promise<{ execution: WorkspaceExecution; events: WorkspaceOutput[] }>;
  stop(handle: CanvasWorkspaceHandle, executionId: string): Promise<WorkspaceExecution>;
};
