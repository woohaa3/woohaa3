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
import { NodeTypeSwitch, type SwitchableNodeType } from "./node-type-switch.js";
import { buildLinkedNodeCommands, planNodeTypeSwitch } from "./switch-node-type.js";
import { requestDockExpand } from "./dock-expand-request.js";
import "./node-type-switch.css";
import { planRetypeNode } from "../../../extension-api/command-planner.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { ExecutionPanelShell } from "../../ui/index.js";
import { ExecutionPanelSurface, resolveExecutionPanelSurface } from "./execution-panel-surface.js";
import { Button } from "@woohaa3/ui";
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
import { useCanvasStoreState, useNodeDraft, useTaskCatalog } from "./use-task-state.js";
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
import { createModelDraftStore } from "./model-draft.js";
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
  removeReference
} from "./model-execution-host-helpers.js";
import type { ModelReferenceItem, ModelSubmitOutcome } from "../../contract/model-interaction.js";
import type { ModelExecutionHostProps } from "./node-execution-panel-types.js";
import type { ExecutionOrigin } from "./execution-launch.js";
import { PromptLibraryPanel } from "./prompt-library/prompt-library-panel.js";
export type { ModelExecutionHostProps } from "./node-execution-panel-types.js";

const defaultDraftStore = createModelDraftStore();

function executionButtonOrigin(button: HTMLButtonElement | null): ExecutionOrigin | undefined {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const style = button.ownerDocument.defaultView!.getComputedStyle(button);
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
  return {
    x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, token: crypto.randomUUID(),
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

  // 每个节点的模型选择（session-only）；节点无记录时回落到规范值/目录默认。
  const selectionSnapshot = useSyncExternalStore(
    draftStore.subscribe,
    useCallback(() => (context ? draftStore.getSelection(context.nodeId) ?? "" : ""), [context, draftStore])
  );

  const targetModelKey = useMemo(() => {
    if (!context || !panelKind) return "";
    const fromSelection = selectionSnapshot !== "" && typedModels.some((m) => m.modelKey === selectionSnapshot)
      ? selectionSnapshot
      : undefined;
    if (fromSelection) return fromSelection;
    return resolveSelectedModelKey({
      nodeData: context.nodeData,
      draftParameters: undefined,
      models: typedModels,
      defaultModelKey: modelConfig?.defaultModel ?? typedModels[0]?.modelKey ?? ""
    });
  }, [context, panelKind, selectionSnapshot, typedModels, modelConfig]);

  const draft = useNodeDraft(context?.nodeId ?? null, targetModelKey);
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
      canvas,
      panelParameters: parameters
    });
  }, [panelKind, context, disabledReason, pendingSelection, catalog, catalogState, targetModelKey, canvas, parameters]);

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
  const executionMessage = submitError;

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
  const patchDraft = useCallback(
    (patch: { prompt?: string; parameters?: Record<string, unknown> }) => {
      if (!context) return;
      const nextModel = patch.parameters?.model;
      if (
        typeof nextModel === "string" &&
        nextModel !== "" &&
        nextModel !== targetModelKey &&
        typedModels.some((entry) => entry.modelKey === nextModel)
      ) {
        // 模型切换：按目标 Plugin 分区写草稿，避免污染当前 modelKey 的参数。
        draftStore.patch(context.nodeId, nextModel, {
          prompt: patch.prompt ?? derivePanelDraft(context.nodeData, draft).prompt,
          ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
        });
        draftStore.setSelection(context.nodeId, nextModel);
        return;
      }
      // 参数手势：把连续变更合并为一次可撤销的本地条目（任务 1.6）。
      if (patch.parameters !== undefined && props.onParameterGesture
        && applyParameterDraft({
          draftStore,
          nodeId: context.nodeId,
          modelKey: targetModelKey,
          values: patch.parameters,
          onGesture: props.onParameterGesture
        })) {
        return;
      }
      draftStore.patch(context.nodeId, targetModelKey, {
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
      });
    },
    [context, draft, draftStore, targetModelKey, typedModels, props]
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
      draftStore.persist(nodeId, targetModelKey, { prompt: input.prompt, parameters: input.parameters });
      setSubmitError(null);

      const reasons = resolveBlockingReasons({
        panelKind,
        nodeId,
        disabledReason,
        pendingSelection,
        catalog,
        catalogState,
        model: targetModelKey,
        canvas,
        panelParameters: input.parameters
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
        parameters: input.parameters,
        catalog,
        expectedModelType: modelTypeForPanelKind(panelKind),
        ...(worldCapture ? { worldCapture } : {})
      });
      if (!outcome.ok) {
        // Page/panel disposal or scope change: do not paint stale failure feedback.
        if (!mounted.current || outcome.code === "stale-scope") {
          return { ok: false, error: outcome.error };
        }
        draftStore.patch(nodeId, targetModelKey, { prompt: input.prompt });
        if (outcome.error === EMPTY_UPSTREAM_TEXT_MESSAGE) showEmptyUpstreamAlert();
        else setSubmitError(outcome.error);
        return { ok: false, error: outcome.error };
      }
      return { ok: true, runId: outcome.runId, jobId: outcome.jobId };
    },
    [catalog, canvas, catalogState, context, disabledReason, draftStore, panelKind, pendingSelection, showEmptyUpstreamAlert, submitCoordinator, targetModelKey, worldCapture]
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
      disabled={pendingSelection}
      pickerOpen={pickerOpen}
      onPickerOpenChange={setPickerOpen}
      onConnect={(sourceNodeId) => addReference(session, context.nodeId, sourceNodeId)}
      onDisconnect={(item) => removeReference(session, canvas, context.nodeId, item.sourceNodeId)}
    />
  );

  // 「图片 / 视频」切换：只给图片/视频节点；一条权威命令改节点类型，成功后节点类型变了、面板换成另一类模型。
  const switchableType: SwitchableNodeType | null = context.nodeType === "image" || context.nodeType === "video" ? context.nodeType : null;
  const typeSwitchSlot = switchableType ? (
    <NodeTypeSwitch
      current={switchableType}
      plan={planNodeTypeSwitch(context.nodeData, writable && !pendingSelection)}
      onSwitch={(next) => {
        const plan = planNodeTypeSwitch(context.nodeData, writable && !pendingSelection);
        if (plan.kind === "blocked") return;
        if (plan.kind === "retype") {
          // 空节点：原地改类型（权威命令）；成功后清掉本地模型选择，面板回到新类型的默认模型。
          const result = session.submitCommands(planRetypeNode(context.nodeId, next), `web-retype-${Date.now().toString(36)}`);
          if (!result.ok) setSubmitError(result.reason ?? "切换类型失败");
          else draftStore.setSelection(context.nodeId, "");
          return;
        }
        // 已有结果：在旁边新建另一种类型的节点，当前内容作为它的参考；原节点不动。
        const linked = buildLinkedNodeCommands({
          sourceNodeId: context.nodeId,
          nextType: next,
          nodes: (canvas?.document.nodes ?? []) as never,
          nodeData: workingCanvas?.nodeData as never
        });
        if (!linked) { setSubmitError("无法新建关联节点"); return; }
        const result = session.submitCommands(linked.commands, `web-switch-${Date.now().toString(36)}`);
        if (!result.ok) { setSubmitError(result.reason ?? "新建关联节点失败"); return; }
        setSubmitError(null);
        // 等服务端确认再选中：命令刚提交时新节点只存在于本地预测里，此刻选中它，面板会去读一个
        // 规范画布里还没有的节点，闪一下报错；被服务端拒绝时则要把原因说出来，而不是让节点凭空消失。
        void result.handle.settled.then((settled) => {
          if (settled.state === "rejected") {
            setSubmitError(settled.error ?? "新建关联节点被拒绝");
            return;
          }
          // 新节点的底边栏默认收成一条：先发展开请求，再选中让它挂载。
          requestDockExpand(linked.nodeId);
          runtime?.controller()?.selectNode(linked.nodeId);
        });
      }}
    />
  ) : null;

  const taskState = derivePanelTaskState(context.nodeData);
  const status = taskState.taskStatus;
  // Task activity belongs to the dots. This surface always accepts another independent run.
  // Agent turns and aggregate/local operations retain their own execution gates.
  const effectiveStatus = status === "pending" || status === "processing" ? "idle" : status;
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
      {diagnostic ? (
        <ModelInteractionDiagnosticView diagnostic={diagnostic} />
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
              references: () => referencesSlot,
              ...(typeSwitchSlot ? { typeSwitch: () => typeSwitchSlot } : {}),
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
              // 提示词库：一条本地+远端的只读词库，选中后由面板并进草稿。
              promptLibrary: ({ onUse }) => <PromptLibraryPanel onUse={onUse} />,
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
    <ExecutionPanelSurface nodeId={context.nodeId} presentation={expanded ? "expanded" : "compact"} runtime={runtime} collapsible>
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
