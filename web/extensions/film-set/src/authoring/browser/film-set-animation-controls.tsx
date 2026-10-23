/**
 * 片场「拍摄镜头」管理工作区
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 6.5 / design D8/D9）。
 *
 * 把原来的「动画片段」控件升级为拍摄镜头管理：静态/动态两类镜头各自的操作、显式类型转换与
 * 转换影响提示、空集合状态。所有写入仍走 `filmSet.clipPatch`（含字段 precondition），选择是
 * **本地** playback 状态，不写持久 `defaultClipId` 或 canonical 之外的任何数据。
 *
 * 机器协议沿用 `clip`（clipId/clipPatch），产品文案统一称「拍摄镜头」。
 */
import { Button, IconButton, Popover, PlusIcon, EllipsisIcon, TextInput, SelectInput } from "@woohaa3/frontend/extension-api";
import type { ShotImageReferences } from "./shot-image-reference.js";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import {
  clipConversionImpact,
  createMotionSnapshot,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  filmSetBackdropIsCustom,
  filmSetClipPrecondition,
  isFilmSetShotKind,
  readFilmSetBackdrop,
  shotPreviewNodeId,
  type FilmSetAnimationClip,
  type FilmSetClipPatchOp,
  type FilmSetShotKind
} from "@woohaa3/contracts";

/** 新建动态镜头的默认时长（秒；静态转动态的兜底值与之一致）。 */
const DEFAULT_DYNAMIC_DURATION = 5;

/** 自定义背景的合法六位 hex；非法时退回黑色（颜色输入始终是合法值）。 */
function customBackdropValid(value: string): string {
  return readFilmSetBackdrop(value).ok ? value.toLowerCase() : "#000000";
}

function kindLabel(kind: FilmSetShotKind): string {
  return kind === "static" ? "静态镜头" : "动态镜头";
}

export function FilmSetAnimationControls({ ctx, nodeId, writable, composition, compositionOpen, onCompositionOpenChange, images }: {
  ctx: Context; nodeId: string; writable: boolean; composition?: ReactNode;
  compositionOpen?: boolean; onCompositionOpenChange?: (open: boolean) => void;
  images?: ShotImageReferences;
}) {
  const [menu, setMenu] = useState<"create" | "more" | null>(null);
  useSyncExternalStore(ctx.compositeAssets.subscribe, ctx.compositeAssets.getRevision, ctx.compositeAssets.getRevision);
  const canvasState = useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  useSyncExternalStore(images?.subscribe ?? (() => () => {}), images?.revision ?? (() => 0), () => 0);
  useSyncExternalStore(ctx.modelWorkspace.session.subscribe, ctx.modelWorkspace.session.getState, ctx.modelWorkspace.session.getState);
  const [pendingKind, setPendingKind] = useState<FilmSetShotKind | null>(null);
  const [pendingDuration, setPendingDuration] = useState(DEFAULT_DYNAMIC_DURATION);
  /** 镜头背景：跟随主题 / 自定义颜色（D6）。 */
  const [customBackdrop, setCustomBackdrop] = useState("#000000");
  const canvas = canvasState;
  const decoded = decodeFilmSetNodeData(ctx.compositeAssets.projectCanvas(canvas)?.nodeData[nodeId]);
  const animation = decoded.ok ? decoded.value : null;
  const collection = animation ? filmSetAnimationsOf(animation) : null;
  // 选择是本地状态：优先当前本地选中，其次持久默认，最后第一枚镜头（都不写 defaultClipId）。
  const chosen = playback.nodeId === nodeId ? playback.clipId : null;
  const shot = collection?.clips.find(clip => clip.id === chosen) ?? collection?.clips.find(clip => clip.id === collection.defaultClipId) ?? collection?.clips[0];
  useEffect(() => {
    setPendingKind(null);
    setError(null);
    setMenu(null);
    setRenaming(false);
  }, [nodeId, shot?.id]);
  useEffect(() => {
    if (playback.nodeId !== nodeId || playback.clipId !== (shot?.id ?? null)) ctx.filmSetPlayback.select(nodeId, shot?.id ?? null);
  }, [nodeId, shot?.id, playback.nodeId, playback.clipId]);
  if (!animation || !collection) return <p role="alert">片场数据无法读取：{decoded.ok ? "定义缺失" : decoded.reason}</p>;

  const mutate = async (op: FilmSetClipPatchOp, id = shot?.id): Promise<boolean> => {
    if (!writable || !id) return false;
    setError(null);
    const result = ctx.canvasSession.submitCommands([{ type: "filmSet.clipPatch", nodeId, clipId: id, op, expectedHash: filmSetClipPrecondition(collection, id, op) }], `web-clip-${crypto.randomUUID()}`);
    if (!result.ok) { setError("拍摄镜头修改未提交，请检查连接和写入权限"); return false; }
    const outcome = await result.handle.settled;
    if (outcome.state === "rejected") { setError(outcome.error ?? "拍摄镜头修改被拒绝，请重新读取后重试"); return false; }
    return true;
  };

  // 新建镜头继承当前所选镜头的背景（D6）。
  const create = async (kind: FilmSetShotKind): Promise<void> => {
    const id = `clip-${crypto.randomUUID()}`;
    const duration = kind === "dynamic" ? DEFAULT_DYNAMIC_DURATION : 0;
    const camera = ctx.modelWorkspace.session.selectedCamera();
    const initialCamera = camera ? { ...ctx.modelWorkspace.session.effectivePose(camera), focusOffset: ctx.modelWorkspace.session.effectiveFocus(camera) } : animation.sceneCamera;
    const clip: FilmSetAnimationClip = {
      id,
      name: kind === "dynamic" ? "新动态镜头" : "新静态镜头",
      kind,
      timeline: { duration, loop: false },
      initialCamera,
      cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
      bindings: [],
      ...(shot?.backdrop ? { backdrop: shot.backdrop } : {})
    };
    if (await mutate({ kind: "create", clip }, id)) ctx.filmSetPlayback.select(nodeId, id);
  };

  const imageState = shot?.kind === "static" ? images?.state(nodeId, shot.id) : undefined;

  /**
   * 类型转换入口：显式呈现将清除的内容并要求确认（design D8/D9）。
   *
   * 静态→动态：用户给出合法正时长后转换，保留 clipId/构图/预览节点。
   * 动态→静态：含运镜/对象动作/时序时先展示影响清单，确认后才原子清除。
   */
  const requestConvert = (toKind: FilmSetShotKind): void => {
    if (!shot) return;
    if (toKind === "dynamic") { setPendingKind("dynamic"); setPendingDuration(shot.timeline.duration > 0 ? shot.timeline.duration : DEFAULT_DYNAMIC_DURATION); return; }
    const impact = clipConversionImpact(shot);
    if (impact.length === 0 && !canvas?.document.edges.some(edge => edge.source === shotPreviewNodeId(nodeId, shot.id))) { void mutate({ kind: "set-kind", toKind: "static", confirmClearContent: true }); return; }
    setPendingKind("static");
  };
  const confirmConvert = async (): Promise<void> => {
    if (!shot || !pendingKind) return;
    const toKind = pendingKind;
    const ok = toKind === "dynamic"
      ? await mutate({ kind: "set-kind", toKind, duration: pendingDuration })
      : await mutate({ kind: "set-kind", toKind, confirmClearContent: true });
    if (ok) setPendingKind(null);
  };

  const convertImpact = pendingKind === "static" && shot ? clipConversionImpact(shot) : [];
  const duplicate = () => shot && void mutate({ kind: "duplicate", newClipId: `clip-${crypto.randomUUID()}`, name: `${shot.name.slice(0, 76)} 副本` });
  const remove = () => shot && void mutate({ kind: "delete" });
  const setDefault = () => shot && void mutate({ kind: "set-default" });

  return <section className="film-set-animation-controls" aria-label="拍摄镜头管理">
    <div className="film-set-section-heading">
      <h3>拍摄镜头<span className="film-set-count">{collection.clips.length}</span></h3>
      <div className="film-set-shot-tools">
        <Popover open={menu === "create"} onOpenChange={open => setMenu(open ? "create" : null)} align="end" className="film-set-shot-menu"
          trigger={<IconButton label="新建拍摄镜头" size="sm" tone="ghost" disabled={!writable || collection.clips.length >= 32}><PlusIcon size={16} /></IconButton>}>
          <Button size="sm" tone="ghost" onClick={() => { setMenu(null); void create("static"); }}>新建静态镜头</Button>
          <Button size="sm" tone="ghost" onClick={() => { setMenu(null); void create("dynamic"); }}>新建动态镜头</Button>
        </Popover>
        <Popover open={menu === "more"} onOpenChange={open => setMenu(open ? "more" : null)} align="end" className="film-set-shot-menu"
          trigger={<IconButton label="拍摄镜头操作" size="sm" tone="ghost" disabled={!shot}><EllipsisIcon size={16} /></IconButton>}>
          <Button size="sm" tone="ghost" disabled={!writable} onClick={() => { setMenu(null); setRenaming(true); }}>重命名</Button>
          <Button size="sm" tone="ghost" disabled={!writable || collection.clips.length >= 32} onClick={() => { setMenu(null); duplicate(); }}>复制</Button>
          <Button size="sm" tone="ghost" disabled={!writable || collection.defaultClipId === shot?.id} onClick={() => { setMenu(null); setDefault(); }}>设为默认</Button>
          <Button size="sm" tone="ghost" disabled={!writable} onClick={() => { setMenu(null); requestConvert(shot?.kind === "dynamic" ? "static" : "dynamic"); }}>转为{shot?.kind === "dynamic" ? "静态" : "动态"}镜头</Button>
          <Button size="sm" tone="danger" disabled={!writable} onClick={() => { setMenu(null); remove(); }}>删除</Button>
        </Popover>
      </div>
    </div>
    {collection.clips.length === 0 ? <p className="film-set-object-list__empty">还没有拍摄镜头。新建静态镜头做固定构图，或新建动态镜头加入时长与动作。</p> : null}
    <div className="film-set-shot-picker"><SelectInput label="拍摄镜头" value={shot?.id ?? ""} onValueChange={value => { ctx.modelWorkspace.session.commitForCapture(); ctx.filmSetPlayback.select(nodeId, value); }}
      options={collection.clips.map((clip, index) => ({ value: clip.id, label: `${index + 1}. ${clip.name}${clip.id === collection.defaultClipId ? " · 默认" : ""}` }))} />
      {shot?.kind === "dynamic" ? <Button size="sm" aria-pressed={playback.preview} onClick={() => playback.preview ? ctx.filmSetPlayback.edit() : ctx.filmSetPlayback.preview()}>{playback.preview ? "返回编辑" : "动画预览"}</Button> : null}
    </div>
    {shot ? <>
      <p className="film-set-shot-kind">{kindLabel(shot.kind)} · {shot.kind === "static" ? "图片参考" : "视频参考"}</p>
      {renaming ? <label>名称<TextInput aria-label="拍摄镜头名称" key={shot.id + shot.name} defaultValue={shot.name} maxLength={80} disabled={!writable} onBlur={event => { if (event.target.value.trim() !== shot.name) void mutate({ kind: "rename", name: event.target.value }).then(ok => { if (ok) setRenaming(false); }); else setRenaming(false); }} /></label> : null}
      {shot.kind === "dynamic" ? <>
        <div className="film-set-shot-timing"><label>时长（秒）<TextInput key={shot.id + shot.timeline.duration} type="number" min={0} max={3600} step={0.1} defaultValue={shot.timeline.duration} disabled={!writable} onBlur={event => { const duration = Number(event.target.value); if (duration !== shot.timeline.duration) void mutate({ kind: "timeline", timeline: { ...shot.timeline, duration } }); }} /></label>
        <label><input type="checkbox" checked={shot.timeline.loop} disabled={!writable} onChange={event => void mutate({ kind: "timeline", timeline: { ...shot.timeline, loop: event.target.checked } })} />循环</label></div>
      </> : <p className="film-set-object-hint">静态镜头保持零时长。需要动作或运镜时转换为动态镜头。</p>}
      <div className="film-set-shot-backdrop">
        <label>背景<SelectInput label="镜头背景" value={filmSetBackdropIsCustom(shot) ? "custom" : "theme"} disabled={!writable}
          onValueChange={value => void mutate({ kind: "backdrop", backdrop: value === "theme" ? "theme" : customBackdropValid(customBackdrop) })}
          options={[{ value: "theme", label: "跟随主题" }, { value: "custom", label: "自定义颜色" }]} /></label>
        {filmSetBackdropIsCustom(shot) ? <input
          type="color"
          aria-label="镜头背景颜色"
          value={customBackdropValid(shot.backdrop ?? "#000000")}
          disabled={!writable}
          onChange={event => {
            const value = event.target.value;
            setCustomBackdrop(value);
            // 颜色选择器总是给出六位 hex；只接受合法值，非法不写。
            if (readFilmSetBackdrop(value).ok) void mutate({ kind: "backdrop", backdrop: value });
          }}
        /> : null}
      </div>
      <details className="film-set-composition" open={compositionOpen}>
        <summary onClick={onCompositionOpenChange ? event => {
          event.preventDefault();
          onCompositionOpenChange(!compositionOpen);
        } : undefined}>构图<span>{shot.initialCamera.aspect}</span></summary>
        <p className="film-set-object-hint">修改构图后自动保存，画布预览卡同步更新。</p>
        {composition}
      </details>
      {shot.kind === "static" ? <div className="film-set-image-reference">
        <p>{imageState?.status === "ready" ? "图片参考已更新" : imageState?.status === "failed" ? `图片参考更新失败：${imageState.error}` : "图片参考准备中 · 退出片场后自动更新"}</p>
        {imageState?.status === "ready" && imageState.error ? <p className="film-set-object-hint">{imageState.error}</p> : null}
        {imageState?.status === "failed" ? <Button size="sm" disabled={!writable} onClick={() => images?.retry(nodeId, shot.id)}>重试</Button> : null}
        {imageState?.status === "ready" ? <Button size="sm" onClick={() => void images?.download(nodeId, shot.id)}>下载图片参考</Button> : null}
      </div> : null}
    </> : null}
    {pendingKind ? <div className="film-set-conversion-confirm" role="group" aria-label="类型转换确认">
      <p className="film-set-object-hint">下游引用将同时切换为图片或视频角色，并清除旧冻结资产。不兼容的目标会阻止转换。</p>
      <p className="film-set-object-hint">{pendingKind === "static"
        ? `转为静态镜头将清除：${convertImpact.join("、") || "动作与时序"}。`
        : "转为动态镜头需要设置正时长；现有构图与名称保留。"}</p>
      {pendingKind === "dynamic" ? <label>时长（秒）<TextInput type="number" min={0} max={3600} step={0.1} value={pendingDuration} onChange={event => setPendingDuration(Number(event.target.value))} /></label> : null}
      <div className="film-set-animation-actions">
        <Button size="sm" tone="primary" disabled={!writable || (pendingKind === "dynamic" && !(pendingDuration > 0))} onClick={() => void confirmConvert()}>确认转换</Button>
        <Button size="sm" onClick={() => setPendingKind(null)}>取消</Button>
      </div>
    </div> : null}
    {error || playback.error ? <p role="alert">{error ?? playback.error}</p> : null}
  </section>;
}

/** 类型判别守卫的再导出，供测试与调用方复用同一事实源。 */
export { isFilmSetShotKind };
