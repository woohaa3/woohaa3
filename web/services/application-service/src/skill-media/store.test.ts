import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";
import { SqliteSkillMediaStore } from "./store.js";

const dirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "woohaa-skill-media-"));
  dirs.push(dir);
  return join(dir, "application.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Skill 媒体步骤 SQLite 迁移", () => {
  it("新库创建步骤、尝试与事件表", () => {
    const path = dbPath();
    const store = new SqliteSkillMediaStore({ path });
    store.insertStep({
      owner: "user", canvasId: "canvas", rootGroupId: "root", scopeEpoch: 2, skillRunId: "skill", stepId: "step",
      nodeId: "node", currentAttempt: 1, currentRequestId: "req", currentRunId: "run", promptRevision: 1,
      latestSuccessfulRunId: null, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z"
    });
    expect(store.getStep({ owner: "user", canvasId: "canvas", skillRunId: "skill", stepId: "step" })).toMatchObject({
      rootGroupId: "root", scopeEpoch: 2, currentRunId: "run"
    });
    store.close();
  });

  it("旧库（只有会话表）可原地升级，重复打开不报错", () => {
    const path = dbPath();
    const { DatabaseSync } = loadNodeSqlite();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE agent_conversations(conversation_id TEXT PRIMARY KEY);");
    legacy.close();
    const first = new SqliteSkillMediaStore({ path });
    first.close();
    const second = new SqliteSkillMediaStore({ path });
    expect(second.maxEventSequence({ owner: "u", canvasId: "c", skillRunId: "s", stepId: "p" })).toBe(0);
    second.close();
  });

  it("服务重启后按步骤身份可读回尝试与事件", () => {
    const path = dbPath();
    const first = new SqliteSkillMediaStore({ path });
    first.atomic(() => {
      first.insertStep({
        owner: "user", canvasId: "canvas", rootGroupId: null, scopeEpoch: null, skillRunId: "skill", stepId: "step",
        nodeId: "node", currentAttempt: 1, currentRequestId: "req", currentRunId: "run", promptRevision: 1,
        latestSuccessfulRunId: null, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z"
      });
      first.insertAttempt({
        owner: "user", canvasId: "canvas", skillRunId: "skill", stepId: "step", attempt: 1, requestId: "req",
        requestHash: "hash", runId: "run", jobId: "job", promptRevision: 1, promptHash: "prompt-hash", prompt: "prompt",
        modelKey: "model", state: "running", mediaKind: null, error: null, supersededByAttempt: null,
        supersededByRunId: null, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", settledAt: null
      });
      first.appendEvent({
        owner: "user", canvasId: "canvas", skillRunId: "skill", stepId: "step", attempt: 1,
        type: "skill-step-updated", payloadJson: "{}", createdAt: "2026-10-28T00:00:00Z"
      });
    });
    first.close();
    const second = new SqliteSkillMediaStore({ path });
    expect(second.listAttempts({ owner: "user", canvasId: "canvas", skillRunId: "skill", stepId: "step" })).toHaveLength(1);
    expect(second.listEvents({ owner: "user", canvasId: "canvas", skillRunId: "skill", stepId: "step" }, 0, 10)).toHaveLength(1);
    second.close();
  });
});
