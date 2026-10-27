import { isBoundedId, isJsonObject } from "../../validation.js";
import { isAgentReasoningEffort, type AgentConnectionBinding, type AgentReasoningEffort, type AgentConversationDecodeResult } from "./conversation.js";

/** The host derives owner and all entity identities; this body cannot supply a grant. */
export type CanvasCreationRequest = {
  requestId: string;
  canvasId: string;
  position: { x: number; y: number };
  prompt: string;
  connection: AgentConnectionBinding;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
};
export type CanvasCreationView = {
  requestId: string;
  canvasId: string;
  rootGroupId: string;
  commandId: string;
  turnRequestId: string;
  scopeEpoch: number;
  stage: "preparing" | "root-created" | "accepted" | "failed" | "unknown";
  conversationId?: string;
  turnId?: string;
  rootRevision?: number;
  error?: { code: string; message: string };
};
/** Host injection only. Calls must use the authority queue and durable command receipts. */
export type CanvasCreationPort = {
  capabilities(input: { owner: string; canvasId: string }): Promise<{ ready: boolean; reason?: string }>;
  bindScopeEpochStore?(store: { read(canvasId: string, rootGroupId: string): number; advance(canvasId: string, rootGroupId: string): number }): () => void;
  ensureRoot(input: { owner: string; canvasId: string; rootGroupId: string; commandId: string; position: { x: number; y: number } }): Promise<{ revision: number; scopeEpoch: number }>;
  lookupRoot(input: { owner: string; canvasId: string; rootGroupId: string; commandId: string }): Promise<{ exists: boolean; revision?: number; scopeEpoch: number }>;
};
export type CanvasGroupAction = { canvasId: string; nodeId?: string; commandId?: string; revision?: number; runId?: string; jobId?: string };
/** Only tools protected by the authority's group scope membrane may be granted. */
export const CANVAS_GROUP_TOOLS = [
  "get_canvas_capabilities", "get_canvas_graph", "get_canvas_changes",
  "get_canvas_script_api", "validate_canvas_script", "submit_canvas_script",
  "validate_canvas_plan", "apply_canvas_plan", "create_canvas_node", "connect_canvas_nodes", "set_node_prompt", "delete_canvas_entities",
  "run_canvas_node", "get_canvas_run", "cancel_canvas_run", "get_node_output",
  "get_model_api", "get_model_node", "get_model_statistics", "submit_model_script", "submit_model_scripts",
  "get_film_set_clips", "submit_film_set", "add_film_set_media", "mutate_film_set_item", "mutate_film_set_clip"
] as const;
export function decodeCanvasCreationRequest(body: unknown): AgentConversationDecodeResult<CanvasCreationRequest> {
  const fail = (message: string): AgentConversationDecodeResult<never> => ({ ok: false, code: "malformed-request", message });
  if (!isJsonObject(body)) return fail("请求体必须是对象");
  if (Object.keys(body).some(key => !["requestId", "canvasId", "position", "prompt", "connection", "model", "reasoningEffort"].includes(key))) return fail("创建请求包含未知字段");
  if (!isBoundedId(body.requestId) || !isBoundedId(body.canvasId)) return fail("requestId / canvasId 非法");
  if (!isJsonObject(body.position) || Object.keys(body.position).some(key => key !== "x" && key !== "y") || ![body.position.x, body.position.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000)) return fail("position 必须是有限世界坐标");
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 20_000) return fail("请输入不超过 20000 字符的创建请求");
  const c = body.connection;
  if (!isJsonObject(c) || Object.keys(c).some(key => !["connectionId", "adapterId", "configRevision", "credentialEpoch"].includes(key)) || !isBoundedId(c.connectionId) || !isBoundedId(c.adapterId) || ![c.configRevision, c.credentialEpoch].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return fail("connection 非法");
  if (body.model !== undefined && !isBoundedId(body.model)) return fail("model 非法");
  if (body.reasoningEffort !== undefined && !isAgentReasoningEffort(body.reasoningEffort)) return fail("Variant 非法");
  return { ok: true, value: { requestId: body.requestId, canvasId: body.canvasId, position: { x: body.position.x as number, y: body.position.y as number }, prompt: body.prompt.trim(), connection: { connectionId: c.connectionId, adapterId: c.adapterId, configRevision: c.configRevision as number, credentialEpoch: c.credentialEpoch as number }, ...(body.model !== undefined ? { model: body.model as string } : {}), ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}) } };
}
