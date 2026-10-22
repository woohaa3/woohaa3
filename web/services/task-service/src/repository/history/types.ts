/**
 * Task 历史 repository：DB 行类型与输入类型
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 */
import type {
  TaskAdmissionVersions,
  TaskErrorSummary,
  TaskExecutionSource,
  TaskExecutionState,
  TaskModelType,
  TaskRequestSummary,
  TaskResultSummary
} from "@woohaa3/contracts";

export type RecordRow = {
  task_key: string;
  state: string;
  provider_id: string;
  provider_name: string | null;
  model_type: string | null;
  model_key: string | null;
  model_title: string | null;
  canvas_id: string | null;
  canvas_title: string | null;
  node_id: string | null;
  node_title: string | null;
  run_id: string | null;
  job_id: string | null;
  upstream_task_id: string | null;
  progress: number | null;
  attempt: number | null;
  result_json: string | null;
  error_json: string | null;
  request_json: string | null;
  request_truncated: number | null;
  full_text: string | null;
  source: string | null;
  extension_id: string | null;
  catalog_revision: number | null;
  schema_revision: number | null;
  config_version: number | null;
  extension_config_version: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  duration_ms: number;
  terminal_identity: string | null;
  cursor: number;
  last_event_sequence: number | null;
};

export type EventRow = {
  task_key: string;
  sequence: number;
  kind: string;
  stage: string;
  detail_json: string | null;
  occurred_at: string;
};

export type HistoryRecordInput = {
  taskKey: string;
  state: TaskExecutionState;
  providerId: string;
  providerName?: string;
  modelType?: TaskModelType;
  modelKey?: string;
  modelTitle?: string;
  canvasId?: string;
  canvasTitle?: string;
  nodeId?: string;
  nodeTitle?: string;
  runId?: string;
  jobId?: string;
  /** 上游 Provider 任务号；由 execution projection 从 job record 的 taskId 带入。 */
  upstreamTaskId?: string;
  progress?: number;
  attempt?: number;
  result?: TaskResultSummary;
  resultFullText?: string;
  error?: TaskErrorSummary;
  request?: TaskRequestSummary;
  requestTruncated?: boolean;
  source?: TaskExecutionSource;
  extensionId?: string;
  admission?: TaskAdmissionVersions;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
  terminalIdentity?: string;
};

export type HistoryEventInput = {
  taskKey: string;
  kind: "scheduling" | "execution";
  stage: string;
  detail?: Record<string, unknown>;
  occurredAt: string;
};

export type TaskHistoryRepositoryOptions = {
  path: string;
  maxEventsPerRecord?: number;
};
