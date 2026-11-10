import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { agentDirectoryModels } from "../../services/assistant-execution/selection.js";
import { AssistantConfiguration, ReasoningParameters } from "../../ui/assistant-execution/configuration.js";
import { generationIdentity, recordAcceptedGeneration } from "../../services/assistant-execution/recent.js";
import { AGENT_ROLE_BINDINGS } from "../../services/agent-role-bindings.js";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AssistantComposer, AssistantToolbar } from "@woohaa3/ui/assistant";
import { Dialog } from "@woohaa3/ui/dialogs";
import { Button } from "@woohaa3/ui/primitives";
import { ImageIcon, SparklesIcon } from "@woohaa3/ui/icons";
import { createHighEntropyId, IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT, type AgentReasoningEffort } from "@woohaa3/contracts";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";
import { beginDirectorSceneSelection, type DirectorSceneSelectionIntent } from "./scene-selection.js";
import { readAssistantPreference, rememberAssistantPreference } from "../../services/assistant-execution/selection.js";
import type { AgentConversationServiceHandle } from "../../services/agent-conversation-service.js";
import "./style.css";

export const IMAGE_DIRECTOR_PLUGIN_ID = "image-director-scene";
type Draft = { prompt: string; connectionId: string; model: string; variant: string; efforts?: Record<string, string> };
const drafts = new Map<string, Draft>();
const initial = (): Draft => ({ prompt: IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT, connectionId: "", model: "", variant: "" });
function imageReady(nodeId: string) {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  const assetId = canvas?.nodeData[nodeId]?.outputAssetId;
  return !!canvas?.document.nodes.some(node => node.id === nodeId && node.type === "image") && !!canvas.assets.find(asset => asset.id === assetId && asset.status === "ready" && asset.mediaKind === "image");
}

export function ImageDirectorPanel({ ctx, canvasId, nodeId, visible, onClose, beginSelection }: { ctx: Context; canvasId: string; nodeId: string; visible: boolean; onClose: () => void; beginSelection?: () => DirectorSceneSelectionIntent }) {
  const service = ctx.get("agentConversationService" as never) as AgentConversationServiceHandle | undefined;
  const scope = service?.getDataScopeId?.() ?? "page";
  const key = JSON.stringify([scope, canvasId, nodeId]);
  const [draft, setDraft] = useState(() => { const preference = readAssistantPreference(scope); return drafts.get(key) ?? { ...initial(), connectionId: preference?.connectionId ?? "", model: preference?.model ?? "", variant: preference?.reasoningEffort ?? "" }; });
  const draftRef = useRef(draft);
  const directory = service ? agentDirectory(service, scope) : null;
  const directoryView = useSyncExternalStore(directory?.subscribe ?? (() => () => {}), directory?.getSnapshot ?? (() => null), directory?.getSnapshot ?? (() => null));
  const connections = directoryView?.connections ?? [];
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<"connection" | "model" | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshing = !!directoryView?.loadingMessage;
  const submitting = useRef(false);
  const live = useRef(true);
  const selectionIntent = useRef<DirectorSceneSelectionIntent | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; selectionIntent.current?.cancel(); }; }, []);
  const requestId = useRef<string | null>(null);
  const update = (patch: Partial<Draft>) => {
    const previous = draftRef.current;
    const efforts = { ...previous.efforts, [generationIdentity(previous.connectionId, previous.model)]: previous.variant, ...patch.efforts };
    const next = { ...previous, ...patch, efforts };
    efforts[generationIdentity(next.connectionId, next.model)] = next.variant;
    draftRef.current = next; drafts.set(key, next); setDraft(next);
  };
  useEffect(() => { void directory?.load(); }, [directory]);
  const connection = connections.find(item => item.connectionId === draft.connectionId);
  const models = agentDirectoryModels(connection?.models, connection ? directoryView?.catalogs[connection.adapterId]?.models : undefined);
  const model = models.find(item => item.id === draft.model);
  useEffect(() => { if (model && draft.variant && !model.reasoningEfforts?.includes(draft.variant as AgentReasoningEffort)) { update({ variant: "" }); setError("新模型不支持原思考强度，已恢复默认"); } }, [model, draft.variant]);
  const modelCapabilities = connection?.models.find(item => item.id === draft.model)?.capabilities;
  const candidateCapability = modelCapabilities?.textDelivery ?? connection?.capabilities.textDelivery;
  const selectionInvalid = !connection?.ready || !connection.capabilities.tools || !connection.capabilities.targets?.includes("world") || !candidateCapability?.imageInput || candidateCapability.maxImages < 1 || !model || (!!draft.variant && !model.reasoningEfforts?.includes(draft.variant as AgentReasoningEffort));
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  const asset = canvas?.assets.find(item => item.id === canvas.nodeData[nodeId]?.outputAssetId);
  const thumbnail = resolveCanonicalMediaUrl(asset, canvasId);
  const submit = async () => {
    if (!service?.submitImageDirectorScene || !connection || !model || selectionInvalid || submitting.current || !ctx.canvasSession.isWritable()) return;
    submitting.current = true; setBusy(true); setError(null);
    selectionIntent.current = beginSelection?.() ?? null;
    requestId.current ??= createHighEntropyId("image-director");
    try {
      const result = await service.submitImageDirectorScene({ canvasId, adapterId: connection.adapterId, connectionId: connection.connectionId, requestId: requestId.current, entry: { action: "generate", roleId: AGENT_ROLE_BINDINGS.sceneDirector, canvasId, nodeId, connectionId: connection.connectionId, model: model.id, ...(draft.variant ? { reasoningEffort: draft.variant as AgentReasoningEffort } : {}), prompt: draft.prompt } });
      if (result.ok) {
        recordAcceptedGeneration(scope, "image-director", generationIdentity(connection.connectionId, model.id));
        rememberAssistantPreference(scope, { sourceId: connection.adapterId, connectionId: connection.connectionId, model: model.id, reasoningEffort: draft.variant as AgentReasoningEffort | "" });
        if (live.current) {
          const directorId = result.value.turn.target.nodeId;
          if (directorId) selectionIntent.current?.accept(directorId);
          else selectionIntent.current?.cancel();
          selectionIntent.current = null;
          drafts.delete(key); onClose();
        }
      } else if (live.current) setError(result.error);
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : "创建未完成"); }
    finally { selectionIntent.current?.cancel(); selectionIntent.current = null; submitting.current = false; if (live.current) setBusy(false); }
  };
  const refresh = () => directory?.load(true);
  const start = <Button tone="primary" loading={busy} disabled={selectionInvalid || !draft.prompt.trim()} onClick={() => void submit()}>生成</Button>;
  return <div className="image-director-panel" style={{ display: visible ? undefined : "none" }}>
    <Dialog.Content ariaLabel="生成模型与导演区" size="md" onOverlayClick={onClose}>
    <Dialog.Header onClose={onClose}><Dialog.Title>生成模型与导演区</Dialog.Title></Dialog.Header>
    <Dialog.Body className="image-director-body">
    <div className="image-director-source">
      {thumbnail ? <img src={thumbnail} alt="" /> : <span><ImageIcon /></span>}
      <span>{asset?.title || "图片素材"}</span>
    </div>
    <div className="image-director-settings">
    <AssistantComposer className="image-director-prompt" rows={6} disabled={busy} value={draft.prompt} placeholder="描述希望生成的场景，或修改默认提示词。" onChange={prompt => update({ prompt })} onSubmit={() => void submit()} />
    <AssistantToolbar disabled={busy} refreshing={refreshing} onRefresh={() => void refresh()} onManage={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: { canvasId } })} submit={start}
      assistant={service ? <AssistantConfiguration service={service} purpose="image-director" connectionId={draft.connectionId} model={draft.model} open={open === "connection"} onOpenChange={value => setOpen(value ? "connection" : null)} disabled={busy}
        reasonFor={(c, id) => { const capability = c.models?.find(m => m.id === id)?.capabilities?.textDelivery ?? c.capabilities.textDelivery; return !c.capabilities.tools || !c.capabilities.targets?.includes("world") ? "此连接不支持场景创作" : !capability?.imageInput ? "此模型不支持参考图片" : undefined; }}
        onSelect={(c, id) => {
          const variant = c.connectionId === draft.connectionId && id === draft.model ? draft.variant : draft.efforts?.[generationIdentity(c.connectionId, id)] ?? "";
          const options = agentDirectoryModels(c.models, directoryView?.catalogs[c.adapterId]?.models).find(m => m.id === id)?.reasoningEfforts ?? [];
          setError(draft.variant && !variant && !options.includes(draft.variant as AgentReasoningEffort) ? "新模型不支持原思考强度，已恢复默认" : null);
          update({ connectionId: c.connectionId, model: id, variant });
        }} /> : null}
      parameters={<ReasoningParameters value={draft.variant} options={model?.reasoningEfforts ?? []} open={open === "model"} onOpenChange={value => setOpen(value ? "model" : null)} disabled={busy} onChange={value => update({ variant: value })} />}

    />
    <p className="image-director-hint">Enter 生成，Shift+Enter 换行</p>
    </div>
    {error && <div className="image-director-status">{error}</div>}
    {draft.connectionId && selectionInvalid && <div className="image-director-status">所选助手或模型已不可用，请重新选择。</div>}
    </Dialog.Body>
    </Dialog.Content>
  </div>;
}

export function imageDirectorSceneExtension(options: { canvasId?: string } = {}): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    let target: { canvasId: string; nodeId: string } | null = null;
    let cancelSelection = () => {};
    const beginSelection = () => {
      cancelSelection();
      const intent = beginDirectorSceneSelection(ctx, target!.canvasId);
      cancelSelection = intent.cancel;
      return intent;
    };
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach(listener => listener());
    const openTarget = (nodeId: string) => { const canvas = workingCanvasOf(woohaa3CanvasStore.getState()); if (!canvas || (options.canvasId && canvas.id !== options.canvasId) || !ctx.canvasSession.isWritable() || !imageReady(nodeId)) return; cancelSelection(); target = { canvasId: canvas.id, nodeId }; notify(); };
    function Overlay() {
      const [current, setCurrent] = useState(target);
      const conversation = ctx.get("agentConversationService" as never) as AgentConversationServiceHandle | undefined;
      useSyncExternalStore(conversation?.subscribe ?? (() => () => {}), conversation?.getSnapshot ?? (() => null), conversation?.getSnapshot ?? (() => null));
      const scope = conversation?.getDataScopeId?.() ?? "page";
      useEffect(() => { const listener = () => setCurrent(target); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
      return <>{current && <ImageDirectorPanel key={`${scope}:${current.canvasId}:${current.nodeId}`} ctx={ctx} {...current} visible beginSelection={beginSelection} onClose={() => { target = null; notify(); }} />}</>;
    }
    function FocusAction({ nodeId }: { nodeId: string }) { return imageReady(nodeId) ? <button type="button" title="生成模型与导演区" onClick={() => openTarget(nodeId)}><SparklesIcon /></button> : null; }
    const removeAction = ctx.slots.register("canvas.node-action", { id: IMAGE_DIRECTOR_PLUGIN_ID, owner: IMAGE_DIRECTOR_PLUGIN_ID, order: 20, describe: ({ nodeId, writable }) => imageReady(nodeId) ? { label: "转 3D", icon: "box", enabled: writable } : null, activate: ({ nodeId }) => openTarget(nodeId) });
    const removeMenu = ctx.slots.register("canvas.context-menu", { id: IMAGE_DIRECTOR_PLUGIN_ID, owner: IMAGE_DIRECTOR_PLUGIN_ID, items: ({ nodeId, writable }) => nodeId && imageReady(nodeId) ? [{ id: IMAGE_DIRECTOR_PLUGIN_ID, label: "生成模型与导演区", disabled: !writable }] : [], onSelect: (itemId, context) => { if (itemId === IMAGE_DIRECTOR_PLUGIN_ID && context.nodeId) openTarget(context.nodeId); } });
    const removeFocus = ctx.slots.register("canvas.focus-header", { id: IMAGE_DIRECTOR_PLUGIN_ID, owner: IMAGE_DIRECTOR_PLUGIN_ID, render: FocusAction });
    const removeOverlay = ctx.slots.register("canvas.overlay", { id: IMAGE_DIRECTOR_PLUGIN_ID, owner: IMAGE_DIRECTOR_PLUGIN_ID, priority: 30, render: () => <Overlay /> });
    ctx.effect(() => () => { cancelSelection(); removeAction(); removeMenu(); removeFocus(); removeOverlay(); }, IMAGE_DIRECTOR_PLUGIN_ID);
  }, { name: IMAGE_DIRECTOR_PLUGIN_ID, inject: ["slots", "canvasSession", "canvasNavigation", "canvasRuntime", "canvasEdit", "canvasLocate", "applicationRemote"] });
}
