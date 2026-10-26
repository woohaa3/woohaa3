import type { MediaContentRef, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
export type MediaContentKind = "image" | "video";
export type MediaContentSource = { mediaKind: MediaContentKind; sourceIdentity: string; dependencyNodeIds: readonly string[] };
export type MediaContentContext = { canvas: ServerCanvas; nodeId: string; ref: MediaContentRef; source: MediaContentSource; signal: AbortSignal; requestId: string };
export type MediaContentProvider = {
  providerId: string;
  owner: string;
  schemaVersions: readonly number[];
  mediaKinds: readonly MediaContentKind[];
  describe(canvas: ServerCanvas, ref: MediaContentRef): MediaContentSource;
  resolvePreview(context: MediaContentContext): Promise<StoredAsset | null>;
  materialize(context: MediaContentContext): Promise<StoredAsset>;
  snapshot(context: MediaContentContext): Promise<StoredAsset>;
  /** Notify when browser-local producer readiness changes without a source edit. */
  subscribe?(listener: () => void): () => void;
  dispose?(): void;
};
export type MediaContentState = { status: "pending" | "ready" | "unavailable" | "failed"; diagnostic?: string; asset?: StoredAsset; sourceIdentity?: string };
export type MediaContentService = {
  register(provider: MediaContentProvider): () => void;
  describe(canvas: ServerCanvas, ref: MediaContentRef, kind: MediaContentKind): MediaContentSource;
  subscribe(listener: () => void): () => void;
  state(nodeId: string): MediaContentState | undefined;
  resolve(nodeId: string, operation: "resolvePreview" | "materialize" | "snapshot", requestId: string): Promise<StoredAsset | null>;
  /** Snapshot a complete copy closure before creating any copied nodes. */
  freeze(canvas: ServerCanvas, nodeIds: readonly string[], requestId: string): Promise<ServerCanvas>;
  retry(nodeId: string): void;
};
