export type FilmSetPlaybackSnapshot = {
  nodeId: string | null; clipId: string | null; preview: boolean;
  time: number; duration: number; playing: boolean; error: string | null;
  sourceIdentity: string | null; generation: number;
  mode: "edit" | "overview-observer" | "focus-preview" | "shot-node-preview"; diagnostics: readonly string[];
};

/** Clock/capture capability injected by integration; never writes canonical content. */
export type FilmSetPlaybackPort = {
  getSnapshot: () => FilmSetPlaybackSnapshot;
  subscribe: (listener: () => void) => () => void;
  select(nodeId: string, clipId: string | null): void;
  preview(): void; edit(): void; play(): void; pause(): void; seek(time: number): void; stop(): void;
  beginCaptureSession(input: { filmSetNodeId: string; clipId: string; previewNodeId: string }): void;
  endCaptureSession(): void;
};
