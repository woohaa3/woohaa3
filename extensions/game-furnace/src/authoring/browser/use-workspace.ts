import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ServerCanvas, CanvasCommand } from "@woohaa3/contracts";
import { createHighEntropyId } from "@woohaa3/contracts";
import { createGameFurnaceState, validateGameFurnaceState, projectIdFor, type GameFurnaceState } from "../../state/shared/index.js";
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { remoteFailureMessage } from "../../state/browser/remote-port.js";
import { gameFurnaceAssociationPatch, readGameFurnaceAssociation, isGameFurnaceNode } from "../../state/browser/associations.js";
import { planSaveState, workspaceView, type RequirementsDraft } from "../../state/browser/workspace-session.js";
import { reportGameFurnace } from "./feedback.js";
import { createWorkspaceGuard, type WorkspaceToken } from "../../state/browser/workspace-guard.js";
import { languageModelSelection, modelInputCapabilities } from "./model-selection.js";
import type { GameFurnaceCollectResult } from "./file-import.js";
import { clearResourceDraft, dirtyResourceIds, planResourceUpdate, resourceConflicts, type ResourceDraft } from "../../state/browser/resource-draft.js";
import type { GameFurnaceWorkspaceProps } from "../../state/browser/workspace-props.js";
import type { GameFurnaceRemote } from "../../state/browser/remote-port.js";
import type { WorkspacePreviewOptions, GameFurnacePreviewController } from "../../state/browser/preview-port.js";

export function useGameFurnaceAuthoring(props: WorkspaceAuthoringProps) {
  const { writable, nodeId, canvasState, commands, mediaRemote } = props;
  const client = props.client;
  const [state, setState] = useState<Woohaa3CanvasJsonObject | null>(null);
  const [draft, setDraft] = useState<RequirementsDraft>({});
  const [resourceDraft, setResourceDraft] = useState<ResourceDraft>({});
  const [busy, setBusy] = useState<null | "open" | "save" | "generate" | "finalize" | "cancel" | "activate" | "collect">(null);
  const [taskPhase, setTaskPhase] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savedInputHash, setSavedInputHash] = useState<string | null>(null);
  const openGeneration = useRef(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const lastWrittenAssociation = useRef<string | null>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const guard = useMemo(() => createWorkspaceGuard(() => {
    const latest = currentProps.current;
    return {
      canvas: latest.canvasState.getWorkingCanvas() ?? latest.canvasState.getCanvas(),
      nodeId: latest.nodeId,
      writable: latest.writable && latest.commands.isWritable()
    };
  }), [canvasState]);
  // Observe transitions even when React batches delete/recreate or scope-away/return renders.
  useEffect(() => canvasState.subscribe(() => guard.refresh()), [canvasState, guard]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const catalog = useSyncExternalStore(props.taskCatalog.subscribe.bind(props.taskCatalog), props.taskCatalog.getState.bind(props.taskCatalog));
  useEffect(() => { void props.taskCatalog.load(); }, [props.taskCatalog]);
  const subscribeCanvas = useCallback((notify: () => void) => canvasState.subscribe(notify), [canvasState]);
  const readCanvas = useCallback(() => canvasState.getWorkingCanvas() ?? canvasState.getCanvas(), [canvasState]);
  const currentCanvas = useSyncExternalStore(subscribeCanvas, readCanvas);

  /** 读取当前节点关联（working 投影优先）。 */
  const canvas = useCallback((): ServerCanvas | null => canvasState.getWorkingCanvas() ?? canvasState.getCanvas(), [canvasState]);
  const association = useMemo(() => {
    const current = canvas();
    const data = nodeId ? current?.nodeData[nodeId] : undefined;
    return readGameFurnaceAssociation(data);
  }, [canvas, nodeId, currentCanvas]);

  const isCurrent = useCallback((token: WorkspaceToken, write = true, definition = true) =>
    mounted.current && guard.current(token, write, definition), [guard]);
  const scopeEpoch = guard.epoch();
  const releaseRequest = useCallback((target: WorkspaceToken) => {
    if (!isCurrent(target, false, false)) return;
    operation.current = false;
    setBusy(null);
  }, [isCurrent]);

  const settleAssociation = useCallback(async (handle: { settled: Promise<{ state: string; error: string | null }> }, token: WorkspaceToken) => {
    let receipt: { state: string; error: string | null } | null = null;
    try { receipt = await handle.settled; } catch { /* A rejected receipt leaves the immutable project recoverable. */ }
    if (!isCurrent(token, true, false)) return false;
    if (!receipt || receipt.state !== "committed" || receipt.error) {
      lastWrittenAssociation.current = null;
      setMessage("项目已保存，但关联未写回，请重试");
      return false;
    }
    return true;
  }, [isCurrent]);

  const stillCurrent = useCallback((canvasId: string, targetNodeId: string, write = false) => {
    const latest = currentProps.current;
    const current = latest.canvasState.getWorkingCanvas() ?? latest.canvasState.getCanvas();
    return mounted.current && latest.nodeId === targetNodeId && current?.id === canvasId
      && isGameFurnaceNode(current, targetNodeId)
      && (!write || (latest.writable && latest.commands.isWritable()));
  }, []);

  // 任务 6.10：目标节点删除的取消/脱离由 **Canvas scope** 观察器负责（`frontend/target-watcher.ts`，
  // 装配于 `plugin.tsx`）：它跨节点持续有效，覆盖「普通画布上删除未被聚焦的炼丹炉节点」以及聚焦
  // 工作区被 reconcile 先卸载的竞态；画布切换/首次加载/临时 null 不误报。此处不再重复观察，避免
  // 同一 canvas+node 发出两次请求。

  // 任务 8.5/8.6/8.7：试玩编排（开始/失败/停止/受校验消息桥/会话回收）集中在 hook 内。
  const capturePreviewValidity = useCallback(() => {
    const target = guard.capture();
    return () => !!target && mounted.current && guard.current(target, false);
  }, [guard]);
  const preview = props.usePreview({ client, canvas, nodeId, canvasId: currentCanvas?.id, stillCurrent, captureValidity: capturePreviewValidity });

  // 任务 5.9/8.7：模态 Dialog 打开时停止试玩并释放 capture（宿主派生的通用 `modalActive`）。
  // 关闭模态**不**自动重启：只在 false→true 边沿停止，绝不反向调用 `play`。
  useEffect(() => {
    if (props.modalActive) preview.stop();
  }, [props.modalActive, preview.stop]);

  useEffect(() => {
    // 任务 8.7：切换节点/画布时清理局部草稿与阶段（预览会话由 useGameFurnacePreview 释放）。
    setDraft({});
    setResourceDraft({});
    setMessage(null);
    setTaskPhase(null);
    operation.current = false;
    setBusy(null);
    setState(null);
    setSavedInputHash(null);
    lastWrittenAssociation.current = null;
  }, [nodeId, currentCanvas?.id, scopeEpoch]);

  // 打开项目：按节点稳定关联拉取内容寻址状态；缺失视为未初始化（空项目视图）。
  useEffect(() => {
    if (!nodeId) return;
    const current = canvas();
    if (!current) return;
    const associationNow = readGameFurnaceAssociation(current.nodeData[nodeId]);
    if (`${current.id}\0${nodeId}\0${associationNow.projectStorageKey}` === lastWrittenAssociation.current) return;
    if (!associationNow.projectStorageKey) {
      setState(createGameFurnaceState(projectIdFor(current.id, nodeId)));
      setSavedInputHash(null);
      setBusy(null);
      return;
    }
    const target = guard.capture();
    if (!target) return;
    const token = ++openGeneration.current;
    setState(null);
    setBusy("open");
    void (async () => {
      const result = await client.openProject({ canvasId: current.id, nodeId, projectStorageKey: associationNow.projectStorageKey! });
      if (token !== openGeneration.current || !isCurrent(target, false)) return;
      setBusy(null);
      if (!result.ok) {
        setMessage(`打开项目失败：${remoteFailureMessage(result)}`);
        return;
      }
      const latestCanvas = canvas();
      const latestAssociation = latestCanvas ? readGameFurnaceAssociation(latestCanvas.nodeData[nodeId]) : {};
      if (latestAssociation.projectStorageKey !== associationNow.projectStorageKey
        && latestAssociation.projectStorageKey !== result.value.projectStorageKey) {
        return;
      }
      if (result.value.projectStorageKey !== associationNow.projectStorageKey
        && latestCanvas?.id === current.id && stillCurrent(current.id, nodeId, true)
        && latestAssociation.projectStorageKey === associationNow.projectStorageKey) {
        const value = gameFurnaceAssociationPatch(latestCanvas.nodeData[nodeId], {
          projectStorageKey: result.value.projectStorageKey,
          inputHash: result.value.inputHash,
          activeBuildId: result.value.state.activeBuildId ?? null
        });
        const submitted = commands.submit(
          [{ type: "nodeData.patch", nodeId, value: value as never }],
          `game-furnace-open-recovery:${current.id}:${nodeId}:${createHighEntropyId("open-recovery")}`
        );
        if (submitted.ok) lastWrittenAssociation.current = `${current.id}\0${nodeId}\0${result.value.projectStorageKey}`;
        else setMessage("项目恢复完成，但画布关联未同步，请重试");
      }
      setState(result.value.state as unknown as Woohaa3CanvasJsonObject);
      setSavedInputHash(result.value.inputHash);
      if (result.value.projectStorageKey === associationNow.projectStorageKey || latestAssociation.projectStorageKey === result.value.projectStorageKey) setMessage(null);
    })();
    return () => { openGeneration.current += 1; };
  }, [client, canvas, nodeId, currentCanvas?.id, association.projectStorageKey, scopeEpoch, guard, isCurrent]);

  const view = useMemo(() => workspaceView({ state, draft, saved: savedInputHash !== null }), [state, draft, savedInputHash]);
  const dirtyResources = useMemo(() => dirtyResourceIds(view.resources, resourceDraft), [view.resources, resourceDraft]);
  const resourceConflictList = useMemo(() => resourceConflicts(view.resources, resourceDraft), [view.resources, resourceDraft]);

  const selectedModel = languageModelSelection(catalog, view.requirements.modelKey);
  const selectedInputCapabilities = useMemo(() => modelInputCapabilities(catalog, selectedModel.modelKey), [catalog, selectedModel.modelKey]);
  const requirements = { ...view.requirements, ...(selectedModel.modelKey ? { modelKey: selectedModel.modelKey } : {}) };
  const editable = writable && busy === null;

  const syncProject = useCallback(async (body: Record<string, unknown>, target: WorkspaceToken) => {
    const { canvasId, nodeId: targetNodeId } = target;
    const project = body.project as { state?: GameFurnaceState; projectStorageKey?: string; inputHash?: string } | undefined;
    if (!project?.state || typeof project.projectStorageKey !== "string" || typeof project.inputHash !== "string") return;
    try { validateGameFurnaceState(project.state); } catch { setMessage("项目响应无法识别"); return; }
    if (!isCurrent(target)) return false;
    const latest = canvas()!;
    const value = gameFurnaceAssociationPatch(latest.nodeData[targetNodeId], {
      projectStorageKey: project.projectStorageKey, inputHash: project.inputHash,
      activeBuildId: project.state.activeBuildId ?? null
    });
    const submitted = commands.submit([{ type: "nodeData.patch", nodeId: targetNodeId, value: value as never }], `game-furnace-sync:${canvasId}:${targetNodeId}:${createHighEntropyId("sync")}`);
    if (!submitted.ok) { setMessage("项目已更新，但画布关联未写回，请重试"); return; }
    lastWrittenAssociation.current = `${canvasId}\0${targetNodeId}\0${project.projectStorageKey}`;
    if (!await settleAssociation(submitted.handle, target)) return false;
    setState(project.state);
    setSavedInputHash(project.inputHash);
    return true;
  }, [canvas, commands, isCurrent, settleAssociation]);

  const save = useCallback(async (): Promise<string | null> => {
    const current = canvas();
    if (!current || !nodeId || operation.current) return null;
    const target = guard.capture(true, true);
    if (!target) return null;
    const next = planSaveState(state, requirements);
    if (!next) return null;
    operation.current = true;
    setBusy("save");
    const result = await client.saveProject({ canvasId: current.id, nodeId, state: next as unknown as GameFurnaceState });
    if (!isCurrent(target, true, false)) { releaseRequest(target); return null; }
    if (!isCurrent(target)) {
      operation.current = false;
      setBusy(null);
      setMessage("项目已保存，但目标定义或项目关联已改变，关联未写回");
      return null;
    }
    if (!result.ok) {
      setBusy(null);
      operation.current = false;
      setMessage(`保存失败：${remoteFailureMessage(result)}`);
      return null;
    }
    // 关联写回（保留通用字段）。
    const latest = canvas()!;
    const value = gameFurnaceAssociationPatch(latest.nodeData[nodeId], { projectStorageKey: result.value.projectStorageKey, inputHash: result.value.inputHash });
    const submitted = commands.submit([{ type: "nodeData.patch", nodeId, value: value as never }], `game-furnace-save:${current.id}:${nodeId}:${createHighEntropyId("save")}`);
    if (!submitted.ok) { operation.current = false; setBusy(null); setMessage("项目已保存，但画布关联未写回，请重试"); return null; }
    lastWrittenAssociation.current = `${current.id}\0${nodeId}\0${result.value.projectStorageKey}`;
    const committed = await settleAssociation(submitted.handle, target);
    if (!isCurrent(target, true, false)) { releaseRequest(target); return null; }
    operation.current = false;
    setBusy(null);
    if (!committed) return null;
    setState(result.value.state ?? next);
    setDraft({});
    setSavedInputHash(result.value.inputHash);
    setMessage("已保存");
    reportGameFurnace(null);
    return result.value.inputHash;
  }, [canvas, nodeId, state, requirements, client, commands, guard, isCurrent, settleAssociation, releaseRequest]);

  // 文件上传后的原子收集（任务 4.7/4.9）：上传成功才调用；失败如实反馈，不写假素材。
  const collect = useCallback(async (operations: readonly Woohaa3CanvasJsonObject[]): Promise<GameFurnaceCollectResult> => {
    const current = canvas();
    if (!current || !nodeId || !stillCurrent(current.id, nodeId, true)) return { ok: false, message: "画布已切换或只读" };
    setBusy("collect");
    // Uploaded asset registration belongs to the Canvas command batch, while the
    // extension reducer accepts only project operations. Publish both associations together.
    const assetCommands = operations.filter(operation => operation.type === "asset.upsert") as unknown as Extract<CanvasCommand, { type: "asset.upsert" }>[];
    const projectOperations = operations.filter(operation => operation.type !== "asset.upsert");
    const result = await client.collectResources({ canvasId: current.id, nodeId, operations: projectOperations as never, ...(association.projectStorageKey ? { expectedProjectStorageKey: association.projectStorageKey } : {}) });
    if (!stillCurrent(current.id, nodeId, true)) return { ok: false, message: "画布已切换，未关联素材" };
    setBusy(null);
    if (!result.ok) { setMessage(`添加文件失败：${remoteFailureMessage(result)}`); return { ok: false, message: remoteFailureMessage(result) }; }
    // 关联写回（保留通用字段）：与服务端收集返回的新 storageKey/inputHash 对齐。
    const latest = canvas()!;
    const value = { ...((latest.nodeData[nodeId] ?? {}) as Record<string, unknown>), projectStorageKey: result.value.projectStorageKey, inputHash: result.value.inputHash };
    const submitted = commands.submit([...assetCommands, { type: "nodeData.patch", nodeId, value: value as never }], `game-furnace-collect:${current.id}:${nodeId}:${createHighEntropyId("collect")}`);
    if (!submitted.ok) { setMessage("素材已收集，但画布关联未写回，请重试"); return { ok: false, message: "关联未写回" }; }
    lastWrittenAssociation.current = `${current.id}\0${nodeId}\0${result.value.projectStorageKey}`;
    // 重新读取权威项目状态（含新素材的确定性默认描述），保留需求草稿。
    const opened = await client.openProject({ canvasId: current.id, nodeId, projectStorageKey: result.value.projectStorageKey });
    if (stillCurrent(current.id, nodeId, true) && opened.ok) {
      setState(opened.value.state as unknown as Woohaa3CanvasJsonObject);
      setSavedInputHash(opened.value.inputHash);
    }
    setMessage("已添加文件素材");
    reportGameFurnace("已添加文件素材");
    return { ok: true };
  }, [canvas, nodeId, client, commands, stillCurrent, association.projectStorageKey]);

  // 提交一批 `resources.update`（任务 5.5）：只下发真正变化的字段，成功后重新打开权威状态并按 ID 清除已提交草稿。
  const saveResources = useCallback(async () => {
    const current = canvas();
    if (!current || !nodeId || !stillCurrent(current.id, nodeId, true)) return;
    const authoritative = (state as unknown as GameFurnaceState | null)?.resources ?? [];
    const planned = planResourceUpdate(authoritative, resourceDraft);
    if (!planned) return;
    if (planned.ok === false) {
      setMessage("素材在编辑期间已被更新，请放弃修改或刷新后再提交");
      return;
    }
    const operation = planned.operation;
    const submittedIds = operation.updates.map((update) => update.resourceId);
    setBusy("save");
    const result = await client.collectResources({ canvasId: current.id, nodeId, operations: [operation] as never, ...(association.projectStorageKey ? { expectedProjectStorageKey: association.projectStorageKey } : {}) });
    if (!stillCurrent(current.id, nodeId, true)) return;
    setBusy(null);
    if (!result.ok) { setMessage(`保存素材失败：${remoteFailureMessage(result)}`); return; }
    const latest = canvas()!;
    const value = { ...((latest.nodeData[nodeId] ?? {}) as Record<string, unknown>), projectStorageKey: result.value.projectStorageKey, inputHash: result.value.inputHash };
    const patch = commands.submit([{ type: "nodeData.patch", nodeId, value: value as never }], `game-furnace-resources:${current.id}:${nodeId}:${createHighEntropyId("resources")}`);
    if (!patch.ok) { setMessage("素材已保存，但画布关联未写回，请重试"); return; }
    lastWrittenAssociation.current = `${current.id}\0${nodeId}\0${result.value.projectStorageKey}`;
    const opened = await client.openProject({ canvasId: current.id, nodeId, projectStorageKey: result.value.projectStorageKey });
    if (stillCurrent(current.id, nodeId, true) && opened.ok) {
      setState(opened.value.state as unknown as Woohaa3CanvasJsonObject);
      setSavedInputHash(opened.value.inputHash);
      setResourceDraft((previous) => clearResourceDraft(previous, submittedIds));
    }
    setMessage("已保存素材名称与描述");
    reportGameFurnace("已保存素材名称与描述");
  }, [canvas, nodeId, state, resourceDraft, client, commands, stillCurrent, association.projectStorageKey]);

  const generate = useCallback(async () => {
    const current = canvas();
    if (!current || !nodeId || !selectedModel.executable) return;
    const origin = guard.capture(true);
    if (!origin) return;
    const hash = await save();
    if (!guard.lifetime(origin) || !mounted.current) return;
    if (!hash) return;
    const target = guard.capture(true, true);
    if (!target) return;
    setBusy("generate");
    const result = await client.generate({ canvasId: current.id, nodeId, expectedInputHash: hash, supportedInputs: selectedInputCapabilities });
    if (!stillCurrent(current.id, nodeId, true)) return;
    setBusy(null);
    if (!result.ok) {
      setBusy(null);
      setMessage(`启动生成失败：${remoteFailureMessage(result)}`);
      return;
    }
    const linked = await syncProject(result.value, target);
    releaseRequest(target);
    if (!linked) return;
    setTaskPhase(typeof result.value.state === "string" ? result.value.state : "unknown");
    setMessage("已提交生成，可在下方查看进度与候选版本");
  }, [canvas, nodeId, save, client, stillCurrent, selectedModel.executable, selectedInputCapabilities, syncProject]);

  const finalize = useCallback(async (generationId: string) => {
    const current = canvas();
    if (!current || !nodeId) return;
    const target = guard.capture(true, true);
    if (!target) return;
    setBusy("finalize");
    // 任务 6.8：finalize 是对已确认输入的结果校验+构建保存阶段，先显示「校验结果中」而非静默等待。
    setTaskPhase("validating");
    const result = await client.finalize({ canvasId: current.id, nodeId, generationId });
    if (!isCurrent(target)) { releaseRequest(target); return; }
    if (!result.ok) {
      setBusy(null);
      setMessage(`收尾失败：${remoteFailureMessage(result)}`);
      return;
    }
    const linked = await syncProject(result.value, target);
    releaseRequest(target);
    if (!linked) return;
    setTaskPhase(typeof result.value.state === "string" ? result.value.state : "unknown");
    setMessage(result.value.state === "succeeded" ? "构建已保存" : result.value.state === "failed" ? "任务失败，请检查模型配置和输入"
      : result.value.state === "cancelled" ? "任务已取消" : result.value.state === "unknown" ? "任务状态暂不可确认，请稍后重试" : "任务仍在处理中");
  }, [canvas, nodeId, client, guard, isCurrent, syncProject, releaseRequest]);

  const cancel = useCallback(async () => {
    const current = canvas();
    if (!current || !nodeId || !view.latestGenerationId) return;
    const target = guard.capture(true, true);
    if (!target) return;
    setBusy("cancel");
    const result = await client.cancel({ canvasId: current.id, nodeId, generationId: view.latestGenerationId });
    if (!isCurrent(target)) { releaseRequest(target); return; }
    if (!result.ok) { setBusy(null); setMessage(`取消失败：${remoteFailureMessage(result)}`); return; }
    const linked = await syncProject(result.value, target);
    releaseRequest(target);
    if (!linked) return;
    setTaskPhase("cancelled");
    setMessage("已取消本站等待；远端执行与费用可能继续");
  }, [canvas, nodeId, view.latestGenerationId, client, guard, isCurrent, syncProject, releaseRequest]);

  // 显式采用候选/历史构建：切换活动版本，随后销毁旧 iframe（重载同一不可变构建）。
  const activate = useCallback(async (buildId: string) => {
    const current = canvas();
    if (!current || !nodeId) return;
    const target = guard.capture(true, true);
    if (!target) return;
    setBusy("activate");
    const result = await client.activateBuild({ canvasId: current.id, nodeId, buildId });
    if (!isCurrent(target)) { releaseRequest(target); return; }
    if (!result.ok) { releaseRequest(target); setMessage(`采用版本失败：${remoteFailureMessage(result)}`); return; }
    // 切换后销毁旧试玩 iframe 与局部游戏状态；释放旧短期会话；不自动重新打开。
    preview.stop();
    const synced = await syncProject(result.value, target);
    releaseRequest(target);
    if (!synced || !isCurrent(target, true, false)) return;
    setMessage("已采用该版本为当前活动游戏");
  }, [canvas, nodeId, client, guard, isCurrent, releaseRequest, syncProject, preview]);

  return { props, nodeId, currentCanvas, preview, view, resourceDraft, dirtyResources, resourceConflictList, editable, busy, mediaRemote, setResourceDraft, saveResources, collect, selectedModel, writable, commands, setDraft, save, generate, cancel, finalize, activate, taskPhase, message };
}

type WorkspaceAuthoringProps = GameFurnaceWorkspaceProps & { client: GameFurnaceRemote; usePreview: (options: WorkspacePreviewOptions) => GameFurnacePreviewController };
