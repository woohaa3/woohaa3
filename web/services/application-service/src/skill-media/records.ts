/**
 * Skill 媒体步骤 durable 记录形状与行映射
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.1）。
 *
 * 与 Agent 会话记录一样：store 只做持久化与原子更新，授权与语义由 service 判定。
 */
import type { SkillMediaState } from "@woohaa3/contracts";

export type SkillMediaStepRecord = {
  owner: string;
  canvasId: string;
  rootGroupId: string | null;
  scopeEpoch: number | null;
  skillRunId: string;
  stepId: string;
  nodeId: string;
  currentAttempt: number;
  currentRequestId: string | null;
  currentRunId: string | null;
  promptRevision: number;
  latestSuccessfulRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillMediaAttemptRecord = {
  owner: string;
  canvasId: string;
  skillRunId: string;
  stepId: string;
  attempt: number;
  requestId: string;
  requestHash: string;
  runId: string;
  jobId: string | null;
  promptRevision: number;
  promptHash: string;
  prompt: string;
  modelKey: string | null;
  state: SkillMediaState;
  mediaKind: string | null;
  error: string | null;
  supersededByAttempt: number | null;
  supersededByRunId: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
};

export type SkillMediaEventRecord = {
  sequence: number;
  owner: string;
  canvasId: string;
  skillRunId: string;
  stepId: string;
  attempt: number;
  type: string;
  payloadJson: string;
  createdAt: string;
};

export type SkillMediaStepKey = Pick<SkillMediaStepRecord, "owner" | "canvasId" | "skillRunId" | "stepId">;
export type SkillMediaAttemptKey = SkillMediaStepKey & { attempt: number };

export type SkillMediaStepRow = {
  owner: string;
  canvas_id: string;
  root_group_id: string | null;
  scope_epoch: number | null;
  skill_run_id: string;
  step_id: string;
  node_id: string;
  current_attempt: number;
  current_request_id: string | null;
  current_run_id: string | null;
  prompt_revision: number;
  latest_successful_run_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SkillMediaAttemptRow = {
  owner: string;
  canvas_id: string;
  skill_run_id: string;
  step_id: string;
  attempt: number;
  request_id: string;
  request_hash: string;
  run_id: string;
  job_id: string | null;
  prompt_revision: number;
  prompt_hash: string;
  prompt: string;
  model_key: string | null;
  state: string;
  media_kind: string | null;
  error: string | null;
  superseded_by_attempt: number | null;
  superseded_by_run_id: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
};

export type SkillMediaEventRow = {
  sequence: number;
  owner: string;
  canvas_id: string;
  skill_run_id: string;
  step_id: string;
  attempt: number;
  type: string;
  payload_json: string;
  created_at: string;
};

export function stepFromRow(row: SkillMediaStepRow): SkillMediaStepRecord {
  return {
    owner: row.owner,
    canvasId: row.canvas_id,
    rootGroupId: row.root_group_id,
    scopeEpoch: row.scope_epoch,
    skillRunId: row.skill_run_id,
    stepId: row.step_id,
    nodeId: row.node_id,
    currentAttempt: row.current_attempt,
    currentRequestId: row.current_request_id,
    currentRunId: row.current_run_id,
    promptRevision: row.prompt_revision,
    latestSuccessfulRunId: row.latest_successful_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function attemptFromRow(row: SkillMediaAttemptRow): SkillMediaAttemptRecord {
  return {
    owner: row.owner,
    canvasId: row.canvas_id,
    skillRunId: row.skill_run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    requestId: row.request_id,
    requestHash: row.request_hash,
    runId: row.run_id,
    jobId: row.job_id,
    promptRevision: row.prompt_revision,
    promptHash: row.prompt_hash,
    prompt: row.prompt,
    modelKey: row.model_key,
    state: row.state as SkillMediaState,
    mediaKind: row.media_kind,
    error: row.error,
    supersededByAttempt: row.superseded_by_attempt,
    supersededByRunId: row.superseded_by_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at
  };
}

export function skillEventFromRow(row: SkillMediaEventRow): SkillMediaEventRecord {
  return {
    sequence: row.sequence,
    owner: row.owner,
    canvasId: row.canvas_id,
    skillRunId: row.skill_run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    type: row.type,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  };
}
