import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { AgentConnectionView, AgentReasoningEffort, CanvasCreationView } from "@woohaa3/contracts";
import { useService } from "../../react.js";
import { Button } from "../../../shared/ui/Button.js";
import { SparklesIcon } from "../../../shared/ui/icons.js";
import { ModelSelector } from "../task-execution/execution-panel/model-selector.js";
import { agentModelSelection, agentDirectoryModels } from "../task-execution/agent-model-selection.js";
import { agentDirectory } from "../../services/agent-directory.js";
import { rememberAssistantPreference } from "../../services/assistant-execution/selection.js";
import { creationInput, creationDraft, creationResponse, readCreation, CANVAS_CREATIONS_PATH, subscribeCreationDraft, creationDraftRevision, notifyCreationDraft } from "./canvas-creation-drafts.js";
import "../task-execution/execution-panel/execution-panel.css";

/** UI loads with the application and reuses the directory warmed when the canvas becomes ready. */
export default function CanvasCreationAgent(props: {
  menuIdentity?: object;
  world: { x: number; y: number };
  writable: boolean;
  onClose(): void;
  submitRef: MutableRefObject<(() => void) | null>;
}) {
  const remote = useService("applicationRemote");
  const conversations = useService("agentConversationService");
  const scope = useService("canvasScope");
  const user = useService("currentUser");
  const navigation = useService("canvasNavigation");
  const locate = useService("canvasLocate");
  const groupRuns = useService("canvasGroupRuns");
  const session = useSyncExternalStore(user.subscribe, user.getSnapshot, user.getSnapshot);
  const canvasId = scope.canvasId();
  const namespace = session?.dataScopeId;
  const draft = creationDraft(remote.transport, namespace ?? "unresolved", canvasId);
  useSyncExternalStore(listener => subscribeCreationDraft(draft, listener), () => creationDraftRevision(draft));
  const directory = agentDirectory(conversations, namespace ?? "unresolved");
  const directoryState = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const { connections, catalogs } = directoryState;
  const loadingMessage = namespace && !directoryState.ready ? directoryState.loadingMessage : "";
  const loading = Boolean(loadingMessage);
  const [notice, setNotice] = useState("");
  const [selector, setSelector] = useState<"assistant" | "model" | null>(null);
  const alive = useRef(false);
  const displayedDraft = useRef(draft);
  displayedDraft.current = draft;
  const displayedMenu = useRef(props.menuIdentity);
  displayedMenu.current = props.menuIdentity;
  const isCurrent = () => alive.current && displayedDraft.current === draft && displayedMenu.current === props.menuIdentity && user.getSnapshot()?.dataScopeId === namespace && scope.canvasId() === canvasId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (namespace) void directory.load(); }, [directory, namespace]);
  const connection = connections.find(c => c.connectionId === draft.connectionId);
  const catalog = connection ? catalogs[connection.adapterId] : undefined;
  const supportsGroup = (c: AgentConnectionView) => Boolean(catalogs[c.adapterId]?.capabilities.targets.includes("canvas-group") && catalogs[c.adapterId]?.capabilities.tools && c.capabilities.tools);
  const models = agentDirectoryModels(connection?.models, catalog?.models);
  const toolDefault = connection?.authMode === "local-login";
  const selection = agentModelSelection(models, draft.model, draft.effort, !toolDefault);
  // 本机来源（auth-mode local-login）的账号证据只在真实执行时才可获得：创建前的 ready 只代表
  // 运行依赖已探测，不能作为拦死第一次创作的门禁；账号不可用时由本轮执行返回真实失败。
  const blocked = !namespace ? "正在确认当前数据空间" : !props.writable ? "画布当前不可写" : !connection ? "请选择助手连接" : !supportsGroup(connection) ? "此助手尚未支持节点搭建" : !connection.ready && connection.authMode !== "local-login" ? connection.reason ?? "助手尚未就绪" : selection.missingRequiredModel ? "请选择助手模型" : selection.invalidModel ? "原模型已失效，请重新选择" : selection.invalidEffort ? "原 Variant 已失效，请重新选择" : connection.models.find(m => m.id === draft.model)?.capabilities?.tools === false ? "此模型不支持工具执行" : "";
  const edit = (patch: Partial<typeof draft>) => {
    Object.assign(draft, patch); draft.version++; notifyCreationDraft(draft);
    if (patch.connectionId !== undefined || patch.model !== undefined || patch.effort !== undefined) {
      const selected = connections.find(c => c.connectionId === draft.connectionId);
      if (selected && namespace) rememberAssistantPreference(namespace, { sourceId: selected.adapterId, connectionId: selected.connectionId, model: draft.model, reasoningEffort: draft.effort });
    }
  };
  const inputController = creationInput(draft);
  const accepted = (view: CanvasCreationView, requestId: string) => {
    if (view.requestId !== requestId || view.canvasId !== canvasId) throw new Error("创建响应与原请求不一致，请核对原请求");
    draft.result = view;
    void groupRuns?.refresh();
    const state = inputController.getSnapshot();
    if (view.stage === "accepted" && state.revision === state.pending?.revision && isCurrent()) {
      locate.locateNodes([view.rootGroupId]); props.onClose();
    }
    return view.stage === "accepted" ? { kind: "accepted" as const, value: view }
      : { kind: "unknown" as const, message: view.error?.message ?? "创建尚未完成，请核对原请求" };
  };
  const port = {
    async query(_input: Omit<import("@woohaa3/contracts").CanvasCreationRequest, "requestId">, requestId: string) {
      return accepted(await readCreation(remote.transport, requestId), requestId);
    },
    async submit(input: Omit<import("@woohaa3/contracts").CanvasCreationRequest, "requestId">, requestId: string) {
      const result = await remote.transport.request({ path: CANVAS_CREATIONS_PATH, method: "POST", body: { ...input, requestId } });
      if (result.ok) return accepted(creationResponse(result.data), requestId);
      if ((result.body as { creationRegistered?: boolean } | undefined)?.creationRegistered === false) return { kind: "rejected" as const, message: result.error };
      if (result.status === undefined || result.status >= 500) return port.query(input, requestId);
      return { kind: "unknown" as const, message: result.error };
    },
  };
  const submit = async (queryOnly = false) => {
    const original = inputController.getSnapshot();
    if (original.busy || (!original.pending && (loading || blocked || !draft.prompt.trim() || !connection))) return;
    if (queryOnly) { await inputController.query(port); return; }
    await inputController.submit(original.pending?.input ?? {
      canvasId, position: props.world, prompt: draft.prompt.trim(),
      connection: { connectionId: connection!.connectionId, adapterId: connection!.adapterId, configRevision: connection!.configRevision, credentialEpoch: connection!.credentialEpoch },
      ...(draft.model ? { model: draft.model } : {}), ...(draft.effort ? { reasoningEffort: draft.effort } : {}),
    }, port);
  };
  const manage = () => { setSelector(null); props.onClose(); navigation.openDialog({ dialogId: "agent-assistant", payload: { canvasId } }); };
  useEffect(() => {
    const submitCurrent = () => { void submit(); };
    props.submitRef.current = submitCurrent;
    return () => { if (props.submitRef.current === submitCurrent) props.submitRef.current = null; };
  });
  return <div className="canvas-create__composer">
        <div className="canvas-create__ai-heading"><SparklesIcon /><span>节点搭建</span></div>
        <div className="assistant-creation-controls">
          <ModelSelector label="选择助手" placeholder={loading ? "正在读取助手…" : "选择助手"} model={draft.connectionId} open={selector === "assistant"} onOpenChange={open => setSelector(open ? "assistant" : null)} onManage={manage} disabled={loading || draft.busy || Boolean(draft.pending)} options={connections.map(c => ({ value: c.connectionId, label: c.name, disabled: !supportsGroup(c), detail: c.reason }))} onChange={connectionId => edit({ connectionId, model: "", effort: "" })} />
          {connection && (!toolDefault || models.length > 0) ? <ModelSelector keepOpenOnModelSelect label="选择助手模型" model={draft.model} open={selector === "model"} onOpenChange={open => setSelector(open ? "model" : null)} disabled={draft.busy || Boolean(draft.pending)} options={[...(toolDefault ? [{ value: "", label: "使用助手默认模型" }] : []), ...models.map(m => ({ value: m.id, label: m.label, disabled: connection.models.find(c => c.id === m.id)?.capabilities?.tools === false }))]} onChange={model => edit({ model, effort: "" })} variant={selection.supportedEfforts.length ? { value: draft.effort, options: [{ value: "", label: "默认 Variant" }, ...selection.supportedEfforts.map(value => ({ value, label: value }))], onChange: value => edit({ effort: value as AgentReasoningEffort | "" }) } : undefined} /> : null}
          <Button tone="primary" disabled={loading || draft.busy || Boolean(blocked) || !draft.prompt.trim()} onClick={() => void submit()}>{draft.busy ? "正在创建…" : draft.pending ? "重试原请求" : "创建"}</Button>
        </div>
        {loadingMessage || notice || directoryState.error || draft.notice || blocked || connection?.modelsError ? <p className="canvas-create__notice">{loadingMessage || notice || directoryState.error || draft.notice || blocked || connection?.modelsError}</p> : null}
        <div className="assistant-creation-recovery">
          <button type="button" onClick={() => { setNotice(""); void directory.load(true); }} disabled={Boolean(directoryState.loadingMessage)}>刷新助手</button><button type="button" onClick={manage}>管理助手</button>
          {draft.pending ? <button type="button" disabled={draft.busy} onClick={() => void submit(true)}>查询原请求</button> : null}
          {draft.result ? <button type="button" onClick={() => locate.locateNodes([draft.result!.rootGroupId])}>定位创作组</button> : null}
          <span>Ctrl / ⌘ + Enter 创建</span>
        </div>
      </div>;
}
