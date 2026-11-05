/**
 * 旧 `unknown` 存储迁移（change: 2026-10-28-settle-unconfirmed-results-as-failed，任务 1.2/2.2/2.4/2.6）。
 *
 * 旧版本把无法确认的结果写成 `unknown`。重新打开各自 SQLite 仓库时必须原地归一为
 * `failed`，补 `result-unconfirmed` 但不覆盖已有错误码、回执、候选或组/回合身份。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAgentConversationStore } from "../repository/agent-conversation-repository.js";
import { AssistantTextStore } from "../repository/assistant-text-store.js";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function database(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "legacy-unknown-"));
  directories.push(directory);
  return path.join(directory, "ledger.sqlite");
}

function raw(path: string) {
  const { DatabaseSync } = loadNodeSqlite();
  return new DatabaseSync(path);
}

describe("legacy unknown storage migration", () => {
  it("turns legacy conversation turns and sessions into failed with evidence", () => {
    const path = database();
    createSqliteAgentConversationStore({ path }).close();
    const db = raw(path);
    db.exec(
      "INSERT INTO agent_conversations (conversation_id, owner, canvas_id, adapter_id, title, status, turn_count, created_at, updated_at) VALUES ('conv','owner','canvas','adapter','标题','unknown',1,'2026-01-01','2026-01-01')",
    );
    db.prepare(
      "INSERT INTO agent_conversation_turns (turn_id, conversation_id, owner, canvas_id, request_id, action, status, stage, input_hash, target_json, receipt_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "turn",
      "conv",
      "owner",
      "canvas",
      "request",
      "generate",
      "unknown",
      "unknown",
      "hash",
      JSON.stringify({ mode: "text", canvasId: "canvas", nodeId: "node" }),
      JSON.stringify({ kind: "text-generation" }),
      "2026-01-01",
      "2026-01-01",
    );
    db.close();

    const reopened = createSqliteAgentConversationStore({ path });
    expect(reopened.findTurnByRequest("owner", "request")).toMatchObject({
      status: "failed",
      stage: "failed",
      errorCode: "result-unconfirmed",
      receiptJson: JSON.stringify({ kind: "text-generation" }),
    });
    expect(reopened.getConversation("conv")?.status).toBe("failed");
    // 已归一的旧回合不再算未结算：启动核对不会把它当活动回合。
    expect(reopened.listUnsettledTurns()).toHaveLength(0);
    reopened.close();
  });

  it("keeps an existing conversation error code instead of overwriting it", () => {
    const path = database();
    createSqliteAgentConversationStore({ path }).close();
    const db = raw(path);
    db.exec(
      "INSERT INTO agent_conversations (conversation_id, owner, canvas_id, adapter_id, title, status, turn_count, created_at, updated_at) VALUES ('conv','owner','canvas','adapter','标题','unknown',1,'2026-01-01','2026-01-01')",
    );
    db.prepare(
      "INSERT INTO agent_conversation_turns (turn_id, conversation_id, owner, canvas_id, request_id, action, status, stage, input_hash, target_json, error_code, error_message, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "turn",
      "conv",
      "owner",
      "canvas",
      "request",
      "generate",
      "unknown",
      "unknown",
      "hash",
      "{}",
      "outcome-unknown",
      "外部工作日志无法确认",
      "2026-01-01",
      "2026-01-01",
    );
    db.close();

    const reopened = createSqliteAgentConversationStore({ path });
    expect(reopened.findTurnByRequest("owner", "request")).toMatchObject({
      status: "failed",
      errorCode: "outcome-unknown",
      errorMessage: "外部工作日志无法确认",
    });
    reopened.close();
  });

  it("turns a legacy assistant-text stage into failed while keeping the candidate", () => {
    const path = database();
    new AssistantTextStore(path).close();
    const db = raw(path);
    db.prepare("INSERT INTO assistant_text_deliveries VALUES(?,?,?)").run(
      "owner",
      "request",
      JSON.stringify({
        owner: "owner",
        requestId: "request",
        inputHash: "hash",
        entry: {},
        connection: {},
        prepared: {},
        run: {},
        stage: "unknown",
        candidate: { text: "候选正文", checksum: "checksum" },
      }),
    );
    db.close();

    const reopened = new AssistantTextStore(path);
    expect(reopened.get("owner", "request")).toMatchObject({
      stage: "failed",
      candidate: { text: "候选正文", checksum: "checksum" },
    });
    expect(reopened.get("owner", "request")?.error).toContain("重试");
    reopened.close();
  });
});
