import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { AssistantConfiguration, ReasoningParameters } from "./configuration.js";
import { roleIdForTarget } from "../../services/agent-role-bindings.js";
import { AssistantTextInput } from "./text-input.js";
/** 宿主统一的 3D 创作入口。草稿属于当前页面，会话事实仍由 Agent 服务持有。 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AssistantComposer } from "@woohaa3/ui/assistant";
import {
  ASSISTANT_SETUP_HINT,
} from "@woohaa3/ui/assistant";
import { useAssistantExecutionActions } from "./status.js";
import { useAssistantDeliveryInput } from "./delivery-input.js";
import {
  agentModelSelection,
  agentDirectoryModels,
} from "../../plugins/task-execution/agent-model-selection.js";
import {
  readAssistantPreference,
  rememberAssistantPreference,
} from "../../services/assistant-execution/selection.js";
import { AuthoringGenerateLayout } from "../../plugins/task-execution/authoring-generate-layout.js";
import { AuthoringMcpButton } from "../../plugins/task-execution/model-parameter-panel.js";
import { Button } from "@woohaa3/ui/primitives";
import { SendIcon } from "@woohaa3/ui/icons";
import { resolveAgentDetailAction } from "../../plugins/task-execution/execution-panel/agent-detail-action.js";
import type { AgentConversationSnapshotView } from "../../contract/agent-conversation.js";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import { assistantInputController } from "../../services/assistant-execution/controller.js";
import { assistantConversationPort } from "../../services/assistant-execution/conversation-port.js";
import type {
  AgentConversationSubmitInput,
  AgentConversationSubmitResult,
} from "../../contract/agent-conversation.js";
import { reasoningEffortsOf, type AgentReasoningEffort } from "@woohaa3/contracts";
import "../../plugins/task-execution/execution-panel/execution-panel.css";
import "../../plugins/task-execution/authoring-generate-panel.css";

// 以页面 service 的生命周期隔离临时草稿，切到详情或设置后可恢复；不写浏览器持久存储。
const EMPTY_SNAPSHOT: AgentConversationSnapshotView = {
  active: null,
  detail: null,
  conversations: [],
  mcp: null,
  loading: false,
  error: null,
  contextRevision: 0,
};
const noopSubscribe = () => () => undefined;

export function AssistantAuthoringComposer(props: AuthoringGenerationProps) {
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const inspector = props.presentation === "inspector";
  const conversation = props.agentConversation;
  const service = conversation?.service;
  const delivery =
    props.deliveryHistory?.status !== "succeeded"
      ? props.deliveryHistory
      : undefined;
  const deliveryInput = useAssistantDeliveryInput(service, delivery?.execution);
  const deliveryActions = useAssistantExecutionActions();
  const fallback = useRef({});
  const controller = assistantInputController<
    AgentConversationSubmitInput,
    AgentConversationSubmitResult
  >(
    service ?? fallback.current,
    {
      dataScopeId: service?.getDataScopeId?.() ?? "page",
      canvasId: props.canvasId,
      nodeId: props.nodeId,
      purpose: props.mode,
    },
    { prompt: props.mode === "text" ? "" : (props.initialPrompt ?? "") },
  );
  const input = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    // A new conversion target inherits its accepted input; never replace an existing editable draft.
    if (!deliveryInput?.connectionId || controller.getSnapshot().revision !== 0)
      return;
    const key = `${deliveryInput.adapterId}:${deliveryInput.connectionId}`;
    controller.edit({
      prompt: deliveryInput.prompt,
      models: deliveryInput.model ? { [key]: deliveryInput.model } : {},
      efforts: deliveryInput.reasoningEffort
        ? {
            [`${key}:${deliveryInput.model ?? ""}`]:
              deliveryInput.reasoningEffort,
          }
        : {},
    });
  }, [controller, deliveryInput]);
  const { prompt, models, efforts } = input.draft;
  const setPrompt = (prompt: string) => controller.edit({ prompt });
  const setEfforts = (change: (current: typeof efforts) => typeof efforts) =>
    controller.edit({ efforts: change(efforts) });
  const [openSelector, setOpenSelector] = useState<
    "assistant" | "model" | null
  >(null);
  const busy = input.busy;
  useEffect(() => {
    props.onDraftStateChange?.({ hasDraft: prompt.trim().length > 0, busy });
  }, [props.onDraftStateChange, controller, prompt, busy]);
  const notice = input.notice;
  const selection = props.sourceSelection;
  const connections = selection?.connections ?? [];
  const sourceId = delivery
    ? (deliveryInput?.adapterId ?? "")
    : (selection?.selectedSourceId ?? "");
  const connectionId = delivery
    ? (deliveryInput?.connectionId ?? null)
    : (selection?.selectedConnectionId ?? null);
  const selectedConnection =
    connections.find((entry) => entry.connectionId === connectionId) ?? null;
  const toolDefault = selectedConnection?.modelSelection === "tool-default";
  const modelKey = `${sourceId}:${connectionId ?? ""}`;
  const directory = service ? agentDirectory(service, service.getDataScopeId?.() ?? "page") : null;
  const directoryView = useSyncExternalStore(directory?.subscribe ?? noopSubscribe, directory?.getSnapshot ?? (() => null), directory?.getSnapshot ?? (() => null));
  const catalog = { key: modelKey, models: directoryView?.catalogs[sourceId]?.models ?? [], loading: directoryView?.sourceStates[sourceId]?.status === "loading", error: directoryView?.sourceStates[sourceId]?.error };
  const preferenceScope = service?.getDataScopeId?.() ?? "page";
  const [preference] = useState(() => readAssistantPreference(preferenceScope));
  const [history, setHistory] = useState<{
    connectionId?: string;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  } | null>(null);
  useEffect(() => {
    if (!service || !conversation?.conversationId) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    void service
      .readConversation(conversation.conversationId)
      .then((result) => {
        if (!cancelled && result.ok) {
          const latest = result.value.turns.at(-1);
          setHistory({
            connectionId: result.value.conversation.connectionId,
            model: latest?.target.model,
            reasoningEffort: latest?.target.reasoningEffort,
          });
        }
      })
      .catch(() => {
        /* A failed history read never triggers a generation. */
      });
    return () => {
      cancelled = true;
    };
  }, [service, conversation?.conversationId]);
  const initialSelection = history
    ? history.connectionId === connectionId
      ? history
      : undefined
    : preference?.connectionId === connectionId
      ? preference
      : undefined;
  const model = delivery
    ? (deliveryInput?.model ?? "")
    : (models[modelKey] ?? initialSelection?.model ?? "");

  const remember = (
    model: string,
    reasoningEffort: AgentReasoningEffort | "" = "",
  ) => {
    if (sourceId && connectionId)
      rememberAssistantPreference(preferenceScope, {
        sourceId,
        connectionId,
        model,
        reasoningEffort,
      });
  };
  const missingRequiredModel =
    (props.mode === "text" ||
      selectedConnection?.modelSelection === "explicit") &&
    !model.trim();
  const snapshot = useSyncExternalStore(
    service?.subscribe ?? noopSubscribe,
    service?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    service?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  const textRows =
    props.mode === "text"
      ? Object.values(snapshot.turnsByRequest ?? {}).filter(
          (item) =>
            item.turn.target.canvasId === props.canvasId &&
            item.turn.target.nodeId === props.nodeId &&
            ["queued", "running", "committing", "unknown"].includes(
              item.turn.status,
            ),
        )
      : [];
  const active =
    (input.accepted?.requestId
      ? snapshot.turnsByRequest?.[input.accepted.requestId]
      : undefined) ??
    (conversation?.latestRequestId
      ? snapshot.turnsByRequest?.[conversation.latestRequestId]
      : undefined) ??
    Object.values(snapshot.turnsByRequest ?? {})
      .filter(
        (entry) =>
          entry.turn.target.canvasId === props.canvasId &&
          entry.turn.target.nodeId === props.nodeId &&
          (entry.conversationId === conversation?.conversationId ||
            entry.turn.target.connectionId === connectionId),
      )
      .at(-1) ??
    (snapshot.turnsByRequest ? null : snapshot.active);
  const turn =
    active?.turn.target.canvasId === props.canvasId &&
    active.turn.target.nodeId === props.nodeId &&
    (active.turn.target.connectionId === connectionId ||
      active.conversationId === conversation?.conversationId)
      ? active
      : null;
  const inProgress = Boolean(
    turn && ["queued", "running", "committing"].includes(turn.turn.status),
  );
  // 失败是终态：停止后即可继续提交；不再保留独立的待核对锁定。
  const locked =
    busy ||
    Boolean(delivery) ||
    Boolean(selection?.blockedReason) ||
    (props.mode !== "text" && Boolean(inProgress));
  const noConnection = !service || !connectionId || !selectedConnection;
  const emptyDirectory =
    !connections.length && !selection?.loading && !selection?.error;
  useEffect(() => {
    if (locked || noConnection) setOpenSelector(null);
  }, [locked, noConnection]);

  const connectionModels = selectedConnection?.models;
  // 连接自带的模型列表优先；空列表表示该来源尚未内联目录，继续读 adapter 的真实目录
  // （本机 App Server 的模型来自 `model/list`，不能在连接描述里伪造默认模型）。
  const modelOptions = agentDirectoryModels(
    connectionModels,
    catalog.key === modelKey ? catalog.models : [],
  );
  const effortKey = `${modelKey}:${model}`;
  const effort = delivery
    ? (deliveryInput?.reasoningEffort ?? "")
    : (efforts[effortKey] ??
      (models[modelKey] === undefined
        ? initialSelection?.reasoningEffort
        : undefined) ??
      "");
  const { supportedEfforts, invalidEffort, invalidModel } = agentModelSelection(
    modelOptions,
    model,
    effort,
    selectedConnection?.modelSelection === "explicit",
  );
  const [configurationNotice, setConfigurationNotice] = useState("");
  useEffect(() => {
    if (!delivery && invalidEffort && directoryView?.ready && !catalog.loading) {
      controller.edit({ efforts: { ...controller.getSnapshot().draft.efforts, [effortKey]: "" } });
      setConfigurationNotice("新模型不支持原思考强度，已恢复默认");
    }
  }, [controller, effortKey, invalidEffort, delivery, catalog.loading, directoryView?.ready]);
  const modelError =
    selectedConnection?.modelsError ??
    (catalog.key === modelKey ? catalog.error : undefined);
  const detailConversation =
    delivery?.execution?.conversationId ??
    turn?.conversationId ??
    conversation?.conversationId ??
    props.deliveryHistory?.execution?.conversationId;
  const detailRequest =
    delivery?.execution?.turnRequestId ??
    turn?.requestId ??
    conversation?.latestRequestId ??
    props.deliveryHistory?.execution?.turnRequestId;
  const detail = resolveAgentDetailAction({
    status: delivery?.status ?? turn?.turn.status ?? "idle",
    hasConversation: Boolean(detailConversation && detailRequest),
  });
  const target =
    props.mode === "text"
      ? {
          title: "生成文本",
          placeholder: "描述要生成的文字，或引用上游内容…",
          action: "生成",
        }
      : props.worldScope?.kind === "world-camera"
        ? { title: "调整镜头", placeholder: "描述想要的构图、机位或视野…", action: "调整镜头" }
      : {
          title: inspector ? "AI 修改" : "生成 3D 模型",
          placeholder: inspector
            ? "描述想修改的部分，例如：把灯罩改成磨砂金属，保留支架造型…"
            : "描述形状、材质和细节，例如：一盏磨砂金属台灯，圆形灯罩，细长支架…",
          action: inspector ? "修改模型" : "生成",
        };

  // 连接或来源变化时收起选择器；目录重读（catalogAttempt）不打断已展开的面板。
  useEffect(() => {
    setOpenSelector(null);
  }, [modelKey, props.nodeId, props.canvasId, preferenceScope]);

  // 重开面板时补读一次当前回合（不重复提交）；进行中的持续刷新由页面级 run-state 统一负责，
  // 避免面板与页面各挂一条轮询（节点执行中状态在面板关闭后仍需收敛）。
  useEffect(() => {
    if (!service?.queryTurn || !detailRequest || inProgress || delivery) return;
    void service.queryTurn(detailRequest).catch(() => undefined);
  }, [service, detailRequest, Boolean(inProgress), Boolean(delivery)]);

  const port = service ? assistantConversationPort(service) : null;
  const submit = async () => {
    if (!port) return;
    if (input.pending) {
      await controller.submit(input.pending.input, port);
      return;
    }
    if (
      locked ||
      noConnection ||
      (!selectedConnection?.ready && !toolDefault) ||
      !props.writable ||
      (props.mode !== "text" && !prompt.trim()) ||
      invalidModel ||
      invalidEffort ||
      missingRequiredModel ||
      selection?.error ||
      props.mcpHint?.blockedReason
    )
      return;
    if (!conversation || !service || !connectionId) return;
    const entry = {
      action: "generate" as const,
      canvasId: props.canvasId,
      nodeId: props.nodeId,
      mode: props.mode,
      ...(props.worldScope ? { worldScope: props.worldScope } : {}),
      roleId: roleIdForTarget({ ...(props.mode ? { mode: props.mode } : {}), ...(props.worldScope ? { worldScope: props.worldScope } : {}) }),
      connectionId,
      ...(selectedConnection?.binding
        ? { connection: selectedConnection.binding }
        : {}),
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(props.expectedContentHash
        ? { expectedContentHash: props.expectedContentHash }
        : {}),
      prompt: props.mode === "text" ? prompt : prompt.trim(),
    };
    await (
      props.mode === "text" ? controller.submitIndependent : controller.submit
    )(
      {
        canvasId: props.canvasId,
        adapterId: sourceId,
        connectionId,
        ...(conversation.conversationId
          ? { conversationId: conversation.conversationId }
          : {}),
        entry,
      },
      port,
    );
  };

  const reason =
    referenceError ||
    selection?.error ||
    selection?.blockedReason ||
    (selectedConnection && !selectedConnection.ready && !toolDefault
      ? (selectedConnection.reason ?? "助手尚未就绪，请检查连接")
      : null) ||
    (!props.writable ? props.disabledReason : null) ||
    props.mcpHint?.blockedReason ||
    (invalidModel ? "所选模型已不在当前目录中，请重新选择。" : null) ||
    (invalidEffort ? "当前模型已不支持所选 思考强度，请重新选择。" : null);

  return (
    <div
      className="mc-panel authoring-generate"
      data-testid="authoring-generate"
      data-presentation={props.presentation ?? "dock"}
      data-mode={props.mode}
      data-source-id={sourceId}
    >
      <AuthoringGenerateLayout
        inspector={inspector}
        presentation={props.presentation === "expanded" ? "expanded" : "dock"}
        requestPresentation={props.requestPresentation}
        onRefresh={() => {
          // 刷新按钮同时重读连接与模型目录：模型目录不在连接目录里（本机来源按 adapter 读取），
          // 只刷新连接会让按钮看起来「点了没用」。
          selection?.onRefresh?.();
          void directory?.load(true);
        }}
        onManage={props.onAuthorize}
        disabled={locked}
        refreshing={selection?.loading}
        references={
          props.mode === "text" ? (
            <AssistantTextInput
              value=""
              onChange={() => undefined}
              onSubmit={() => undefined}
              showEditor={false}
              nodeId={props.nodeId}
              disabled={locked || !props.writable}
              capabilities={selectedConnection?.textDelivery}
              onValidation={setReferenceError}
            />
          ) : (
            props.renderers?.references?.()
          )
        }
        mcp={
          <AuthoringMcpButton
            canvasId={props.canvasId}
            nodeId={props.nodeId}
            mcpServerUrl={props.mcpHint?.serverUrl}
          />
        }
        prompt={
          <div className="mc-panel__prompt-box authoring-generate__composer">
            {props.mode === "text" ? (
              <AssistantTextInput
                nodeId={props.nodeId}
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => void submit()}
                disabled={locked || !props.writable}
                capabilities={selectedConnection?.textDelivery}
                onValidation={setReferenceError}
                showReferences={false}
              />
            ) : (
              <AssistantComposer
                className="mc-panel__textarea"
                placeholder={
                  delivery?.execution && !deliveryInput
                    ? "正在读取本次创作描述…"
                    : target.placeholder
                }
                value={delivery ? (deliveryInput?.prompt ?? "") : prompt}
                onChange={setPrompt}
                disabled={locked || !props.writable}
                onSubmit={() => void submit()}
              />
            )}
          </div>
        }
        assistant={service ? <AssistantConfiguration service={service} connectionId={connectionId ?? ""} model={model} purpose={props.mode ?? "world"}
          open={openSelector === "assistant"} onOpenChange={open => setOpenSelector(current => open ? "assistant" : current === "assistant" ? null : current)} disabled={locked || !!selection?.loading} onManage={props.onAuthorize}
          reasonFor={(c) => {
            const entry = connections.find(e => e.connectionId === c.connectionId);
            if (!entry) return "此连接不支持当前用途";
            return !entry.ready ? entry.reason || "助手尚未就绪" : undefined;
          }}
          onSelect={(c, value) => {
            const key = `${c.adapterId}:${c.connectionId}`;
            const nextEffort = efforts[`${key}:${value}`] ?? "";
            const nextOptions = agentDirectoryModels(c.models, directoryView?.catalogs[c.adapterId]?.models).find(m => m.id === value) ? reasoningEffortsOf(agentDirectoryModels(c.models, directoryView?.catalogs[c.adapterId]?.models).find(m => m.id === value)!) : [];
            setConfigurationNotice(effort && !nextEffort && !nextOptions.includes(effort) ? "新模型不支持原思考强度，已恢复默认" : "");
            controller.edit({ models: { ...models, [key]: value } });
            if (c.connectionId !== connectionId || (selectedConnection?.binding && (selectedConnection.binding.configRevision !== c.configRevision || selectedConnection.binding.credentialEpoch !== c.credentialEpoch))) selection?.onSelectConnection(c.connectionId);
          }} /> : null}
        model={<ReasoningParameters value={effort} options={supportedEfforts} open={openSelector === "model"} onOpenChange={open => setOpenSelector(current => open ? "model" : current === "model" ? null : current)} disabled={locked}
          onChange={value => { setEfforts(current => ({ ...current, [effortKey]: value as AgentReasoningEffort | "" })); remember(model, value as AgentReasoningEffort | ""); }} />}
        detail={
          <>
              {textRows.map((row, index) => (
                <span key={row.requestId} className="authoring-generate__run">
                  <span>
                    文本回合 {index + 1} ·{" "}
                    {row.turn.status === "committing"
                      ? "正在保存"
                      : "生成中"}
                  </span>
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={() =>
                      conversation?.onOpenDetail({
                        conversationId: row.conversationId,
                        requestId: row.requestId,
                        nodeId: props.nodeId,
                      })
                    }
                  >
                    查看此回合
                  </Button>
                  <Button
                    size="sm"
                    tone="ghost"
                    disabled={!props.writable || deliveryActions.busy}
                    onClick={() =>
                      void deliveryActions.perform(async () => {
                        const result = await service!.cancelTurn(row.requestId);
                        if (result.ok) await service!.queryTurn(row.requestId);
                        return result;
                      })
                    }
                  >
                    停止此回合
                  </Button>
                </span>
              ))}
              {props.mode === "text"
                ? input.submissions.map((item) => (
                    <span key={item.requestId}>
                      {item.busy ? (
                        "正在受理文本回合…"
                      ) : (
                        <Button
                          size="sm"
                          tone="ghost"
                          onClick={() => {
                            if (port)
                              void controller.querySubmission(
                                item.requestId,
                                port,
                              );
                          }}
                        >
                          查询提交结果
                        </Button>
                      )}
                    </span>
                  ))
                : null}
              {!delivery && input.pending ? (
                <Button
                  size="sm"
                  tone="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (port) void controller.query(port);
                  }}
                >
                  查询结果
                </Button>
              ) : null}
              {!textRows.length &&
              detail &&
              detailConversation &&
              detailRequest ? (
                <Button
                  size="sm"
                  tone="ghost"
                  className="authoring-generate__detail"
                  data-testid="authoring-generate-detail"
                  data-emphasis={detail.emphasis}
                  title={detail.summary}
                  onClick={() =>
                    conversation?.onOpenDetail({
                      conversationId: detailConversation,
                      requestId: detailRequest,
                      nodeId: props.nodeId,
                    })
                  }
                >
                  {detail.label}
                </Button>
              ) : null}
          </>
        }
        submit={
          delivery ? (
            delivery.cancel ? (
              <Button
                tone="neutral"
                disabled={deliveryActions.busy || !props.writable}
                onClick={() => void deliveryActions.perform(delivery.cancel!)}
              >
                停止
              </Button>
            ) : delivery.retry ? (
              <Button
                tone="primary"
                disabled={deliveryActions.busy || !props.writable}
                onClick={() => void deliveryActions.perform(delivery.retry!)}
              >
                重试
              </Button>
            ) : (
              <Button tone="primary" disabled>
                {delivery.stage}
              </Button>
            )
          ) : (
            <Button
              tone="primary"
              icon={<SendIcon size={14} />}
              loading={busy}
              onClick={() => void submit()}
              disabled={
                locked ||
                !props.writable ||
                noConnection ||
                (props.mode !== "text" && !prompt.trim()) ||
                Boolean(reason) ||
                invalidModel ||
                missingRequiredModel ||
                selection?.loading
              }
            >
              {busy
                ? "正在提交"
                : inProgress && props.mode !== "text"
                  ? "执行中"
                  : target.action}
            </Button>
          )
        }
      />
      {delivery ? (
        <>
          {delivery.reason ? (
            <p className="authoring-generate__reason">{delivery.reason}</p>
          ) : null}
          {deliveryActions.error ? (
            <p className="authoring-generate__reason">
              {deliveryActions.error}
            </p>
          ) : null}
        </>
      ) : null}
      {!delivery && modelError ? (
        <p className="authoring-generate__reason">{modelError}</p>
      ) : null}
      {!delivery && emptyDirectory ? (
        <p
          className="authoring-generate__hint"
          data-testid="authoring-generate-empty"
        >
          {ASSISTANT_SETUP_HINT}
        </p>
      ) : null}
      {!delivery && reason ? (
        <p
          className="authoring-generate__reason"
          data-testid="authoring-generate-blocked"
        >
          {reason}
        </p>
      ) : null}
      {configurationNotice ? <p className="authoring-generate__notice">{configurationNotice}</p> : null}
      {notice ? (
        <p
          className="authoring-generate__notice"
          data-testid="authoring-generate-notice"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
