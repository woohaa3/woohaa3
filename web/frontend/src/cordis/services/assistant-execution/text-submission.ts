import { AGENT_ROLE_BINDINGS } from "../agent-role-bindings.js";
import type { ConversationSnapshot, ServerCanvas } from "@woohaa3/contracts";
import { reasoningEffortsOf } from "@woohaa3/contracts";
import type {
  AgentConversationService,
  AgentConversationSubmitInput,
} from "../../contract/agent-conversation.js";
import { assistantInputController } from "./controller.js";
import {
  assistantSelectionMemory,
  readAssistantPreference,
} from "./selection.js";
import { agentDirectory } from "./directory.js";

const targetSessions = new WeakMap<
  object,
  Map<
    string,
    { ready: boolean; snapshot?: ConversationSnapshot; error?: string }
  >
>();
/** Same page draft and source precedence as the single-node public composer. */
export function resolveTextSubmission(
  service: AgentConversationService,
  canvas: ServerCanvas,
  nodeId: string,
  onReady?: () => void,
):
  | { eligible: true; input: AgentConversationSubmitInput }
  | { eligible: false; reason: string } {
  const scope = service.getDataScopeId?.() ?? "page";
  const preference = readAssistantPreference(scope);
  let sessions = targetSessions.get(service);
  if (!sessions) {
    sessions = new Map();
    targetSessions.set(service, sessions);
  }
  const sessionKey = JSON.stringify([
    scope,
    canvas.id,
    nodeId,
    service.getSnapshot().contextRevision,
  ]);
  if (!sessions.has(sessionKey)) {
    const entry = { ready: false } as {
      ready: boolean;
      snapshot?: ConversationSnapshot;
      error?: string;
    };
    sessions.set(sessionKey, entry);
    void Promise.all([
      agentDirectory(service, scope).load(),
      service
        .findConversationForTarget({ canvasId: canvas.id, nodeId })
        .then(async (result) => {
          if (!result.ok) throw Error(result.error);
          if (result.value.conversation) {
            const read = await service.readConversation(
              result.value.conversation.conversationId,
            );
            if (!read.ok) throw Error(read.error);
            entry.snapshot = read.value;
          }
        }),
    ])
      .catch((error) => {
        entry.error =
          error instanceof Error ? error.message : "无法读取文本成员配置";
      })
      .finally(() => {
        entry.ready = true;
        onReady?.();
      });
  }
  const session = sessions.get(sessionKey)!;
  if (!session.ready)
    return { eligible: false, reason: "正在读取文本成员的助手配置…" };
  if (session.error) return { eligible: false, reason: session.error };
  const current = Object.values(service.getSnapshot().turnsByRequest ?? {})
    .filter(
      (item) =>
        item.turn.target.canvasId === canvas.id &&
        item.turn.target.nodeId === nodeId,
    )
    .at(-1);
  const history =
    current?.turn.target ?? session.snapshot?.turns.at(-1)?.target;
  const sessionConnection =
    current?.turn.target.connectionId ??
    session.snapshot?.conversation.connectionId;

  const selected =
    assistantSelectionMemory(service, scope).get(`${canvas.id}:${nodeId}`) ??
    (sessionConnection ? { connectionId: sessionConnection } : preference);
  const directoryStore = agentDirectory(service, scope);
  const directory = directoryStore.getSnapshot();
  if (!directory.ready) {
    if (!directory.error) void directoryStore.load().then(() => onReady?.());
    return {
      eligible: false,
      reason:
        directory.error || directory.loadingMessage || "正在读取助手配置…",
    };
  }
  const connection = directory.connections.find(
    (connection) => connection.connectionId === selected?.connectionId,
  );
  if (!connection)
    return {
      eligible: false,
      reason: directory.loadingMessage || "请为文本成员连接助手",
    };
  if (
    !connection.capabilities.textDelivery ||
    (!connection.ready && connection.authMode !== "local-login")
  )
    return {
      eligible: false,
      reason: connection.reason ?? "所选助手未提供文本交付能力",
    };
  const controller = assistantInputController(
    service,
    { dataScopeId: scope, canvasId: canvas.id, nodeId, purpose: "text" },
    {
      prompt:
        canvas.nodeData[nodeId]?.prompt ??
        canvas.nodeData[nodeId]?.panelPrompt ??
        "",
    },
  );
  const draft = controller.getSnapshot().draft;
  const modelKey = `${connection.adapterId}:${connection.connectionId}`;
  const model =
    draft.models[modelKey] ??
    (sessionConnection === connection.connectionId
      ? history?.model
      : undefined) ??
    (!sessionConnection && preference?.connectionId === connection.connectionId
      ? preference.model
      : undefined);
  const catalog = directory.catalogs[connection.adapterId];
  const models = connection.models.length
    ? connection.models
    : (catalog?.models ?? []);
  const selectedModel = models.find((candidate) => candidate.id === model);
  if (!model || !selectedModel || connection.modelsError || catalog?.error)
    return {
      eligible: false,
      reason:
        connection.modelsError ??
        catalog?.error ??
        "文本成员所选助手模型已失效，请明确选择",
    };
  const effort =
    draft.efforts[`${modelKey}:${model}`] ??
    (sessionConnection === connection.connectionId && history?.model === model
      ? history?.reasoningEffort
      : undefined) ??
    (!sessionConnection &&
    preference?.connectionId === connection.connectionId &&
    preference.model === model
      ? preference.reasoningEffort
      : undefined);
  if (effort && !reasoningEffortsOf(selectedModel).includes(effort))
    return { eligible: false, reason: "文本成员的 Variant 已失效" };
  return {
    eligible: true,
    input: {
      canvasId: canvas.id,
      adapterId: connection.adapterId,
      connectionId: connection.connectionId,
      entry: {
        action: "generate",
        mode: "text",
        roleId: AGENT_ROLE_BINDINGS.textAuthor,
        canvasId: canvas.id,
        nodeId,
        connectionId: connection.connectionId,
        connection: {
          connectionId: connection.connectionId,
          adapterId: connection.adapterId,
          configRevision: connection.configRevision,
          credentialEpoch: connection.credentialEpoch,
        },
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
        prompt:
          draft.promptScope && draft.promptScope !== `${modelKey}:${model}`
            ? (draft.prompts?.[`${modelKey}:${model}`] ?? "")
            : draft.prompt,
      },
    },
  };
}
