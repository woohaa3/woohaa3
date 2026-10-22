/**
 * Shared G-buffer production contracts.
 *
 * Imported by the Node service, the STDIO MCP adapter and the browser GPU API
 * editor, so it stays free of Node, zod, Three and DOM. Zod request schemas live
 * beside the service in `schema.ts`; this module is the single source of truth
 * for the job lifecycle both clients render and drive.
 */

/**
 * Ordered production stages. The service owns only asset-agnostic G-buffer
 * production; runtime cooking, integration and publish are the Agent's job and
 * are deliberately absent here.
 */
export const GBUFFER_STAGES = [
  'intake',
  'matte',
  'spatial',
  'prepared',
  'remote',
  'packaged',
  'validated',
  'previewed',
] as const;
export type GbufferStageId = typeof GBUFFER_STAGES[number];

/** The five estimated channels plus the authoritative Original. */
export const GBUFFER_CHANNELS = ['original', 'basecolor', 'normal', 'depth', 'roughness', 'metallic'] as const;
export type GbufferChannel = typeof GBUFFER_CHANNELS[number];

/**
 * Stage status. `blocked` means the stage needs an explicit user decision
 * (ambiguous input, irreversible overwrite, quality gate). `unknown` means a
 * remote submission result is unconfirmed and must never be auto-replayed.
 */
export type GbufferStageStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed' | 'unknown';

export interface GbufferStageState {
  id: GbufferStageId;
  status: GbufferStageStatus;
  detail: string;
  updatedAt: number;
  /** Machine-readable reason a stage is blocked, so a client can prompt precisely. */
  blockedReason?: 'ambiguous-input' | 'quality-gate' | 'irreversible' | 'remote-unknown';
}

/** Normalised spatial transform recorded for provenance and later ROI write-back. */
export interface GbufferSpatialTransform {
  sourceSize: [number, number];
  /** Uniformly scaled content before padding. */
  scaledSize: [number, number];
  /** Actual model and raw G-buffer output dimensions. */
  inferenceSize: [number, number];
  destinationRect: [number, number, number, number];
  padding: { left: number; right: number; top: number; bottom: number };
  scale: number;
  fit: 'contain' | 'stretch';
  policy: 'preserve-aspect-pad16-v1' | 'legacy-contain-1280x704';
  coordinateConvention: 'top-left-pixels';
}

/** Remote Cosmos job state, owned by the service (never by a client). */
export interface GbufferRemoteProgress {
  stage: string;
  progress: number;
  totalFrames?: number;
  completedFrames?: number;
  totalChunks?: number;
  completedChunks?: number;
  currentChunk?: number;
  currentPass?: string;
  totalPasses?: number;
  completedPasses?: number;
}

export interface GbufferRemoteState {
  status: 'idle' | 'submitting' | 'polling' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  jobId?: string;
  /** SHA-256 of the prepared inference inputs; deduplicates remote submission. */
  inputDigest?: string;
  frameCount?: number;
  progress?: GbufferRemoteProgress;
  error?: string;
}

/** Provenance the packager and Skill must preserve. Never includes credentials. */
export interface GbufferProvenance {
  sourceSha256: string[];
  gitRevision?: string;
  cosmosJobId?: string;
  model?: string;
  modelParams?: Record<string, number | string | boolean>;
  generatorVersion: string;
}

export interface GbufferSourceInput {
  /** Repo-relative `assets/...` path or a service-owned `ingested/...` archive. */
  original: string;
  /** Transparent foregrounds need alpha; fixed terrain patches deliberately use a full valid canvas. */
  inputMode?: 'foreground-rgba' | 'terrain-patch';
  mask?: string;
  fps?: number;
  frameCount?: number;
  logicalCanvas?: [number, number];
  directions?: string[];
  actions?: string[];
  /** Runtime domain the Agent will integrate into, e.g. `character-surface`. */
  runtimeDomain?: string;
}

export interface GbufferJobInput extends GbufferSourceInput {
  assetId: string;
  profileHint?: string;
  note?: string;
}

/** A produced candidate the Relight Workbench can preview. */
export interface GbufferCandidate {
  packageDir: string;
  manifestFile: string;
  channels: GbufferChannel[];
  frameCount: number;
  size: [number, number];
  sha256: string;
  spatial?: GbufferSpatialTransform;
}

export interface GbufferJob {
  id: string;
  version: number;
  createdAt: number;
  input: GbufferJobInput;
  stages: GbufferStageState[];
  remote: GbufferRemoteState;
  provenance: GbufferProvenance;
  spatial?: GbufferSpatialTransform;
  candidate?: GbufferCandidate;
  /** Fingerprint (assetId + source digests) used to detect duplicate jobs. */
  fingerprint: string;
}

export interface GbufferJobSummary {
  id: string;
  assetId: string;
  version: number;
  createdAt: number;
  currentStage: GbufferStageId;
  currentStatus: GbufferStageStatus;
}

export interface GbufferEvent {
  seq: number;
  jobId: string;
  type: string;
  message: string;
  at: number;
}

export interface GbufferContext {
  jobs: GbufferJobSummary[];
  sequence: number;
  events: GbufferEvent[];
  capabilities: {
    stages: readonly GbufferStageId[];
    channels: readonly GbufferChannel[];
    /** Backward-compatible name for the default size; jobs use their own model size. */
    inferenceSize: [number, number];
    resolution: {
      default: [number, number];
      minDimension: number;
      maxDimension: number;
      multipleOf: number;
      policy: 'preserve-aspect-pad16-v1';
    };
  };
  connection: { cosmos: boolean };
}

/** Default fixed inference canvas used by the Cosmos inverse renderer. */
export const GBUFFER_INFERENCE_SIZE: [number, number] = [1280, 704];

/** Index of a stage in the ordered pipeline; -1 if unknown. */
export function stageIndex(id: GbufferStageId): number {
  return (GBUFFER_STAGES as readonly string[]).indexOf(id);
}

/** The next stage after `id`, or undefined when `id` is the terminal stage. */
export function nextStage(id: GbufferStageId): GbufferStageId | undefined {
  const index = stageIndex(id);
  return index >= 0 && index < GBUFFER_STAGES.length - 1 ? GBUFFER_STAGES[index + 1] : undefined;
}

/** The first stage that is not `done` (the job's current stage). */
export function currentStage(stages: GbufferStageState[]): GbufferStageState {
  return stages.find(stage => stage.status !== 'done') ?? stages[stages.length - 1];
}

/** Fresh stage list for a new job, all pending. */
export function initialStages(now: number): GbufferStageState[] {
  return GBUFFER_STAGES.map(id => ({ id, status: 'pending' as GbufferStageStatus, detail: '', updatedAt: now }));
}
