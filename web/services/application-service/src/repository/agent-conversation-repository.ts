/**
 * 宿主 Agent 会话/回合/消息/事件 durable 仓库
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.4/1.8 / design D1/D2/D7）。
 *
 * 独立于 Y.Doc 与 Task 事实源：只保存会话、回合、消息、有界事件与显式领域运行关联。
 * 所有读写按 `owner + canvasId` 隔离；宿主 API 在此之前已用可信 principal 与 canvasAccess
 * 校验，本层只做持久化与原子更新，不做权限判定。
 *
 * 事件按单调 sequence 记录，供 cursor 重放或 snapshot 恢复；消息/事件/工具过程都有界，
 * 完整恢复信息仍保留在回合记录中。记录形状与行映射见 `agent-conversation-records.ts`
 * （从本文件拆出，业务源码规模门禁）。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";
import {
  conversationFromRow,
  eventFromRow,
  messageFromRow,
  toolFromRow,
  turnFromRow,
  type ConversationAdapterBinding,
  type ConversationEventRecord,
  type ConversationMessageRecord,
  type ConversationRow,
  type ConversationToolRecord,
  type ConversationTurnRecord,
  type EventRow,
  type MessageRow,
  type OwnerCanvasScope,
  type ToolRow,
  type TurnRow
} from "./agent-conversation-records.js";

export * from "./agent-conversation-records.js";

export type AgentConversationStore = {
  createConversation(input: {
    conversationId: string;
    owner: string;
    canvasId: string;
    adapterId: string;
    /** 会话冻结的来源连接 id（缺省 null；读取时映射兼容默认连接）。 */
    connectionId?: string | null;
    title: string;
    /** 生成目标节点关联（一个节点复用一条会话；design D8）。 */
    nodeId?: string | null;
    now: string;
  }): ConversationAdapterBinding;
  prepareConnectionMigration?(owner: string, connectionId: string): boolean;
  getConversation(conversationId: string): ConversationAdapterBinding | undefined;
  listConversations(scope: OwnerCanvasScope, limit: number): ConversationAdapterBinding[];
  /**
   * 按生成目标查找该节点当前会话（一个节点复用一条；最新优先，design D8）。
   *
   * 只返回仍与节点关联的会话；被「清空上下文」归档的不再返回。
   */
  findConversationByTarget(scope: { owner: string; canvasId: string; nodeId: string; connectionId?: string | null }): ConversationAdapterBinding | undefined;
  /** 清空节点上下文：解除目标关联（归档旧会话，不删除；design D8）。返回解除数量。 */
  clearTarget(scope: { owner: string; canvasId: string; nodeId: string }): number;
  /** 显式切换来源连接：解除该节点与当前会话的关联（归档旧会话，不删除历史）。返回解除数量。 */
  archiveTargetForConnection(scope: { owner: string; canvasId: string; nodeId: string }): number;
  /** 更新会话摘要字段（title/status/latestRequestId/turnCount/nodeId/connectionId）；只写显式提供的字段。 */
  updateConversation(conversationId: string, patch: Partial<Pick<ConversationAdapterBinding, "title" | "status" | "latestRequestId" | "turnCount" | "nodeId" | "connectionId">>, now: string): void;
  findTurnByRequest(owner: string, requestId: string): ConversationTurnRecord | undefined;
  /** 按领域运行关联定位确切回合（活动/历史 Agent 记录 → 确切 request/run，不按节点取最近会话）。 */
  findTurnByRun(owner: string, runId: string): ConversationTurnRecord | undefined;
  getTurn(turnId: string): ConversationTurnRecord | undefined;
  listTurns(conversationId: string, limit: number): ConversationTurnRecord[];
  /** 最新回合（按 created_at 倒序第一条）；用于派生会话整体状态，不受分页影响。 */
  latestTurn(conversationId: string): ConversationTurnRecord | undefined;
  /** 会话回合总数（不截断）。 */
  turnCount(conversationId: string): number;
  /** 会话当前活动回合数（只用于诊断/展示，不再是受理门禁）。 */
  activeTurnCount(conversationId: string): number;
  createTurn(turn: Omit<ConversationTurnRecord, "assistantText" | "runId" | "taskId" | "receiptJson" | "errorCode" | "errorMessage">): void;
  updateTurn(turnId: string, patch: Partial<Omit<ConversationTurnRecord, "turnId" | "conversationId" | "owner" | "canvasId" | "requestId" | "createdAt">>, now: string): void;
  appendMessage(message: ConversationMessageRecord): void;
  /**
   * 更新已存在消息的正文（流式聚合：同一条消息的分片只更新这一行，不新增行）。
   *
   * 只允许改内容与截断标记；身份、角色与顺序保持首次写入时的值。
   */
  updateMessage(messageId: string, patch: { content: string; truncated: number }): void;
  listMessages(conversationId: string, limit: number): ConversationMessageRecord[];
  /**
   * 读取消息页（change: 2026-10-22-remove-agent-execution-limits，任务 4.1）。
   *
   * `beforeSequence` 为继续读取更早历史的游标（不含）；缺省读取最新一页。返回按 sequence 升序，
   * 长度不超过 `limit`。分页只限制单次传输量，不丢弃更早的合法历史。
   */
  listMessagesBefore(conversationId: string, beforeSequence: number | null, limit: number): ConversationMessageRecord[];
  /** 会话当前最大消息 sequence（缺省 0）；用于分配下一条消息的真实顺序。 */
  maxMessageSequence(conversationId: string): number;
  /** 读取回合页（`offset` 为从最早起跳过的回合数）。 */
  listTurnsPage(conversationId: string, offset: number, limit: number): ConversationTurnRecord[];
  appendEvent(event: Omit<ConversationEventRecord, "sequence">): number;
  listEvents(conversationId: string, after: number, limit: number): ConversationEventRecord[];
  maxEventSequence(conversationId: string): number;
  appendTool(tool: ConversationToolRecord): void;
  listTools(conversationId: string, limit: number): ConversationToolRecord[];
  /** 重启后把非终态回合标记为 unknown（不自动重推理）。 */
  markUnsettledUnknown(now: string): ConversationTurnRecord[];
  deleteAll(scope: OwnerCanvasScope): void;
  close(): void;
};

/** 终态判定在 `agent-conversation-records.ts`；`export *` 已转出供消费方使用。 */

export class SqliteAgentConversationStore implements AgentConversationStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        conversation_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        connection_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        latest_request_id TEXT,
        node_id TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_conversations_scope ON agent_conversations(owner, canvas_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_conversation_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        target_json TEXT NOT NULL,
        intent_json TEXT NOT NULL DEFAULT '{}',
        connection_id TEXT,
        connection_adapter_id TEXT,
        connection_config_revision INTEGER,
        connection_credential_epoch INTEGER,
        history_sequence INTEGER,
        assistant_text TEXT,
        run_id TEXT,
        task_id TEXT,
        receipt_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_conversation_turns_request ON agent_conversation_turns(owner, request_id);
      CREATE INDEX IF NOT EXISTS agent_conversation_turns_conv ON agent_conversation_turns(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS agent_conversation_turns_status ON agent_conversation_turns(status);

      CREATE TABLE IF NOT EXISTS agent_conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_conversation_messages_conv ON agent_conversation_messages(conversation_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS agent_conversation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_conversation_events_conv ON agent_conversation_events(conversation_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS agent_conversation_tools (
        tool_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_conversation_tools_conv ON agent_conversation_tools(conversation_id, sequence ASC);
    `);
    // 旧库补列（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`）：一个节点复用一条会话的目标关联。
    // 目标索引必须**在**补列之后创建：旧库的 `agent_conversations` 尚无 `node_id`，否则建索引会
    // 先于补列执行并抛 `no such column: node_id`。
    this.ensureColumn("agent_conversations", "node_id", "TEXT");
    // 来源连接身份增量列（change: 2026-10-16-...，任务 2.2）：旧数据保持 NULL，读取时映射兼容默认连接。
    this.ensureColumn("agent_conversations", "connection_id", "TEXT");
    this.ensureColumn("agent_conversation_turns", "connection_id", "TEXT");
    this.ensureColumn("agent_conversation_turns", "connection_adapter_id", "TEXT");
    this.ensureColumn("agent_conversation_turns", "connection_config_revision", "INTEGER");
    this.ensureColumn("agent_conversation_turns", "connection_credential_epoch", "INTEGER");
    // 受理时冻结的历史基准（change: 2026-10-22-remove-agent-execution-limits，任务 3.1）。
    this.ensureColumn("agent_conversation_turns", "history_sequence", "INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_conversations_target ON agent_conversations(owner, canvas_id, node_id, updated_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_conversations_target_connection ON agent_conversations(owner, canvas_id, node_id, connection_id, updated_at DESC);");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  createConversation(input: { conversationId: string; owner: string; canvasId: string; adapterId: string; connectionId?: string | null; title: string; nodeId?: string | null; now: string }): ConversationAdapterBinding {
    this.db
      .prepare(
        `INSERT INTO agent_conversations
           (conversation_id, owner, canvas_id, adapter_id, connection_id, title, status, latest_request_id, node_id, turn_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', NULL, ?, 0, ?, ?)`
      )
      .run(input.conversationId, input.owner, input.canvasId, input.adapterId, input.connectionId ?? null, input.title, input.nodeId ?? null, input.now, input.now);
    const created = this.getConversation(input.conversationId);
    if (!created) throw new Error("会话写入失败");
    return created;
  }

  getConversation(conversationId: string): ConversationAdapterBinding | undefined {
    const row = this.db.prepare("SELECT * FROM agent_conversations WHERE conversation_id = ?").get(conversationId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : undefined;
  }

  listConversations(scope: OwnerCanvasScope, limit: number): ConversationAdapterBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversations WHERE owner = ? AND canvas_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(scope.owner, scope.canvasId, limit) as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  findConversationByTarget(scope: { owner: string; canvasId: string; nodeId: string; connectionId?: string | null }): ConversationAdapterBinding | undefined {
    const row = scope.connectionId === undefined
      ? (this.db
          .prepare("SELECT * FROM agent_conversations WHERE owner = ? AND canvas_id = ? AND node_id = ? ORDER BY updated_at DESC LIMIT 1")
          .get(scope.owner, scope.canvasId, scope.nodeId) as ConversationRow | undefined)
      : (this.db
          .prepare("SELECT * FROM agent_conversations WHERE owner = ? AND canvas_id = ? AND node_id = ? AND connection_id IS ? ORDER BY updated_at DESC LIMIT 1")
          .get(scope.owner, scope.canvasId, scope.nodeId, scope.connectionId) as ConversationRow | undefined);
    return row ? conversationFromRow(row) : undefined;
  }

  clearTarget(scope: { owner: string; canvasId: string; nodeId: string }): number {
    const result = this.db
      .prepare("UPDATE agent_conversations SET node_id = NULL WHERE owner = ? AND canvas_id = ? AND node_id = ?")
      .run(scope.owner, scope.canvasId, scope.nodeId);
    return Number(result.changes ?? 0);
  }

  /** 显式切换来源连接：解除该节点与当前会话的关联（归档旧会话，保留历史）。 */
  archiveTargetForConnection(scope: { owner: string; canvasId: string; nodeId: string }): number {
    return this.clearTarget(scope);
  }

  updateConversation(conversationId: string, patch: Partial<Pick<ConversationAdapterBinding, "title" | "status" | "latestRequestId" | "turnCount" | "nodeId" | "connectionId">>, now: string): void {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [now];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(patch.title); }
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.latestRequestId !== undefined) { sets.push("latest_request_id = ?"); values.push(patch.latestRequestId); }
    if (patch.turnCount !== undefined) { sets.push("turn_count = ?"); values.push(patch.turnCount); }
    if (patch.nodeId !== undefined) { sets.push("node_id = ?"); values.push(patch.nodeId); }
    if (patch.connectionId !== undefined) { sets.push("connection_id = ?"); values.push(patch.connectionId); }
    values.push(conversationId);
    this.db.prepare(`UPDATE agent_conversations SET ${sets.join(", ")} WHERE conversation_id = ?`).run(...values);
  }

  findTurnByRequest(owner: string, requestId: string): ConversationTurnRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_conversation_turns WHERE owner = ? AND request_id = ?").get(owner, requestId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  /** 按领域运行关联定位确切回合（活动/历史 Agent 记录 → 确切 request/run，不按节点取最近会话）。 */
  findTurnByRun(owner: string, runId: string): ConversationTurnRecord | undefined {
    const row = this.db
      .prepare(`SELECT t.* FROM agent_conversation_turns t WHERE owner = ? AND
        (run_id = ? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.receipt_json) THEN t.receipt_json ELSE '{}' END, '$.actions') action
          WHERE json_extract(action.value, '$.runId') = ? AND json_extract(t.receipt_json, '$.kind') = 'canvas-group'))
        ORDER BY created_at DESC LIMIT 1`)
      .get(owner, runId, runId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  getTurn(turnId: string): ConversationTurnRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_conversation_turns WHERE turn_id = ?").get(turnId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  listTurns(conversationId: string, limit: number): ConversationTurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversation_turns WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(conversationId, limit) as TurnRow[];
    return rows.map(turnFromRow);
  }

  latestTurn(conversationId: string): ConversationTurnRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_conversation_turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(conversationId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  turnCount(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_conversation_turns WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return row.count;
  }

  hasUnresolvedTurns(): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM agent_conversation_turns WHERE status IN ('queued','running','committing','unknown')").get() as { count: number }).count > 0;
  }

  hasUnresolvedConnection(owner: string, connectionId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agent_conversation_turns WHERE owner = ? AND connection_id = ? AND status IN ('queued','running','committing','unknown')").get(owner, connectionId) as { count: number };
    return row.count > 0;
  }

  prepareConnectionMigration(owner: string, connectionId: string): boolean {
    return this.dbMigration(owner, connectionId);
  }

  private dbMigration(owner: string, connectionId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM agent_conversation_turns WHERE owner = ? AND connection_id = ? AND status IN ('queued','running','committing','unknown')").get(owner, connectionId) as { count: number };
      if (pending.count > 0) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("UPDATE agent_conversations SET node_id = NULL WHERE owner = ? AND connection_id = ?").run(owner, connectionId);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  activeTurnCount(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_conversation_turns WHERE conversation_id = ? AND status IN ('queued','running','committing','unknown')")
      .get(conversationId) as { count: number };
    return row.count;
  }

  createTurn(turn: Omit<ConversationTurnRecord, "assistantText" | "runId" | "taskId" | "receiptJson" | "errorCode" | "errorMessage">): void {
    this.db
      .prepare(
        `INSERT INTO agent_conversation_turns
           (turn_id, conversation_id, owner, canvas_id, request_id, action, status, stage, input_hash, target_json, intent_json,
            connection_id, connection_adapter_id, connection_config_revision, connection_credential_epoch, history_sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.turnId,
        turn.conversationId,
        turn.owner,
        turn.canvasId,
        turn.requestId,
        turn.action,
        turn.status,
        turn.stage,
        turn.inputHash,
        turn.targetJson,
        turn.intentJson,
        turn.connectionId,
        turn.connectionAdapterId,
        turn.connectionConfigRevision,
        turn.connectionCredentialEpoch,
        turn.historySequence,
        turn.createdAt,
        turn.updatedAt
      );
  }

  updateTurn(turnId: string, patch: Partial<Omit<ConversationTurnRecord, "turnId" | "conversationId" | "owner" | "canvasId" | "requestId" | "createdAt">>, now: string): void {
    const columns: Record<string, string> = {
      status: "status",
      stage: "stage",
      assistantText: "assistant_text",
      runId: "run_id",
      taskId: "task_id",
      receiptJson: "receipt_json",
      errorCode: "error_code",
      errorMessage: "error_message",
      inputHash: "input_hash",
      targetJson: "target_json",
      intentJson: "intent_json",
      connectionId: "connection_id",
      connectionAdapterId: "connection_adapter_id",
      connectionConfigRevision: "connection_config_revision",
      connectionCredentialEpoch: "connection_credential_epoch",
      historySequence: "history_sequence"
    };
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [now];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    values.push(turnId);
    this.db.prepare(`UPDATE agent_conversation_turns SET ${sets.join(", ")} WHERE turn_id = ?`).run(...values);
  }

  appendMessage(message: ConversationMessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_conversation_messages
           (message_id, conversation_id, turn_id, request_id, role, content, truncated, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.messageId,
        message.conversationId,
        message.turnId,
        message.requestId,
        message.role,
        message.content,
        message.truncated,
        message.sequence,
        message.createdAt
      );
  }

  updateMessage(messageId: string, patch: { content: string; truncated: number }): void {
    this.db
      .prepare("UPDATE agent_conversation_messages SET content = ?, truncated = ? WHERE message_id = ?")
      .run(patch.content, patch.truncated, messageId);
  }

  listMessages(conversationId: string, limit: number): ConversationMessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversation_messages WHERE conversation_id = ? ORDER BY sequence ASC LIMIT ?")
      .all(conversationId, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }

  listMessagesBefore(conversationId: string, beforeSequence: number | null, limit: number): ConversationMessageRecord[] {
    const rows = beforeSequence === null
      ? this.db
          .prepare("SELECT * FROM (SELECT * FROM agent_conversation_messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC")
          .all(conversationId, limit) as MessageRow[]
      : this.db
          .prepare("SELECT * FROM (SELECT * FROM agent_conversation_messages WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC")
          .all(conversationId, beforeSequence, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }

  maxMessageSequence(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max FROM agent_conversation_messages WHERE conversation_id = ?")
      .get(conversationId) as { max: number };
    return row.max;
  }

  listTurnsPage(conversationId: string, offset: number, limit: number): ConversationTurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversation_turns WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?")
      .all(conversationId, limit, Math.max(0, offset)) as TurnRow[];
    return rows.map(turnFromRow);
  }

  appendEvent(event: Omit<ConversationEventRecord, "sequence">): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_conversation_events (conversation_id, turn_id, request_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.conversationId, event.turnId, event.requestId, event.type, event.payloadJson, event.createdAt);
    return Number(result.lastInsertRowid);
  }

  listEvents(conversationId: string, after: number, limit: number): ConversationEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversation_events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(conversationId, after, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  maxEventSequence(conversationId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max FROM agent_conversation_events WHERE conversation_id = ?").get(conversationId) as { max: number };
    return row.max;
  }

  appendTool(tool: ConversationToolRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_conversation_tools (tool_id, conversation_id, turn_id, tool, status, summary, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tool.toolId, tool.conversationId, tool.turnId, tool.tool, tool.status, tool.summary, tool.sequence, tool.createdAt);
  }

  listTools(conversationId: string, limit: number): ConversationToolRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_conversation_tools WHERE conversation_id = ? ORDER BY sequence ASC LIMIT ?")
      .all(conversationId, limit) as ToolRow[];
    return rows.map(toolFromRow);
  }

  markUnsettledUnknown(now: string): ConversationTurnRecord[] {
    const unsettled = this.db
      .prepare("SELECT * FROM agent_conversation_turns WHERE status IN ('queued','running','committing')")
      .all() as TurnRow[];
    if (unsettled.length === 0) return [];
    const update = this.db.prepare("UPDATE agent_conversation_turns SET status = 'unknown', stage = 'unknown', updated_at = ? WHERE turn_id = ?");
    for (const row of unsettled) update.run(now, row.turn_id);
    return unsettled.map((row) => turnFromRow({ ...row, status: "unknown", stage: "unknown", updated_at: now }));
  }

  deleteAll(scope: OwnerCanvasScope): void {
    this.db.prepare("DELETE FROM agent_conversation_messages WHERE conversation_id IN (SELECT conversation_id FROM agent_conversations WHERE owner = ? AND canvas_id = ?)").run(scope.owner, scope.canvasId);
    this.db.prepare("DELETE FROM agent_conversation_events WHERE conversation_id IN (SELECT conversation_id FROM agent_conversations WHERE owner = ? AND canvas_id = ?)").run(scope.owner, scope.canvasId);
    this.db.prepare("DELETE FROM agent_conversation_tools WHERE conversation_id IN (SELECT conversation_id FROM agent_conversations WHERE owner = ? AND canvas_id = ?)").run(scope.owner, scope.canvasId);
    this.db.prepare("DELETE FROM agent_conversation_turns WHERE owner = ? AND canvas_id = ?").run(scope.owner, scope.canvasId);
    this.db.prepare("DELETE FROM agent_conversations WHERE owner = ? AND canvas_id = ?").run(scope.owner, scope.canvasId);
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteAgentConversationStore(options: { path: string }): SqliteAgentConversationStore {
  return new SqliteAgentConversationStore(options);
}
