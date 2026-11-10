import { useOptionalService } from "../../react.js";
import { MediaConfiguration } from "../../ui/assistant-execution/media-configuration.js";
import { mediaDraftTarget, mediaDraftPartition, switchMediaParameters, mediaParameterEditingError, visibleMediaParameters } from "./configuration-draft.js";
import { recordAcceptedGeneration, generationIdentity } from "../../services/assistant-execution/recent.js";
/**
 * Model Execution Host
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1–4.3 / design D4 / D8）。
 *
 * 原 `NodeExecutionPanel` 收敛为 Host：核心只负责
 * - selection 与 working/canonical 投影；
 * - `{ nodeId, modelKey }` 草稿（model-draft）；
 * - catalog lookup 与 interaction descriptor 解析；
 * - 规范 references、task status、writable、presentation；
 * - 受控 submit facade（固定 nodeId/modelKey，重算 blocking，经既有 coordinator/Canvas/Task）；
 * - error boundary 与缺插件诊断。
 *
 * 具体模型 React UI 由 Registry 解析出的 `definition.Panel` 直接渲染；Host 不含
 * audio/video/`edit_video` 专用布局分支，也不按 providerId 选择组件。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { ExecutionPanelShell } from "../../ui/index.js";
import { ExecutionPanelSurface, resolveExecutionPanelSurface } from "./execution-panel-surface.js";
import { Button } from "@woohaa3/ui";
import { AssistantModelSelector } from "@woohaa3/ui/assistant";
import { randomId, resolveModelSubmissionParameters } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { createSubmitCoordinator } from "./submit-coordinator.js";
import { derivePanelDraft, derivePanelTaskState } from "./panel-state.js";
import { ModelParameterPanel } from "./model-parameter-panel.js";
import {
  EMPTY_UPSTREAM_TEXT_MESSAGE,
  upstreamTextIsEmpty
} from "./prompt-derivation.js";
import { modelTypeForPanelKind } from "./node-panel-registry.js";
import { resolveReferenceItems } from "./reference-items.js";
import { NodeExecutionReferences } from "./node-execution-references.js";
import { LazyMentionEditor as MentionEditor } from "./mention/lazy-mention-editor.js";
import { isMacPlatform } from "../canvas-shell/input/shortcuts.js";
import { buildSnippetTrigger } from "./node-execution-derivations.js";
import { applyParameterDraft } from "./parameter-draft.js";
import {
  planEscapeIntent,
  type PanelPresentationIntent
} from "./node-panel-directives.js";
import { useEscapeLayer } from "./execution-panel/panel-shared.js";
import { useCanvasStoreState, useNodeDraft, useNodeMediaPreparing, useTaskCatalog } from "./use-task-state.js";
import {
  allModelsForPanel,
  capabilityForModel,
  panelModelConfigForCatalog
} from "./catalog-projection.js";
import {
  computePickerCandidates,
  resolveBlockingReasons,
  resolveModelMcpServerUrl,
  resolveSelectedModelKey
} from "./node-panel-helpers.js";
import { resolveModelExecutionContext } from "./model-execution-context.js";
import { explicitWorldCaptureSelection } from "./capture-camera.js";
import { createModelDraftStore, migrateLegacyModelDraft } from "./model-draft.js";
import {
  ModelInteractionDiagnosticView,
  ModelPanelErrorBoundary,
  type ModelInteractionDiagnostic
} from "./model-execution-diagnostics.js";
import {
  addReference,
  canMentionReference,
  mentionTypeFor,
  placeholderModel,
  readPanelLocalSurface,
  changeReferences
} from "./model-execution-host-helpers.js";
import type { ModelReferenceItem, ModelSubmitOutcome } from "../../contract/model-interaction.js";
import type { ModelExecutionHostProps } from "./node-execution-panel-types.js";
import type { ExecutionOrigin } from "./execution-launch.js";
export type { ModelExecutionHostProps } from "./node-execution-panel-types.js";

const defaultDraftStore = createModelDraftStore();
const mediaSourceSelections = new Map<string, string>();

function executionButtonOrigin(button: HTMLButtonElement | null): ExecutionOrigin | undefined {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const style = button.ownerDocument.defaultView!.getComputedStyle(button);
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
  return {
    x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, token: randomId(),
    surface: { width: rect.width, height: rect.height,
      radius: style.borderTopLeftRadius.endsWith("%") ? Math.min(rect.width, rect.height) * radius / 100 : radius,
      color: style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent"
        ? "var(--app-interaction-accent)" : style.backgroundColor }
  };
}

export function ModelExecutionHost(rawProps: ModelExecutionHostProps) {
  const launchSurface = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const launchOrigin = useRef<ExecutionOrigin>();
  const captureLaunchOrigin = (event: SyntheticEvent<HTMLDivElement>) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (event.type === "click" && !button) return;
    const origin = executionButtonOrigin(button ?? event.currentTarget.querySelector<HTMLButtonElement>("[data-execution-launch]"));
    launchOrigin.current = origin;
    queueMicrotask(() => { if (launchOrigin.current === origin) launchOrigin.current = undefined; });
  };
  const props = rawProps;
  const agentService = useOptionalService("agentConversationService");
  const space = agentService?.getDataScopeId?.() ?? "page";
  const [sourceSelections, setSourceSelections] = useState<Record<string, string>>(() => Object.fromEntries(mediaSourceSelections));
  const [configurationNotice, setConfigurationNotice] = useState("");
  const [sourceError, setSourceError] = useState("");
  const {
    canvasId,
    selectedNodeId,
    session,
    runClient,
    writable,
    dialogs,
    catalog: catalogService,
    snippetSource,
    promptSkill,
    onPromptSkill,
    presentation = "compact",
    runtime,
    onPresentationIntent,
    activity,
    registry,
    panelActions,
    draftStore = defaultDraftStore
  } = props;

  const canvasState = useCanvasStoreState();
  const { state: catalogState, reload } = useTaskCatalog(catalogService);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<{ nodeId: string; message: string } | null>(null);
  const referenceWrite = useRef(0);
  const [recoveryModelOpen, setRecoveryModelOpen] = useState(false);
  useEffect(() => { setRecoveryModelOpen(false); }, [props.selectedNodeId]);
  /**
   * 模型 Panel 渲染失败：连同失败时的 `{nodeId, modelKey}` 作用域一起记录。
   *
   * 记录作用域让错误只影响该面板位置：用户切换节点/模型后旧错误自动失效，不需要额外 effect
   * 清理（change: fix-delete-node-crash-and-white-screen）。
   */
  const [renderError, setRenderError] = useState<{ scope: string; message: string } | null>(null);

  // 会话级只读：作为提交门禁与主操作禁用来源，但不在面板里重复展示文案
  // （同步状态气泡已承载断线/只读的具体原因）。文案不写「网络已断开」：只读也可能来自
  // 服务端关闭画布连接，具体来源由状态气泡区分
  // （change: 2026-10-21-recover-canvas-connection-explicitly）。
  const readOnly = !writable;
  const disabledReason = readOnly ? "画布当前只读，无法执行任务" : null;
  const canvas = canvasState.canvas;
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const workingCanvas = canvasState.working ?? canvas;

  const showEmptyUpstreamAlert = useCallback(() => {
    dialogs.open({
      dialogId: ALERT_DIALOG_ID,
      payload: {
        title: "上游文字为空",
        description: EMPTY_UPSTREAM_TEXT_MESSAGE,
        confirmLabel: "知道了",
        cancelLabel: "关闭"
      }
    });
  }, [dialogs]);

  const canonicalNodeIds = useMemo(
    () => new Set((canvas?.document.nodes ?? []).map((node) => node.id)),
    [canvas]
  );

  const context = useMemo(
    () => resolveModelExecutionContext(workingCanvas, selectedNodeId),
    [workingCanvas, selectedNodeId]
  );
  const pendingSelection = Boolean(context && !canonicalNodeIds.has(context.nodeId));
  // provider 已产出、正在转存稳定媒体：面板显示准备态，成功/下载入口保持禁用。
  const mediaPreparing = useNodeMediaPreparing(canvasId ?? "", context?.nodeId ?? "");

  const panelKind = context?.panelKind ?? null;
  const modelType = panelKind ? modelTypeForPanelKind(panelKind) : null;
  const typedModels = useMemo(
    () => (catalog && panelKind ? allModelsForPanel(catalog, panelKind) : []),
    [catalog, panelKind]
  );

  const modelConfig = useMemo(
    () => (catalog && panelKind ? panelModelConfigForCatalog(catalog, panelKind) : null),
    [catalog, panelKind]
  );

  // 未确认的本地选择优先；保存后读取规范字段，撤销/别页修改也由同一投影恢复。
  const selectionSnapshot = useSyncExternalStore(
    draftStore.subscribe,
    useCallback(() => (context ? draftStore.getSelection(mediaDraftTarget(space, canvasId, context.nodeId)) ?? "" : ""), [context, draftStore, space, canvasId])
  );

  const targetModelKey = useMemo(() => {
    if (!context || !panelKind) return "";
    const fromSelection = selectionSnapshot || undefined;
    if (fromSelection) return fromSelection;
    return resolveSelectedModelKey({
      nodeData: context.nodeData,
      draftParameters: undefined,
      models: typedModels,
      defaultModelKey: modelConfig?.defaultModel ?? ""
    });
  }, [context, panelKind, selectionSnapshot, typedModels, modelConfig]);
  useEffect(() => {
    if (context && selectionSnapshot && canvas?.nodeData[context.nodeId]?.preferredModelKey === selectionSnapshot) {
      draftStore.clearSelection(mediaDraftTarget(space, canvasId, context.nodeId));
    }
  }, [canvas, context, selectionSnapshot, draftStore, space, canvasId]);

  const draftNodeId = mediaDraftTarget(space, canvasId, context?.nodeId);
  const sourceId = sourceSelections[draftNodeId] ?? (typeof context?.nodeData.parameters?.serviceConnectionId === "string" ? context.nodeData.parameters.serviceConnectionId : "");
  const draftModelKey = mediaDraftPartition(targetModelKey, sourceId);
  const storedDraft = useNodeDraft(context ? draftNodeId : null, draftModelKey);

  useEffect(() => {
    if (context && !storedDraft && (context.nodeData.preferredModelKey === targetModelKey || context.nodeData.parameters?.model === targetModelKey)) {
      migrateLegacyModelDraft(draftStore, { nodeId: context.nodeId, modelKey: targetModelKey, sourceId, target: draftNodeId, partition: draftModelKey });
    }
  }, [context, storedDraft, targetModelKey, sourceId, draftNodeId, draftModelKey, draftStore]);
  const canonicalParameters = context?.nodeData.parameters;
  const matchingCanonical = !canonicalParameters?.model || canonicalParameters.model === targetModelKey;
  const draft = storedDraft ?? (context ? { prompt: typeof context.nodeData.prompt === "string" ? context.nodeData.prompt : "", parameters: matchingCanonical ? canonicalParameters ?? {} : {} } : undefined);

  const model = useMemo(
    () => typedModels.find((entry) => entry.modelKey === targetModelKey) ?? null,
    [typedModels, targetModelKey]
  );
  // T10: capture framing is explicit-only. The panel never scans the canvas for a
  // camera card, so an unrelated world camera cannot change an ordinary generation.
  // T09/T11b supply the production UI that passes `captureCameraId`.
  const worldCapture = useMemo(
    () => explicitWorldCaptureSelection(props.captureCameraId),
    [props.captureCameraId]
  );

  const definition = useMemo(
    () => (model ? registry.resolve(model.interaction) : null),
    [model, registry]
  );
  const parameters = useMemo<Record<string, unknown>>(() => {
    if (!context) return {};
    return derivePanelDraft(context.nodeData, draft).parameters;
  }, [context, draft]);
  const draftPrompt = useMemo(
    () => (context ? derivePanelDraft(context.nodeData, draft).prompt : ""),
    [context, draft]
  );

  const blockingReasons = useMemo(() => {
    if (!panelKind) return [];
    return resolveBlockingReasons({
      panelKind,
      nodeId: context!.nodeId,
      disabledReason,
      pendingSelection,
      catalog,
      catalogState,
      model: targetModelKey,
      modelDefinition: model,
      prompt: draftPrompt,
      canvas,
      panelParameters: parameters
    });
  }, [panelKind, context, disabledReason, pendingSelection, catalog, catalogState, targetModelKey, model, draftPrompt, canvas, parameters]);

  // 展示用阻止原因：会话只读（断线）时面板不重复枚举「网络已断开 / 目录尚未加载」这类
  // 会话级状态——左下角同步状态控件的常驻 tooltip 已经承载该信息。主操作仍由 `readOnly`
  // 真正禁用，提交门禁仍使用完整 `blockingReasons`。
  const displayBlockingReasons = readOnly ? [] : blockingReasons;

  const diagnostic = useMemo<ModelInteractionDiagnostic | null>(() => {
    if (!context || !panelKind) return null;
    // Catalog 尚未就绪（loading/error）：不是缺插件，交给 blocking reasons + 重试按钮。
    if (!catalog) return null;
    if (!targetModelKey) {
      // 目录里没有该类型的可用模型：这是目录内容问题（blocking reason 已解释），不是缺插件。
      if (typedModels.length === 0) return null;
      return { kind: "legacy-ambiguous", message: "无法解析当前节点的模型，请重新选择模型" };
    }
    if (!model) {
      return { kind: "catalog-offline", model: placeholderModel(targetModelKey, modelType!) };
    }
    return null;
  }, [catalog, context, model, panelKind, targetModelKey, modelType, typedModels]);

  const submitCoordinator = useMemo(
    () =>
      canvasId
        ? props.submitCoordinator ?? createSubmitCoordinator({
            store: woohaa3CanvasStore,
            client: runClient,
            ...(activity ? { activity } : {}),
            isCurrent: () => mounted.current
          })
        : null,
    [canvasId, runClient, activity, props.submitCoordinator]
  );
  const executionMessage = submitError ?? (referenceError?.nodeId === context?.nodeId ? referenceError?.message : null);

  const references = useMemo<ModelReferenceItem[]>(() => {
    if (!canvas || !context || !panelKind || !catalog || !targetModelKey) return [];
    const bindings = capabilityForModel(catalog, panelKind, targetModelKey)?.bindings ?? [];
    const projection = resolveReferenceItems({ canvas, nodeId: context.nodeId, bindings });
    return projection.items.map((item) => ({
      sourceNodeId: item.sourceNodeId,
      slotId: item.slotId,
      role: item.role,
      label: item.label,
      status: item.status === "waiting" ? "pending" : item.status === "invalid" ? "failed" : "ready",
      ...(item.mediaKind ? { mediaKind: item.mediaKind } : {}),
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {})
    }));
  }, [catalog, canvas, context, panelKind, targetModelKey]);

  const mentionCandidates = useMemo(
    () =>
      references
        .filter(canMentionReference)
        .map((item) => ({ slotId: item.slotId, type: mentionTypeFor(item), label: item.label })),
    [references]
  );
  const snippetTrigger = useMemo(
    () => (context ? buildSnippetTrigger(snippetSource, context.nodeId) : undefined),
    [snippetSource, context]
  );
  const saveModelSelection = useCallback((nodeId: string, modelKey: string,
    baseline = structuredClone(woohaa3CanvasStore.getState().canvas?.nodeData[nodeId] ?? null)) => {
    if (!props.editService) return;
    void props.editService.record(
      [{ type: "nodeData.patch", nodeId, value: { preferredModelKey: modelKey }, expectedNodeData: { [nodeId]: baseline } }], "选择模型"
    ).catch(() => {});
  }, [props.editService]);
  const patchDraft = useCallback(
    (patch: { prompt?: string; parameters?: Record<string, unknown> }) => {
      if (!context) return;
      const nextModel = patch.parameters?.model;
      const nextSource = typeof patch.parameters?.serviceConnectionId === "string" ? patch.parameters.serviceConnectionId : sourceId;
      if (typeof nextModel === "string" && nextModel && (nextModel !== targetModelKey || nextSource !== sourceId) && typedModels.some(e => e.modelKey === nextModel)) {
        const next = typedModels.find(e => e.modelKey === nextModel)!;
        const partition = mediaDraftPartition(nextModel, nextSource);
        const own = draftStore.get(draftNodeId, partition);
        const restored = switchMediaParameters(model, next, parameters, own.parameters);
        const values = restored.parameters;
        draftStore.patch(draftNodeId, partition, { prompt: patch.prompt ?? draftPrompt, parameters: { ...values, model: nextModel, serviceConnectionId: nextSource || undefined } });
        mediaSourceSelections.set(draftNodeId, nextSource);
        setSourceSelections(current => ({ ...current, [draftNodeId]: nextSource }));
        draftStore.setSelection(draftNodeId, nextModel);
        saveModelSelection(context.nodeId, nextModel);
        setConfigurationNotice(restored.resetLabels.length ? `已恢复默认：${restored.resetLabels.join("、")}` : "");
        return;
      }
      // 参数手势：把连续变更合并为一次可撤销的本地条目（任务 1.6）。
      if (patch.parameters !== undefined && props.onParameterGesture
        && applyParameterDraft({
          draftStore,
          nodeId: draftNodeId,
          modelKey: draftModelKey,
          values: patch.parameters,
          onGesture: input => props.onParameterGesture?.({ ...input, nodeId: context.nodeId })
        })) {
        return;
      }
      draftStore.patch(draftNodeId, draftModelKey, {
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
      });
    },
    [context, draft, draftStore, targetModelKey, typedModels, props, saveModelSelection, draftNodeId, draftModelKey, sourceId, model, parameters, draftPrompt]
  );

  /**
   * 快捷改写：扩展产出文本，Host 负责写回草稿（change: add-prompt-skill-extension）。
   *
   * 失败以异常抛给面板，由面板显示为就地错误；成功时不自动提交生成。
   */
  const runPromptSkill = useMemo(() => {
    if (!promptSkill || !context) return undefined;
    return async (input: { id: string; label: string; prompt: string }): Promise<void> => {
      const result = await promptSkill({
        skill: { id: input.id, label: input.label },
        prompt: input.prompt,
        canvasId: canvasId ?? "",
        nodeId: context.nodeId,
        taskKind: context.nodeType
      });
      if ("error" in result) throw new Error(result.error);
      const next = result.prompt.trim();
      if (next === "") throw new Error("改写结果为空，草稿未修改");
      patchDraft({ prompt: next });
    };
  }, [promptSkill, context, patchDraft, canvasId]);

  /** 扩展注入的改写优先；没有时保留外部直接接管的兼容回调。 */
  const panelPromptSkill = runPromptSkill ?? onPromptSkill;

  const handleSubmit = useCallback(
    async (input: { prompt: string; parameters: Record<string, unknown> }): Promise<ModelSubmitOutcome> => {
      if (!context || !panelKind || !catalog || !targetModelKey) {
        return { ok: false, error: "模型尚未就绪，任务未提交" };
      }
      const nodeId = context.nodeId;
      const editingError = sourceError || (model ? mediaParameterEditingError(model, input.parameters) : "模型已失效，请重新选择");
      if (editingError) { setSubmitError(editingError); return { ok: false, error: editingError }; }
      // schema 默认值必须进入提交快照（A9 / change: 2026-11-06-guard-video-generation-inputs）：
      // 面板显示的 720p / 5 秒不能只停在控件上，否则 Provider 仍会收到缺字段的请求。
      const resolvedParameters = resolveModelSubmissionParameters(
        {
          modelType: model?.modelType,
          inputSchema: model?.inputSchema,
          defaultInput: model?.defaultInput
        },
        model ? visibleMediaParameters(model, input.parameters) : input.parameters,
        { prompt: input.prompt, skipRequired: ["prompt"] }
      );
      draftStore.persist(draftNodeId, draftModelKey, { prompt: input.prompt, parameters: resolvedParameters });
      setSubmitError(null);

      const reasons = resolveBlockingReasons({
        panelKind,
        nodeId,
        disabledReason,
        pendingSelection,
        catalog,
        catalogState,
        model: targetModelKey,
        modelDefinition: model,
        prompt: input.prompt,
        canvas,
        panelParameters: resolvedParameters
      });
      if (reasons.length > 0) {
        setSubmitError(reasons[0]!);
        return { ok: false, error: reasons[0]! };
      }

      const modelDescriptor = catalog.models.find((entry) => entry.modelKey === targetModelKey);
      const promptRequirement = modelDescriptor?.promptRequirement ?? "required";
      if (
        promptRequirement === "required" &&
        input.prompt.trim().length === 0 &&
        upstreamTextIsEmpty(canvas, nodeId)
      ) {
        showEmptyUpstreamAlert();
        return { ok: false, error: EMPTY_UPSTREAM_TEXT_MESSAGE };
      }
      if (!submitCoordinator) {
        const error = "画布尚未连接到 Canvas Service，无法提交任务";
        setSubmitError(error);
        return { ok: false, error };
      }
      const outcome = await submitCoordinator.submit({
        origin: launchOrigin.current ?? executionButtonOrigin(launchSurface.current?.querySelector<HTMLButtonElement>("[data-execution-launch]") ?? null),
        nodeId,
        modelKey: targetModelKey,
        prompt: input.prompt,
        parameters: resolvedParameters,
        catalog,
        expectedModelType: modelTypeForPanelKind(panelKind),
        ...(worldCapture ? { worldCapture } : {})
      });
      if (!outcome.ok) {
        // Page/panel disposal or scope change: do not paint stale failure feedback.
        if (!mounted.current || outcome.code === "stale-scope") {
          return { ok: false, error: outcome.error };
        }
        draftStore.patch(draftNodeId, draftModelKey, { prompt: input.prompt });
        if (outcome.error === EMPTY_UPSTREAM_TEXT_MESSAGE) showEmptyUpstreamAlert();
        else setSubmitError(outcome.error);
        return { ok: false, error: outcome.error };
      }
      recordAcceptedGeneration(space, panelKind, generationIdentity(sourceId || model?.providerId || "", targetModelKey));
      return { ok: true, runId: outcome.runId, jobId: outcome.jobId };
    },
    [catalog, canvas, catalogState, context, disabledReason, draftStore, model, panelKind, pendingSelection, showEmptyUpstreamAlert, submitCoordinator, targetModelKey, worldCapture, space, sourceId, draftNodeId, draftModelKey, sourceError]
  );

  const submitIntent = useCallback(
    (intent: PanelPresentationIntent) => {
      if (intent.kind === "none") return;
      onPresentationIntent?.(intent);
    },
    [onPresentationIntent]
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 所有 hook 必须在 early return 之前调用：节点被删除后 `context` 变 `null`，早期返回会跳过
   * 本 hook，使 hook 数量在两次 render 之间变化，React 抛
   * 「Rendered fewer hooks than expected」并让整页白屏（回归：删除视频节点）。
   */
  useEscapeLayer(Boolean(context) && Boolean(onPresentationIntent), (event) => {
    if (!context) return false;
    void event;
    const intent = planEscapeIntent({
      type: "node-execution",
      presentation,
      localSurface: readPanelLocalSurface()
    });
    if (intent.kind === "none") return false;
    submitIntent(intent);
    return true;
  });

  if (!context) return null;

  if (!panelKind) {
    return (
      <ExecutionPanelSurface nodeId={context.nodeId} presentation="compact" runtime={runtime}>
        <ModelParameterPanel
          canvasId={canvasId}
          nodeId={context.nodeId}
          nodeType={context.nodeType}
          mcpServerUrl={resolveModelMcpServerUrl()}
          disabledReason={pendingSelection ? "节点仍在等待保存，暂不可编辑模型参数" : disabledReason}
        />
      </ExecutionPanelSurface>
    );
  }

  const editReferences = (items: readonly Pick<ModelReferenceItem, "slotId" | "sourceNodeId">[]) => {
    const write = ++referenceWrite.current;
    setReferenceError(null);
    return changeReferences(session, canvas, context.nodeId, items, undefined, message => {
      if (mounted.current && write === referenceWrite.current) setReferenceError({ nodeId: context.nodeId, message });
    });
  };
  const referenceBindings = catalog ? capabilityForModel(catalog, panelKind, targetModelKey)?.bindings ?? [] : [];
  const referencesSlot = (
    <NodeExecutionReferences
      items={
        canvas
          ? resolveReferenceItems({ canvas, nodeId: context.nodeId, bindings: referenceBindings }).items
          : []
      }
      candidates={computePickerCandidates(canvas, context.nodeId, { bindings: referenceBindings })}
      presentation={presentation}
      disabled={readOnly || pendingSelection}
      pickerOpen={pickerOpen}
      onPickerOpenChange={setPickerOpen}
      onConnect={(sourceNodeId) => addReference(session, context.nodeId, sourceNodeId)}
      onDisconnect={(item) => editReferences([item])}
    />
  );

  const taskState = derivePanelTaskState(context.nodeData);
  const status = taskState.taskStatus;
  // Task activity belongs to the dots. This surface always accepts another independent run.
  // Agent turns and aggregate/local operations retain their own execution gates.
  const effectiveStatus = mediaPreparing
    ? "materializing"
    : status === "pending" || status === "processing" ? "idle" : status;
  const expanded = resolveExecutionPanelSurface(presentation, context.nodeType) === "expanded";
  const binding = definition?.bindings
    ? definition.bindings({ nodeId: context.nodeId, modelKey: targetModelKey, canvas })
    : undefined;

  const body = (
    <div
      ref={launchSurface}
      onClickCapture={captureLaunchOrigin}
      onKeyDownCapture={event => { if (event.key === "Enter") captureLaunchOrigin(event); }}
      className="node-execution-dock__expanded-body"
      data-node-id={context.nodeId}
      data-presentation={expanded ? "expanded" : "compact"}
    >
      {configurationNotice || sourceError ? <p className="mc-panel__notice">{sourceError || configurationNotice}</p> : null}
      {diagnostic ? (
        <>
          <ModelInteractionDiagnosticView diagnostic={diagnostic} />
          {!readOnly && typedModels.length > 0 ? <AssistantModelSelector
            model={targetModelKey} options={typedModels.map(entry => ({ value: entry.modelKey, label: entry.title || entry.providerModelId, provider: entry.providerId }))}
            open={recoveryModelOpen} onOpenChange={setRecoveryModelOpen} disabled={pendingSelection}
            onChange={modelKey => patchDraft({ parameters: { model: modelKey } })}
          /> : null}
          {catalogState.status === "error" ? <Button size="sm" onClick={reload}>重新加载模型目录</Button> : null}
        </>
      ) : renderError !== null && model && renderError.scope === panelErrorScope(context.nodeId, targetModelKey) ? (
        <ModelInteractionDiagnosticView
          diagnostic={{ kind: "render-error", model, message: renderError.message }}
        />
      ) : definition && model ? (
        <ModelPanelErrorBoundary
          modelTitle={model.title}
          resetKey={panelErrorScope(context.nodeId, targetModelKey)}
          onError={(message) => setRenderError({ scope: panelErrorScope(context.nodeId, targetModelKey), message })}
        >
          <definition.Panel
            key={context.nodeId}
            nodeId={context.nodeId}
            model={model}
            catalogModels={typedModels}
            defaultModelKey={modelConfig?.defaultModel ?? model.modelKey}
            writable={writable && !pendingSelection}
            readOnly={readOnly}
            presentation={expanded ? "expanded" : "compact"}
            status={effectiveStatus}
            {...(taskState.progress !== undefined ? { progress: taskState.progress } : {})}
            {...(taskState.errorMessage !== undefined
              ? { errorMessage: taskState.errorMessage }
              : {})}
            draft={derivePanelDraft(context.nodeData, draft)}
            references={references}
            blockingReasons={displayBlockingReasons}
            {...(binding?.statusSummary ? { statusSummary: binding.statusSummary } : {})}
            patchDraft={patchDraft}
            submit={handleSubmit}
            requestPresentation={submitIntent}
            {...(binding?.actions || panelActions ? { actions: { ...binding?.actions, ...panelActions } } : {})}
            renderers={{
              modelSelector: () => <MediaConfiguration key={draftNodeId} models={typedModels} modelKey={targetModelKey} sourceId={sourceId} space={space} purpose={panelKind ?? "media"} service={agentService} disabled={readOnly || pendingSelection} onValidation={setSourceError} onManage={() => dialogs.open({ dialogId: "settings" })} onSelect={(key, source) => patchDraft({ parameters: { model: key, serviceConnectionId: source } })} />,
              references: () => referencesSlot,
              promptEditor: ({ value, onChange, disabled, placeholder, onSubmit }) => (
                <MentionEditor
                  value={value}
                  onChange={onChange}
                  onSubmit={onSubmit}
                  candidates={mentionCandidates}
                  disabled={disabled}
                  placeholder={placeholder}
                  ariaLabel="提示词"
                  isMac={isMacPlatform(typeof navigator !== "undefined" ? navigator : undefined)}
                  readOnly={readOnly}
                  blocked={displayBlockingReasons.length > 0}
                  {...(snippetTrigger ? { snippetTrigger } : {})}
                />
              ),
              ...(panelPromptSkill ? { promptSkill: panelPromptSkill } : {})
            }}
          />
        </ModelPanelErrorBoundary>
      ) : model ? (
        <ModelInteractionDiagnosticView diagnostic={{ kind: "missing-plugin", model }} />
      ) : readOnly ? null : (
        <ExecutionPanelShell ariaLabel="节点执行面板（目录不可用）" className="mc-panel--catalog-fallback">
          <div className="mc-panel__grid">
            {/* 空态只有这一行状态：用整列变体，别落进两列栅格右侧的控件列。 */}
            <div className="mc-panel__grid-item mc-panel__grid-item--untitled" style={{ gridColumn: "span 24" }} role="status">
              <span className="mc-panel__grid-control">
                {blockingReasons.length > 0 ? blockingReasons.join("；") : "任务目录尚未就绪"}
              </span>
            </div>
            {catalogState.status === "error" ? (
              <div className="mc-panel__grid-item mc-panel__grid-item--untitled" style={{ gridColumn: "span 24" }}>
                <span className="mc-panel__grid-control">
                  <Button size="sm" className="node-execution-dock__retry" onClick={reload}>
                    重新加载模型目录
                  </Button>
                </span>
              </div>
            ) : null}
          </div>
        </ExecutionPanelShell>
      )}
      {executionMessage ? (
        <p className="node-execution-dock__error" role="alert">
          {executionMessage}
        </p>
      ) : null}
    </div>
  );

  const wrapper = (
    <ExecutionPanelSurface nodeId={context.nodeId} presentation={expanded ? "expanded" : "compact"} runtime={runtime}>
      {body}
    </ExecutionPanelSurface>
  );
  return wrapper;
}

/**
 * 模型交互 Panel 失败态的作用域键（`{nodeId, modelKey}`）。
 *
 * 用它做 `ModelPanelErrorBoundary` 的 `resetKey` 与错误记录的比较键：切换节点或模型后，
 * 上一次的「渲染失败」既不阻塞新的 Panel，也不会被误显示在新模型上。
 */
function panelErrorScope(nodeId: string, modelKey: string): string {
  return `${nodeId}\u0000${modelKey}`;
}
